import { beforeEach, describe, expect, it } from 'vitest';
import {
  ATTEMPT_WINDOW_SECONDS,
  LOCKOUT_SECONDS,
  MAX_FAILED_ATTEMPTS,
  SESSION_TTL_SECONDS,
  configuredAccessCode,
  constantTimeEquals,
  createSessionToken,
  evaluateLockout,
  isAuthEnabled,
  recordFailure,
  verifySessionToken,
  type AttemptState,
} from '@/server/auth';

const NOW = 1_800_000_000;

describe('configuration', () => {
  beforeEach(() => {
    delete process.env.APP_ACCESS_CODE;
  });

  it('is disabled when no code is set', () => {
    expect(configuredAccessCode()).toBeNull();
    expect(isAuthEnabled()).toBe(false);
  });

  it('treats a blank or whitespace code as unset rather than as a valid code', () => {
    process.env.APP_ACCESS_CODE = '   ';
    expect(configuredAccessCode()).toBeNull();
    expect(isAuthEnabled()).toBe(false);
  });

  it('is enabled when a code is set', () => {
    process.env.APP_ACCESS_CODE = '1029';
    expect(configuredAccessCode()).toBe('1029');
    expect(isAuthEnabled()).toBe(true);
  });
});

describe('constantTimeEquals', () => {
  it('matches identical strings', () => {
    expect(constantTimeEquals('1029', '1029')).toBe(true);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('rejects differences anywhere in the string', () => {
    expect(constantTimeEquals('1029', '2029')).toBe(false); // first character
    expect(constantTimeEquals('1029', '1028')).toBe(false); // last character
    expect(constantTimeEquals('1029', '1029 ')).toBe(false); // length
    expect(constantTimeEquals('1029', '')).toBe(false);
  });

  it('does not short-circuit on length', () => {
    // A prefix must not be accepted, and comparing very different lengths must
    // still return a result rather than throwing.
    expect(constantTimeEquals('10', '1029')).toBe(false);
    expect(constantTimeEquals('1029'.repeat(100), '1029')).toBe(false);
  });

  it('handles multi-byte characters without throwing', () => {
    expect(constantTimeEquals('café', 'café')).toBe(true);
    expect(constantTimeEquals('café', 'cafe')).toBe(false);
  });
});

describe('session tokens', () => {
  it('accepts a token it just issued', async () => {
    const token = await createSessionToken('1029', NOW);
    expect(await verifySessionToken(token, '1029', NOW)).toBe(true);
  });

  it('rejects a token signed under a different code', async () => {
    // Rotating the code must invalidate outstanding sessions immediately.
    const token = await createSessionToken('1029', NOW);
    expect(await verifySessionToken(token, '9999', NOW)).toBe(false);
  });

  it('rejects an expired token', async () => {
    const token = await createSessionToken('1029', NOW);
    expect(await verifySessionToken(token, '1029', NOW + SESSION_TTL_SECONDS - 1)).toBe(true);
    expect(await verifySessionToken(token, '1029', NOW + SESSION_TTL_SECONDS + 1)).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const token = await createSessionToken('1029', NOW);
    const [payload] = token.split('.');
    expect(await verifySessionToken(`${payload}.AAAA`, '1029', NOW)).toBe(false);
  });

  it('rejects a payload edited to extend the session', async () => {
    // Re-encoding the payload with a later expiry must not survive the signature
    // check — the expiry is inside the signed material.
    const token = await createSessionToken('1029', NOW);
    const signature = token.split('.')[1]!;
    const forged = Buffer.from(JSON.stringify({ exp: NOW + 999_999 }))
      .toString('base64url');
    expect(await verifySessionToken(`${forged}.${signature}`, '1029', NOW)).toBe(false);
  });

  it('rejects malformed and absent tokens', async () => {
    for (const token of [undefined, null, '', 'nonsense', 'a.b.c', '.']) {
      expect(await verifySessionToken(token, '1029', NOW)).toBe(false);
    }
  });
});

describe('lockout', () => {
  const state = (failed: number, first = NOW, locked: number | null = null): AttemptState => ({
    failedAttempts: failed,
    firstAttemptAt: first,
    lockedUntil: locked,
  });

  it('allows attempts with no history', () => {
    const decision = evaluateLockout(null, NOW);
    expect(decision.locked).toBe(false);
    expect(decision.attemptsRemaining).toBe(MAX_FAILED_ATTEMPTS);
  });

  it('counts down remaining attempts', () => {
    expect(evaluateLockout(state(1), NOW).attemptsRemaining).toBe(MAX_FAILED_ATTEMPTS - 1);
    expect(evaluateLockout(state(4), NOW).attemptsRemaining).toBe(1);
  });

  it('locks out after the maximum failures', () => {
    let current: AttemptState | null = null;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      current = recordFailure(current, NOW);
    }
    expect(current!.lockedUntil).toBe(NOW + LOCKOUT_SECONDS);
    expect(evaluateLockout(current, NOW).locked).toBe(true);
  });

  it('keeps the lockout closed until it expires, even for the right code', () => {
    const locked = state(MAX_FAILED_ATTEMPTS, NOW, NOW + LOCKOUT_SECONDS);
    expect(evaluateLockout(locked, NOW + 60).locked).toBe(true);
    expect(evaluateLockout(locked, NOW + LOCKOUT_SECONDS - 1).locked).toBe(true);
    expect(evaluateLockout(locked, NOW + LOCKOUT_SECONDS + 1).locked).toBe(false);
  });

  it('ages out old failures so occasional typos never accumulate', () => {
    const old = state(MAX_FAILED_ATTEMPTS - 1, NOW - ATTEMPT_WINDOW_SECONDS - 1);
    expect(evaluateLockout(old, NOW).attemptsRemaining).toBe(MAX_FAILED_ATTEMPTS);

    const next = recordFailure(old, NOW);
    expect(next.failedAttempts).toBe(1);
    expect(next.lockedUntil).toBeNull();
  });

  it('accumulates failures inside the window', () => {
    const recent = state(1, NOW - 60);
    const next = recordFailure(recent, NOW);
    expect(next.failedAttempts).toBe(2);
    expect(next.firstAttemptAt).toBe(NOW - 60);
  });
});
