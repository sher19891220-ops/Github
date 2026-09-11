/**
 * The user table, and the checks that need a database.
 *
 * The middleware verifies a cookie; this verifies the account behind it.
 * The split is a consequence of where each can run — Edge has Web Crypto
 * and no database driver — and it is also the right split: a signature
 * proves the token was issued by us, and only the database knows whether
 * the person it was issued to still works here.
 */
import { query } from '@/db/pool';
import { hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password';
import type { Role } from '@/lib/auth/roles';

export interface AppUser {
  userId: string;
  username: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  sessionEpoch: number;
}

export type AuthOutcome = 'success' | 'bad_password' | 'unknown_user' | 'inactive' | 'locked';

interface UserRow {
  user_id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  session_epoch: number;
}

/** How many failures in the window before an account stops answering. */
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_WINDOW_MINUTES = 15;

export async function recordAuthEvent(
  username: string,
  outcome: AuthOutcome,
  meta: { ip?: string | undefined; userAgent?: string | undefined } = {},
): Promise<void> {
  await query(
    `INSERT INTO accounting.auth_event (username, outcome, ip, user_agent) VALUES ($1, $2, $3, $4)`,
    [username.toLowerCase(), outcome, meta.ip ?? null, meta.userAgent ?? null],
  );
}

/**
 * Signs a user in, or says why not.
 *
 * The unknown-user path still runs a password verification against a
 * throwaway hash. Without it, a wrong username returns noticeably faster
 * than a wrong password, and that difference is a free list of who has an
 * account here.
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function authenticate(
  usernameRaw: string,
  password: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined } = {},
): Promise<{ outcome: AuthOutcome; user?: AppUser }> {
  const username = usernameRaw.trim().toLowerCase();

  const recent = await query<{ n: string }>(
    `SELECT count(*) AS n FROM accounting.auth_event
      WHERE username = $1 AND outcome IN ('bad_password','unknown_user')
        AND at > now() - ($2 || ' minutes')::interval`,
    [username, String(LOCKOUT_WINDOW_MINUTES)],
  );
  if (Number(recent[0]?.n ?? 0) >= LOCKOUT_THRESHOLD) {
    await recordAuthEvent(username, 'locked', meta);
    return { outcome: 'locked' };
  }

  const rows = await query<UserRow>(
    `SELECT user_id, username, display_name, password_hash, role, is_active, must_change_password, session_epoch
       FROM accounting.app_user WHERE username = $1`,
    [username],
  );
  const row = rows[0];

  if (!row) {
    await verifyPassword(password, DUMMY_HASH);
    await recordAuthEvent(username, 'unknown_user', meta);
    return { outcome: 'unknown_user' };
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    await recordAuthEvent(username, 'bad_password', meta);
    return { outcome: 'bad_password' };
  }

  // Checked AFTER the password, on purpose. Answering "inactive" to a
  // wrong password tells whoever is guessing that the username is real.
  if (!row.is_active) {
    await recordAuthEvent(username, 'inactive', meta);
    return { outcome: 'inactive' };
  }

  // The password was right, so it can be re-hashed at current cost
  // without anyone being asked to do anything.
  if (needsRehash(row.password_hash)) {
    await query(`UPDATE accounting.app_user SET password_hash = $2 WHERE user_id = $1`, [
      row.user_id,
      await hashPassword(password),
    ]);
  }

  await query(`UPDATE accounting.app_user SET last_login_at = now() WHERE user_id = $1`, [row.user_id]);
  await recordAuthEvent(username, 'success', meta);

  return { outcome: 'success', user: toUser(row) };
}

/**
 * Re-checks the account behind a verified session.
 *
 * Called by route handlers on every request that matters. The epoch check
 * is what makes revocation immediate: a password change or an
 * administrator disabling an account bumps it, and every cookie issued
 * under the old one stops working on its next use.
 */
export async function userForSession(userId: string, epoch: number): Promise<AppUser | null> {
  const rows = await query<UserRow>(
    `SELECT user_id, username, display_name, password_hash, role, is_active, must_change_password, session_epoch
       FROM accounting.app_user WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row || !row.is_active || row.session_epoch !== epoch) return null;
  return toUser(row);
}

export async function changePassword(userId: string, current: string, next: string): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const rows = await query<UserRow>(
    `SELECT user_id, username, display_name, password_hash, role, is_active, must_change_password, session_epoch
       FROM accounting.app_user WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'No such user.' };
  if (!(await verifyPassword(current, row.password_hash))) {
    return { ok: false, reason: 'The current password is not right.' };
  }
  if (next.length < 12) return { ok: false, reason: 'The new password must be at least 12 characters.' };
  if (next === current) return { ok: false, reason: 'The new password must be different from the current one.' };

  // Bumping the epoch signs out every other session this user has. That is
  // the point of changing a password after it has been shared.
  await query(
    `UPDATE accounting.app_user
        SET password_hash = $2, must_change_password = false, session_epoch = session_epoch + 1
      WHERE user_id = $1`,
    [userId, await hashPassword(next)],
  );
  return { ok: true };
}

export async function listUsers(): Promise<AppUser[]> {
  const rows = await query<UserRow>(
    `SELECT user_id, username, display_name, password_hash, role, is_active, must_change_password, session_epoch
       FROM accounting.app_user ORDER BY username`,
  );
  return rows.map(toUser);
}

/** Creates or resets a department account. Returns nothing about the
 *  password: the caller generated it and is the only thing that ever
 *  holds it. */
export async function upsertUser(input: {
  username: string;
  displayName: string;
  role: Role;
  passwordHash: string;
}): Promise<void> {
  await query(
    `INSERT INTO accounting.app_user (username, display_name, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (username) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            password_hash = EXCLUDED.password_hash,
            role = EXCLUDED.role,
            must_change_password = true,
            is_active = true,
            session_epoch = accounting.app_user.session_epoch + 1`,
    [input.username.toLowerCase(), input.displayName, input.passwordHash, input.role],
  );
}

function toUser(row: UserRow): AppUser {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    sessionEpoch: row.session_epoch,
  };
}
