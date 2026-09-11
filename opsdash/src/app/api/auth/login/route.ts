/**
 * POST /api/auth/login — the only public write endpoint.
 *
 * Every failure returns the same message and the same status. "No such
 * user" and "wrong password" told apart is a way to enumerate who works
 * here, and an account that says "disabled" confirms the username was
 * real. The reason is recorded in `auth_event` where an administrator can
 * see it; the caller is told one thing.
 */
import { NextResponse } from 'next/server';
import { authenticate } from '@/db/repo/users';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, sessionSecret, signSession } from '@/lib/auth/session';

const GENERIC = 'That username and password combination was not recognised.';

export async function POST(request: Request): Promise<Response> {
  let body: { username?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (username === '' || password === '') {
    return NextResponse.json({ error: GENERIC }, { status: 401 });
  }

  const meta = {
    ip:
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      undefined,
    userAgent: request.headers.get('user-agent') ?? undefined,
  };

  const result = await authenticate(username, password, meta);
  if (result.outcome !== 'success' || !result.user) {
    // Locked is the one case worth distinguishing: the person is probably
    // the real user mistyping, and telling them to wait is more useful
    // than letting them keep trying against a wall.
    const message =
      result.outcome === 'locked'
        ? 'Too many failed attempts. Wait 15 minutes and try again.'
        : GENERIC;
    return NextResponse.json({ error: message }, { status: 401 });
  }

  const user = result.user;
  const token = await signSession(
    {
      userId: user.userId,
      username: user.username,
      role: user.role,
      epoch: user.sessionEpoch,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      mustChangePassword: user.mustChangePassword,
    },
    sessionSecret(),
  );

  const res = NextResponse.json({
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, // unreadable from JavaScript, so an XSS cannot lift it
    sameSite: 'lax', // not sent on cross-site POSTs, which is CSRF cover
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
