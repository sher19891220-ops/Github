import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isAuthorized, safeEqual, verifySamsaraSignature } from '../src/security';

const SECRET = 'super-secret';
const BODY = '{"eventId":"abc","eventType":"Alert"}';

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload, 'utf8').digest('hex');
}

describe('safeEqual', () => {
  it('compares without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('verifySamsaraSignature', () => {
  const now = Date.parse('2026-08-17T15:00:00Z');
  const timestamp = String(now);

  it('accepts the versioned v1:timestamp:body scheme', () => {
    const signature = `v1=${sign(`v1:${timestamp}:${BODY}`)}`;
    expect(verifySamsaraSignature(BODY, signature, timestamp, SECRET, { now }).valid).toBe(true);
  });

  it('accepts a bare body signature', () => {
    expect(verifySamsaraSignature(BODY, sign(BODY), undefined, SECRET, { now }).valid).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = `v1=${sign(`v1:${timestamp}:${BODY}`)}`;
    const result = verifySamsaraSignature(`${BODY} `, signature, timestamp, SECRET, { now });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature mismatch');
  });

  it('rejects a replayed timestamp', () => {
    const old = String(now - 10 * 60 * 1000);
    const signature = `v1=${sign(`v1:${old}:${BODY}`)}`;
    const result = verifySamsaraSignature(BODY, signature, old, SECRET, { now });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp outside tolerance');
  });

  it('accepts second-precision timestamps', () => {
    const seconds = String(Math.floor(now / 1000));
    const signature = `v1=${sign(`v1:${seconds}:${BODY}`)}`;
    expect(verifySamsaraSignature(BODY, signature, seconds, SECRET, { now }).valid).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(verifySamsaraSignature(BODY, undefined, timestamp, SECRET, { now }).valid).toBe(false);
  });
});

describe('isAuthorized', () => {
  it('is open when no secrets are configured', () => {
    expect(isAuthorized({}, {})).toBe(true);
  });

  it('accepts the Vercel cron bearer token', () => {
    expect(
      isAuthorized({ authorizationHeader: 'Bearer cron-token' }, { cronSecret: 'cron-token' }),
    ).toBe(true);
  });

  it('accepts the admin secret as a query parameter', () => {
    expect(isAuthorized({ querySecret: 'admin' }, { adminSecret: 'admin' })).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(isAuthorized({ querySecret: 'nope' }, { adminSecret: 'admin' })).toBe(false);
    expect(isAuthorized({}, { cronSecret: 'cron-token' })).toBe(false);
  });
});
