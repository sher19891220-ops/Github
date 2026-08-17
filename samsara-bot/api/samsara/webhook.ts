import type { VercelRequest, VercelResponse } from '@vercel/node';
import { dispatchAlerts } from '../../src/alerts';
import { config as appConfig } from '../../src/config';
import { parseJson, readRawBody } from '../../src/http';
import { log } from '../../src/logger';
import { fromWebhook } from '../../src/samsara/events';
import type { SamsaraWebhookPayload } from '../../src/samsara/types';
import { verifySamsaraSignature } from '../../src/security';

/**
 * Leaves the request stream untouched so the HMAC can be computed over the
 * exact bytes Samsara signed.
 */
export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Receives Samsara webhook events (safety, alerts, DVIRs, faults) and pushes
 * the interesting ones to Telegram.
 *
 * Samsara retries non-2xx responses, so this only fails the request when the
 * signature is wrong — everything else is logged and acknowledged.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const rawBody = await readRawBody(req);

  const secret = appConfig.samsaraWebhookSecret;
  if (secret) {
    const signature = req.headers['x-samsara-signature'];
    const timestamp = req.headers['x-samsara-timestamp'];
    const check = verifySamsaraSignature(
      rawBody,
      Array.isArray(signature) ? signature[0] : signature,
      Array.isArray(timestamp) ? timestamp[0] : timestamp,
      secret,
    );
    if (!check.valid) {
      log.warn('Rejected Samsara webhook', { reason: check.reason });
      res.status(401).json({ ok: false, error: check.reason ?? 'invalid signature' });
      return;
    }
  } else {
    log.warn('SAMSARA_WEBHOOK_SECRET is not set; accepting webhook without verification');
  }

  const payload = parseJson<SamsaraWebhookPayload>(rawBody);
  if (!payload) {
    res.status(200).json({ ok: true, handled: false, reason: 'unparseable body' });
    return;
  }

  try {
    const alert = fromWebhook(payload);
    if (!alert) {
      res.status(200).json({ ok: true, handled: false, reason: 'no alert derived' });
      return;
    }

    const result = await dispatchAlerts([alert]);
    log.info('Handled Samsara webhook', { eventType: payload.eventType, ...result });
    res.status(200).json({ ok: true, handled: result.sent > 0, result });
  } catch (error) {
    log.error('Samsara webhook processing failed', { error, eventType: payload.eventType });
    res.status(200).json({ ok: true, handled: false, error: 'internal error' });
  }
}
