import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { nowIso } from '@/db/ids';
import { recordAudit } from '@/db/repo';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  configuredAccessCode,
  constantTimeEquals,
  createSessionToken,
  evaluateLockout,
  recordFailure,
  type AttemptState,
} from '@/server/auth';

export const dynamic = 'force-dynamic';

/**
 * The caller's address, used only to scope lockouts.
 *
 * Behind a proxy the socket address is the proxy's, so the forwarded header is
 * used when present. It is client-controlled and therefore spoofable, which
 * limits lockout to slowing an honest attacker rather than stopping a
 * determined one — the reason the code length itself still matters.
 */
function callerAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

async function loadAttempts(
  db: Awaited<ReturnType<typeof getDb>>,
  address: string,
): Promise<AttemptState | null> {
  const row = await db.get<Record<string, unknown>>(
    `SELECT failed_attempts, first_attempt_at, locked_until FROM auth_attempts WHERE address = ?`,
    [address],
  );
  if (!row) return null;
  return {
    failedAttempts: Number(row['failed_attempts']),
    firstAttemptAt: Number(row['first_attempt_at']),
    lockedUntil: row['locked_until'] === null ? null : Number(row['locked_until']),
  };
}

export async function POST(request: Request) {
  const code = configuredAccessCode();
  if (!code) {
    return NextResponse.json(
      { error: 'No access code is configured on this server.' },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => null);
  const submitted = typeof body?.code === 'string' ? body.code.trim() : '';
  const address = callerAddress(request);
  const now = Math.floor(Date.now() / 1000);

  const db = await getDb();
  const attempts = await loadAttempts(db, address);
  const lockout = evaluateLockout(attempts, now);

  if (lockout.locked) {
    const minutes = Math.ceil(lockout.retryAfterSeconds / 60);
    return NextResponse.json(
      {
        error: `Too many incorrect codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        retryAfterSeconds: lockout.retryAfterSeconds,
      },
      { status: 429 },
    );
  }

  if (!submitted || !constantTimeEquals(submitted, code)) {
    const next = recordFailure(attempts, now);
    await db.run(
      `INSERT INTO auth_attempts (address, failed_attempts, first_attempt_at, locked_until, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         failed_attempts = excluded.failed_attempts,
         first_attempt_at = excluded.first_attempt_at,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`,
      [address, next.failedAttempts, next.firstAttemptAt, next.lockedUntil, nowIso()],
    );
    // The code itself is never written to the audit trail.
    await recordAudit(db, {
      actor: address,
      action: 'auth.failed',
      entityType: 'session',
      entityId: address,
      detail: { failedAttempts: next.failedAttempts },
    });

    const remaining = Math.max(0, evaluateLockout(next, now).attemptsRemaining);
    return NextResponse.json(
      {
        error: next.lockedUntil
          ? 'Too many incorrect codes. This device is locked out for 15 minutes.'
          : `Incorrect access code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before a 15 minute lockout.`,
      },
      { status: 401 },
    );
  }

  await db.run(`DELETE FROM auth_attempts WHERE address = ?`, [address]);
  await recordAudit(db, {
    actor: address,
    action: 'auth.signed_in',
    entityType: 'session',
    entityId: address,
  });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(code), {
    httpOnly: true, // unreadable from JavaScript, so an injected script cannot lift it
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return response;
}
