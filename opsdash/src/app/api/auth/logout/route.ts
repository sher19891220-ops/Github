/** POST /api/auth/logout — clears the cookie. */
import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/session';

export function POST(): Response {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
