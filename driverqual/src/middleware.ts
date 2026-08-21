import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/server/auth';

/**
 * Gates every page and API route behind the access code.
 *
 * This runs before any route handler or server component, so there is no page
 * that can forget to check. When no code is configured the application stays
 * open — local development and the test suite depend on that — and the layout
 * shows a standing warning instead.
 */

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/health'];

export async function middleware(request: NextRequest) {
  const code = process.env.APP_ACCESS_CODE?.trim();
  if (!code) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token, code)) return NextResponse.next();

  // An API caller gets a status it can act on; a browser gets the login page.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Not signed in. Enter the access code to continue.' },
      { status: 401 },
    );
  }

  const login = new URL('/login', request.url);
  // Remember where they were headed so the code entry returns them there.
  if (pathname !== '/') login.searchParams.set('next', pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
