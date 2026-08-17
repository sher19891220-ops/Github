import type { VercelRequest, VercelResponse } from '@vercel/node';
import { dispatchAlerts } from '../../src/alerts';
import { config } from '../../src/config';
import { failed, requireAuthorized } from '../../src/guard';
import { log } from '../../src/logger';
import { getSamsaraClient } from '../../src/samsara/client';
import { fromSafetyEvent } from '../../src/samsara/events';
import { getStore } from '../../src/store';

const WATERMARK_KEY = 'watermark:safety-events';

/**
 * Polls Samsara for recent safety events and pushes new ones to Telegram.
 *
 * This is the safety net for the webhook path: if a webhook is never
 * configured, or Samsara drops a delivery, the poller still catches the event.
 * De-duplication in dispatchAlerts keeps the two paths from doubling up.
 *
 * A stored watermark makes the window pick up where the last run stopped;
 * without a persistent store it falls back to SAFETY_LOOKBACK_MINUTES.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireAuthorized(req, res)) return;

  const now = new Date();
  const store = getStore();

  try {
    const stored = await store.get(WATERMARK_KEY).catch(() => null);
    const fallbackStart = new Date(now.getTime() - config.safetyLookbackMinutes * 60 * 1000);
    const watermark = stored ? new Date(stored) : undefined;

    // Never look back more than 24h, so a long outage cannot replay the world.
    const floor = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const start =
      watermark && !Number.isNaN(watermark.getTime()) && watermark > floor
        ? watermark
        : fallbackStart;

    const events = await getSamsaraClient().listSafetyEvents(start, now);
    const result = await dispatchAlerts(events.map(fromSafetyEvent));

    // Overlap slightly so an event written just after the cut-off is not missed.
    await store
      .set(WATERMARK_KEY, new Date(now.getTime() - 60 * 1000).toISOString())
      .catch((error) => log.warn('Could not persist safety watermark', { error }));

    log.info('Safety poll complete', { start: start.toISOString(), ...result });
    res.status(200).json({ ok: true, window: { start, end: now }, ...result });
  } catch (error) {
    failed(res, error, 'Safety poll');
  }
}
