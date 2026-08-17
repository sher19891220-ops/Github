import type { IncomingMessage } from 'node:http';

/**
 * Reads the exact request bytes.
 *
 * Signature verification needs the body *as sent*, so every handler that
 * verifies an HMAC also exports `config = { api: { bodyParser: false } }`,
 * which leaves the stream unread for us. The other branches below are
 * fallbacks for when something upstream has already consumed and parsed it.
 */
export async function readRawBody(req: IncomingMessage & { body?: unknown }): Promise<string> {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');

  if (req.readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // Body was already parsed elsewhere: re-serialising is not byte-exact, so an
  // HMAC computed over this may legitimately fail.
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

export function parseJson<T>(raw: string): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Reads a query parameter, collapsing Vercel's `string | string[]` shape. */
export function firstQueryValue(
  query: Partial<Record<string, string | string[]>>,
  key: string,
): string | undefined {
  const value = query[key];
  if (Array.isArray(value)) return value[0];
  return value;
}
