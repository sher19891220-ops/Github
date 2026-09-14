/**
 * Who can see and do what.
 *
 * **Enforced at the API, never by hiding a link.** A nav item that is not
 * rendered is a suggestion; the route behind it is the actual control. The
 * matrix below is used by the middleware for pages *and* for
 * `/api/*` requests, and the method matters: several roles can read a
 * figure they must not be able to change.
 */

export type Role = 'admin' | 'accounting' | 'safety' | 'dispatch' | 'executive';

export const ROLES: readonly Role[] = ['admin', 'accounting', 'safety', 'dispatch', 'executive'];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Route prefixes each role may READ. `*` means everything. */
const READ: Record<Role, readonly string[]> = {
  admin: ['*'],
  accounting: [
    '/', '/documents', '/review', '/add', '/sheets', '/pnl', '/ifta', '/overhead',
    '/reconciliation', '/chargeback', '/fleet',
    '/api/dashboard', '/api/documents', '/api/staging', '/api/ledger', '/api/manual',
    '/api/entries', '/api/reference', '/api/pnl', '/api/ifta', '/api/registration',
    '/api/reconciliation', '/api/chargeback', '/api/sheet-sources', '/api/sheet-sync',
    '/api/truck-status',
  ],
  safety: [
    '/', '/fleet', '/ifta', '/documents', '/review',
    '/api/dashboard', '/api/fleet', '/api/truck-status', '/api/ifta', '/api/documents',
    '/api/staging', '/api/reference',
  ],
  dispatch: [
    '/', '/fleet',
    '/api/dashboard', '/api/truck-status', '/api/reference',
  ],
  executive: [
    '/', '/ceo', '/pnl', '/overhead', '/ifta',
    '/api/dashboard', '/api/ceo', '/api/pnl', '/api/registration', '/api/ifta', '/api/reference',
  ],
};

/**
 * Route prefixes each role may WRITE (POST/PATCH/PUT/DELETE).
 *
 * Deliberately narrower than READ for every role but admin. Executive is
 * read-only everywhere: a CEO view exists to be looked at, and an
 * accidental write from it would land in the ledger with a real person's
 * name on it. Dispatch can set a truck's status and nothing else.
 */
const WRITE: Record<Role, readonly string[]> = {
  admin: ['*'],
  accounting: [
    '/api/documents', '/api/staging', '/api/manual', '/api/entries', '/api/ifta',
    '/api/reconciliation', '/api/chargeback', '/api/sheet-sources', '/api/sheet-sync',
    '/api/truck-status',
  ],
  safety: ['/api/documents', '/api/staging', '/api/truck-status', '/api/ifta/rates'],
  dispatch: ['/api/truck-status'],
  executive: [],
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Longest-prefix match, so `/api/ifta/rates` can be granted without
 *  granting `/api/ifta`'s POST (which saves a return). */
function matches(prefixes: readonly string[], pathname: string): boolean {
  if (prefixes.includes('*')) return true;
  for (const p of prefixes) {
    if (p === '/') {
      if (pathname === '/') return true;
      continue;
    }
    if (pathname === p || pathname.startsWith(`${p}/`)) return true;
  }
  return false;
}

export function canAccess(role: Role, pathname: string, method: string): boolean {
  const isWrite = WRITE_METHODS.has(method.toUpperCase());
  if (isWrite) return matches(WRITE[role], pathname);
  return matches(READ[role], pathname);
}

/** The screens a role may open, for rendering the nav. Not a security
 *  boundary — `canAccess` is — but the nav should not offer a door that
 *  is locked. */
export function visibleScreens(role: Role): readonly string[] {
  const all = ['/', '/documents', '/review', '/add', '/sheets', '/fleet', '/ceo', '/pnl', '/ifta', '/overhead', '/reconciliation', '/chargeback'];
  return all.filter((p) => canAccess(role, p, 'GET'));
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator — everything, including user management',
  accounting: 'Accounting — documents, ledger, P&L, IFTA, reconciliation, chargeback',
  safety: 'Safety — fleet status, IFTA mileage, document upload',
  dispatch: 'Dispatch — fleet status board',
  executive: 'Executive — group roll-up and P&L, read-only',
};
