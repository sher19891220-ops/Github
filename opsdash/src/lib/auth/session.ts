/**
 * The session cookie.
 *
 * A signed token, not an opaque id in a table. The trade is deliberate:
 * no database round-trip on a page load, at the cost of not being able to
 * revoke a single token directly. That cost is paid back by
 * `session_epoch` — every token carries the epoch it was issued under, and
 * bumping a user's epoch invalidates all of their outstanding tokens at
 * once. A password change and an administrator removing access both do
 * that, which covers the cases revocation actually exists for.
 *
 * Signed with HMAC-SHA256 via Web Crypto, so the same code runs in Next's
 * Edge middleware and in Node route handlers. Nothing here is encrypted —
 * the payload is not secret, it is only required to be unforgeable — and
 * the signature is compared in constant time.
 */

export interface SessionPayload {
  userId: string;
  username: string;
  role: string;
  epoch: number;
  /** Seconds since epoch. */
  exp: number;
  mustChangePassword: boolean;
}

export const SESSION_COOKIE = 'opsdash_session';
/** Eight hours: a working day. Long enough not to interrupt, short enough
 *  that a laptop left open overnight is not an open door in the morning. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/**
 * Verifies and decodes a token. Returns null for anything wrong — a bad
 * signature, a tampered body, an expired token, a malformed string.
 *
 * One return value for every failure on purpose: a caller that can tell
 * "expired" from "forged" will eventually branch on it, and the only safe
 * branch is the same for both.
 */
export async function verifySession(token: string, secret: string): Promise<SessionPayload | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      await key(secret),
      fromB64url(sig),
      new TextEncoder().encode(body),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SessionPayload;
  } catch {
    return null;
  }

  if (
    typeof payload.userId !== 'string' ||
    typeof payload.username !== 'string' ||
    typeof payload.role !== 'string' ||
    typeof payload.epoch !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  if (payload.exp * 1000 <= Date.now()) return null;

  return payload;
}

/**
 * The signing secret.
 *
 * Throws when unset in production rather than falling back to a default.
 * A hardcoded development fallback that reaches production means every
 * deployment of this code shares one key, and anyone who has read the
 * source can mint a valid admin session.
 */
export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_SECRET is not set, or is shorter than 32 characters. Refusing to sign sessions with a weak or shared key.',
    );
  }
  return 'development-only-secret-do-not-use-in-production-0000';
}
