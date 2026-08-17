import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time string compare that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export interface SignatureCheck {
  valid: boolean;
  reason?: string;
}

/**
 * Verifies a Samsara webhook signature.
 *
 * Samsara signs `v1:<timestamp>:<raw body>` with the webhook secret and sends
 * the result as `X-Samsara-Signature: v1=<hex>`, alongside `X-Samsara-Timestamp`.
 * Older/simpler configurations sign the raw body alone, so that scheme is
 * accepted too — both require possession of the secret.
 */
export function verifySamsaraSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): SignatureCheck {
  if (!signatureHeader) return { valid: false, reason: 'missing signature header' };

  const provided = signatureHeader.includes('=')
    ? signatureHeader.split('=').slice(1).join('=').trim()
    : signatureHeader.trim();
  if (!provided) return { valid: false, reason: 'malformed signature header' };

  const tolerance = options.toleranceSeconds ?? 300;
  if (timestampHeader) {
    const sent = Number(timestampHeader);
    if (!Number.isFinite(sent)) return { valid: false, reason: 'malformed timestamp header' };
    // Samsara sends milliseconds; accept seconds as well.
    const sentMs = sent > 1e11 ? sent : sent * 1000;
    const now = options.now ?? Date.now();
    if (Math.abs(now - sentMs) > tolerance * 1000) {
      return { valid: false, reason: 'timestamp outside tolerance' };
    }
  }

  const candidates = [
    ...(timestampHeader ? [`v1:${timestampHeader}:${rawBody}`] : []),
    rawBody,
  ];
  for (const candidate of candidates) {
    if (safeEqual(hmacHex(secret, candidate), provided)) return { valid: true };
  }
  return { valid: false, reason: 'signature mismatch' };
}

/**
 * Authorises a manual/cron call. Vercel Cron sends `Authorization: Bearer
 * <CRON_SECRET>`; a human can instead pass `?secret=<ADMIN_SECRET>`.
 *
 * When neither secret is configured the endpoint is left open, which is only
 * appropriate for local development — the README says so loudly.
 */
export function isAuthorized(
  input: {
    authorizationHeader?: string;
    querySecret?: string;
  },
  secrets: { cronSecret?: string; adminSecret?: string },
): boolean {
  const { cronSecret, adminSecret } = secrets;
  if (!cronSecret && !adminSecret) return true;

  if (cronSecret && input.authorizationHeader) {
    const bearer = input.authorizationHeader.replace(/^Bearer\s+/i, '').trim();
    if (safeEqual(bearer, cronSecret)) return true;
  }
  if (adminSecret && input.querySecret && safeEqual(input.querySecret, adminSecret)) return true;
  if (adminSecret && input.authorizationHeader) {
    const bearer = input.authorizationHeader.replace(/^Bearer\s+/i, '').trim();
    if (safeEqual(bearer, adminSecret)) return true;
  }
  return false;
}
