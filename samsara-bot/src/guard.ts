import type { VercelRequest, VercelResponse } from '@vercel/node';
import { config } from './config';
import { firstQueryValue } from './http';
import { log } from './logger';
import { isAuthorized } from './security';

/**
 * Gate for cron and admin endpoints. Writes the 401 itself and returns false
 * when the caller is not allowed through.
 */
export function requireAuthorized(req: VercelRequest, res: VercelResponse): boolean {
  const allowed = isAuthorized(
    {
      authorizationHeader: req.headers.authorization,
      querySecret: firstQueryValue(req.query, 'secret'),
    },
    { cronSecret: config.cronSecret, adminSecret: config.adminSecret },
  );
  if (!allowed) {
    log.warn('Rejected unauthorized call', { url: req.url });
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

/** Uniform 500 body for handler failures. */
export function failed(res: VercelResponse, error: unknown, context: string): void {
  log.error(`${context} failed`, { error });
  res.status(500).json({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
