/**
 * The authentication primitives.
 *
 * This is the code where a mistake is silent and total, so the tests are
 * mostly about the failure paths: a tampered token, a wrong password, a
 * role reaching past its screens. A green suite here does not make the
 * system secure, but each of these going red would make it insecure in a
 * specific, describable way.
 */
import { describe, expect, it } from 'vitest';
import { generatePassword, hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password';
import { signSession, verifySession, type SessionPayload } from '@/lib/auth/session';
import { canAccess, isRole, visibleScreens, ROLES } from '@/lib/auth/roles';

const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';

function payload(over: Partial<SessionPayload> = {}): SessionPayload {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    username: 'accounting',
    role: 'accounting',
    epoch: 1,
    exp: Math.floor(Date.now() / 1000) + 3600,
    mustChangePassword: false,
    ...over,
  };
}

describe('password hashing', () => {
  it('round-trips a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
    expect(await verifyPassword('correct-horse-batterY', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  }, 20000);

  it('salts, so the same password twice gives different hashes', async () => {
    // Without a per-password salt, one precomputation attacks every user
    // who chose the same password.
    const a = await hashPassword('the-same-password-x');
    const b = await hashPassword('the-same-password-x');
    expect(a).not.toBe(b);
    expect(await verifyPassword('the-same-password-x', a)).toBe(true);
    expect(await verifyPassword('the-same-password-x', b)).toBe(true);
  }, 20000);

  it('carries its parameters, so cost can be raised later', async () => {
    const hash = await hashPassword('a-password-here-ok');
    expect(hash.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(needsRehash(hash)).toBe(false);
    // A hash made at lower cost is flagged for upgrade on next use.
    expect(needsRehash('scrypt$16384$8$1$AAAA$BBBB')).toBe(true);
  }, 20000);

  it('refuses a short password rather than storing a weak hash', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/);
  });

  it('returns false, never throws, on a malformed or tampered hash', async () => {
    // A corrupt row must not become an exception a caller might treat as
    // "allow".
    for (const bad of ['', 'nonsense', 'scrypt$x$8$1$AA$BB', 'bcrypt$2a$10$abc', 'scrypt$32768$8$1$$']) {
      expect(await verifyPassword('anything', bad), bad).toBe(false);
    }
  });

  it('refuses absurd parameters instead of trying to honour them', async () => {
    // A tampered row could otherwise ask for gigabytes of memory.
    expect(await verifyPassword('x', 'scrypt$999999999$99$99$AAAA$BBBB')).toBe(false);
  });
});

describe('generatePassword', () => {
  it('avoids characters that are misread when read aloud', () => {
    for (let i = 0; i < 50; i += 1) {
      // These get handed over by phone whatever the policy says.
      expect(generatePassword()).not.toMatch(/[o0l1i]/);
    }
  });

  it('produces something long enough to be accepted by the hasher', async () => {
    const p = generatePassword();
    expect(p.length).toBeGreaterThanOrEqual(12);
    await expect(hashPassword(p)).resolves.toContain('scrypt$');
  }, 20000);

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(seen.size).toBe(200);
  });
});

describe('session tokens', () => {
  it('round-trips a payload', async () => {
    const token = await signSession(payload(), SECRET);
    const back = await verifySession(token, SECRET);
    expect(back).toMatchObject({ username: 'accounting', role: 'accounting', epoch: 1 });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession(payload(), SECRET);
    expect(await verifySession(token, 'another-secret-at-least-32-characters!!')).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    // The whole point: escalating your own role by editing the cookie.
    const token = await signSession(payload({ role: 'dispatch' }), SECRET);
    const [body, sig] = token.split('.');
    const decoded = JSON.parse(atob(body!.replace(/-/g, '+').replace(/_/g, '/'))) as SessionPayload;
    decoded.role = 'admin';
    const forgedBody = btoa(JSON.stringify(decoded)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifySession(`${forgedBody}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signSession(payload({ exp: Math.floor(Date.now() / 1000) - 1 }), SECRET);
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it('rejects garbage without throwing', async () => {
    for (const bad of ['', '.', 'no-dot', 'a.b', '....']) {
      expect(await verifySession(bad, SECRET), bad).toBeNull();
    }
  });
});

describe('role permissions', () => {
  it('lets accounting read and write the financial screens', () => {
    expect(canAccess('accounting', '/pnl', 'GET')).toBe(true);
    expect(canAccess('accounting', '/api/documents', 'POST')).toBe(true);
    expect(canAccess('accounting', '/api/ifta', 'POST')).toBe(true);
  });

  it('keeps the executive view read-only', () => {
    // A CEO screen exists to be looked at. An accidental write from it
    // would land in the ledger with a real person's name on it.
    expect(canAccess('executive', '/api/ceo', 'GET')).toBe(true);
    expect(canAccess('executive', '/api/pnl', 'GET')).toBe(true);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(canAccess('executive', '/api/documents', method), method).toBe(false);
      expect(canAccess('executive', '/api/manual', method), method).toBe(false);
    }
  });

  it('does not let dispatch read the ledger or the P&L', () => {
    expect(canAccess('dispatch', '/fleet', 'GET')).toBe(true);
    expect(canAccess('dispatch', '/api/truck-status', 'POST')).toBe(true);
    expect(canAccess('dispatch', '/pnl', 'GET')).toBe(false);
    expect(canAccess('dispatch', '/api/ledger', 'GET')).toBe(false);
    expect(canAccess('dispatch', '/api/pnl', 'GET')).toBe(false);
  });

  it('lets safety enter IFTA rates but not save a return', () => {
    // Longest-prefix matching is what makes this expressible: the rate
    // table is safety's to maintain; filing the return is accounting's.
    expect(canAccess('safety', '/api/ifta/rates', 'POST')).toBe(true);
    expect(canAccess('safety', '/api/ifta', 'POST')).toBe(false);
  });

  it('keeps the group roll-up away from every role but admin and executive', () => {
    expect(canAccess('admin', '/ceo', 'GET')).toBe(true);
    expect(canAccess('executive', '/ceo', 'GET')).toBe(true);
    expect(canAccess('accounting', '/ceo', 'GET')).toBe(false);
    expect(canAccess('safety', '/ceo', 'GET')).toBe(false);
    expect(canAccess('dispatch', '/ceo', 'GET')).toBe(false);
  });

  it('does not let a prefix match a longer sibling path by accident', () => {
    // `/api/ifta` must not grant `/api/iftaSOMETHING`.
    expect(canAccess('executive', '/api/pnlx', 'GET')).toBe(false);
    expect(canAccess('dispatch', '/fleetwide', 'GET')).toBe(false);
  });

  it('grants the root path exactly, not everything under it', () => {
    expect(canAccess('dispatch', '/', 'GET')).toBe(true);
    expect(canAccess('dispatch', '/chargeback', 'GET')).toBe(false);
  });

  it('admin can do everything', () => {
    for (const path of ['/ceo', '/api/manual', '/api/ifta', '/chargeback']) {
      expect(canAccess('admin', path, 'GET'), path).toBe(true);
      expect(canAccess('admin', path, 'POST'), path).toBe(true);
    }
  });

  it('every role gets at least one screen, and none gets one it cannot open', () => {
    for (const role of ROLES) {
      const screens = visibleScreens(role);
      expect(screens.length, role).toBeGreaterThan(0);
      for (const s of screens) expect(canAccess(role, s, 'GET'), `${role} ${s}`).toBe(true);
    }
  });

  it('rejects a role name that is not one of ours', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('superuser')).toBe(false);
    expect(isRole('')).toBe(false);
  });
});
