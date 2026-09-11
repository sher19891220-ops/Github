/**
 * POST /api/auth/change-password
 *
 * Reachable while `mustChangePassword` is set — it is the one thing such
 * an account may do. A successful change bumps the user's session epoch,
 * which signs out every other session they have, including any opened
 * with the shared initial password.
 */
import { NextResponse } from 'next/server';
import { changePassword, userForSession } from '@/db/repo/users';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionSecret,
  signSession,
  verifySession,
} from '@/lib/auth/session';

export async function POST(request: Request): Promise<Response> {
  const token = request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  const session = token ? await verifySession(decodeURIComponent(token), sessionSecret()) : null;
  if (session === null) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const next = typeof body.newPassword === 'string' ? body.newPassword : '';

  const result = await changePassword(session.userId, current, next);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 });

  // The old cookie carries the old epoch and is now dead. Issue a fresh
  // one so the person is not bounced to the login screen for succeeding.
  const user = await userForSession(session.userId, session.epoch + 1);
  if (!user) return NextResponse.json({ ok: true, signedOut: true });

  const fresh = await signSession(
    {
      userId: user.userId,
      username: user.username,
      role: user.role,
      epoch: user.sessionEpoch,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      mustChangePassword: false,
    },
    sessionSecret(),
  );

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, fresh, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
