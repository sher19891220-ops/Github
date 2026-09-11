/**
 * The access control boundary.
 *
 * Every page and every `/api` route passes through here. That is the
 * point: authorisation applied route by route is authorisation somebody
 * forgets on the next route, and the one they forget is the one that
 * matters. A new endpoint is protected by default and has to be *added*
 * to the public list to be reachable.
 *
 * What happens here and what deliberately does not:
 *
 *  - **Here:** the cookie's signature and expiry, and the role check
 *    against the requested path and method. All of it runs on the Edge
 *    runtime, which has Web Crypto but no database driver.
 *  - **Not here:** whether the account is still active. That needs the
 *    database, so it happens in `requireUser` inside route handlers. The
 *    two together mean a disabled account stops working on its next
 *    request rather than when its cookie expires.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, sessionSecret, verifySession } from '@/lib/auth/session';
import { canAccess, isRole } from '@/lib/auth/roles';

/** Reachable without a session. Kept to the minimum that has to be. */
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/health'];

/**
 * Reachable by any signed-in user, whatever their role.
 *
 * These are things a person does to their own account, not to the
 * business's data, so running them through the role matrix is a category
 * error — and it bites immediately: `dispatch` has no write permission on
 * `/api/auth/*`, so a dispatcher forced to change their password was
 * refused permission to change it. Locked out by the mechanism meant to
 * let them in.
 */
const SELF_SERVICE_PATHS = ['/api/auth/change-password', '/api/auth/logout', '/change-password'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isSelfService(pathname: string): boolean {
  return SELF_SERVICE_PATHS.includes(pathname);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token, sessionSecret()) : null;

  if (session === null) {
    // An API caller gets a status it can act on; a browser gets sent to
    // the login page. Redirecting an API call to HTML is how a fetch()
    // ends up reporting a JSON parse error instead of "signed out".
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  // A password that arrived over chat or a phone call works exactly once.
  // Until it is replaced, every route but the change-password one is shut
  // — including the API, so this cannot be stepped around with a fetch.
  if (session.mustChangePassword && pathname !== '/change-password' && pathname !== '/api/auth/change-password') {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'This account must set a new password before it can be used.' },
        { status: 403 },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = '/change-password';
    url.search = '';
    return NextResponse.redirect(url);
  }

  // Managing your own account is not a business permission.
  if (isSelfService(pathname)) return NextResponse.next();

  if (!isRole(session.role)) {
    return NextResponse.json({ error: 'Unknown role.' }, { status: 403 });
  }

  if (!canAccess(session.role, pathname, request.method)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: `Your role (${session.role}) cannot ${request.method} ${pathname}.` },
        { status: 403 },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '?denied=1';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's own static output. Note what is NOT excluded:
  // /api. An auth matcher that skips API routes protects the pictures and
  // leaves the data open.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
