/**
 * Access-code authentication.
 *
 * One shared code gates the whole application. That is a deliberate trade for a
 * small safety department, not a claim of strong security — see the notes on
 * code length in `docs/USER-GUIDE.md`. What this module does provide:
 *
 *  - the code is compared in constant time, so response timing leaks nothing;
 *  - the session cookie is signed, so it cannot be forged or extended;
 *  - the signing key is derived from the code, so changing the code immediately
 *    invalidates every session issued under the old one;
 *  - failed attempts are counted and locked out, which is what actually stands
 *    between a short code and an exhaustive search.
 *
 * Everything here uses Web Crypto rather than `node:crypto` so the same code
 * runs in middleware (edge runtime) and in route handlers (node runtime).
 */

export const SESSION_COOKIE = 'driverqual_session';

/** How long a session lasts before the code must be entered again. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Failed attempts from one address before it is locked out. */
export const MAX_FAILED_ATTEMPTS = 5;

/** How long a lockout lasts. */
export const LOCKOUT_SECONDS = 15 * 60;

/** Attempts older than this no longer count toward a lockout. */
export const ATTEMPT_WINDOW_SECONDS = 15 * 60;

/** The configured code, or null when the app is running unprotected. */
export function configuredAccessCode(): string | null {
  const code = process.env.APP_ACCESS_CODE?.trim();
  return code ? code : null;
}

export function isAuthEnabled(): boolean {
  return configuredAccessCode() !== null;
}

/* ------------------------------------------------------------------ *
 * Constant-time comparison
 * ------------------------------------------------------------------ */

/**
 * Compares two strings without short-circuiting on the first difference.
 *
 * Length is folded into the result rather than returned early, so a wrong code
 * takes the same time whether it differs in the first character or the last.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);

  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

/* ------------------------------------------------------------------ *
 * Session tokens
 * ------------------------------------------------------------------ */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derives the signing key from the access code and an optional server secret.
 *
 * Because the code is part of the key, rotating the code revokes every session
 * that was issued under the previous one — no separate revocation step, and no
 * window where an old cookie still works.
 */
async function signingKey(code: string): Promise<CryptoKey> {
  const material = `driverqual.v1:${process.env.SESSION_SECRET ?? ''}:${code}`;
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(material),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

interface SessionPayload {
  /** Expiry, epoch seconds. */
  exp: number;
}

export async function createSessionToken(
  code: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: SessionPayload = { exp: nowSeconds + SESSION_TTL_SECONDS };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(code),
    new TextEncoder().encode(encoded),
  );
  return `${encoded}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verifies a session token against the current code.
 *
 * The signature is checked before the payload is trusted, and the expiry is
 * inside the signed payload, so a client cannot extend its own session.
 */
export async function verifySessionToken(
  token: string | undefined | null,
  code: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [encoded, signature] = parts as [string, string];

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await signingKey(code),
      base64UrlDecode(signature),
      new TextEncoder().encode(encoded),
    );
  } catch {
    return false;
  }
  if (!valid) return false;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as SessionPayload;
    return typeof payload.exp === 'number' && payload.exp > nowSeconds;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Lockout accounting
 * ------------------------------------------------------------------ */

export interface AttemptState {
  failedAttempts: number;
  firstAttemptAt: number;
  lockedUntil: number | null;
}

export interface LockoutDecision {
  locked: boolean;
  retryAfterSeconds: number;
  attemptsRemaining: number;
}

/** Whether an address may attempt a code right now. */
export function evaluateLockout(
  state: AttemptState | null,
  nowSeconds: number,
): LockoutDecision {
  if (!state) {
    return { locked: false, retryAfterSeconds: 0, attemptsRemaining: MAX_FAILED_ATTEMPTS };
  }
  if (state.lockedUntil && state.lockedUntil > nowSeconds) {
    return {
      locked: true,
      retryAfterSeconds: state.lockedUntil - nowSeconds,
      attemptsRemaining: 0,
    };
  }
  // Attempts age out, so an occasional typo never accumulates into a lockout.
  const withinWindow = nowSeconds - state.firstAttemptAt < ATTEMPT_WINDOW_SECONDS;
  const failed = withinWindow ? state.failedAttempts : 0;
  return {
    locked: false,
    retryAfterSeconds: 0,
    attemptsRemaining: Math.max(0, MAX_FAILED_ATTEMPTS - failed),
  };
}

/** The attempt row after recording one more failure. */
export function recordFailure(state: AttemptState | null, nowSeconds: number): AttemptState {
  const withinWindow =
    state !== null && nowSeconds - state.firstAttemptAt < ATTEMPT_WINDOW_SECONDS;
  const failedAttempts = (withinWindow ? state!.failedAttempts : 0) + 1;
  const firstAttemptAt = withinWindow ? state!.firstAttemptAt : nowSeconds;

  return {
    failedAttempts,
    firstAttemptAt,
    lockedUntil:
      failedAttempts >= MAX_FAILED_ATTEMPTS ? nowSeconds + LOCKOUT_SECONDS : null,
  };
}
