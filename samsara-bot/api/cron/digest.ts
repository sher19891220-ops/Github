import type { VercelRequest, VercelResponse } from '@vercel/node';
import { failed, requireAuthorized } from '../../src/guard';
import { log } from '../../src/logger';
import { buildDailyDigest } from '../../src/reports';
import { notifyDefaultChat } from '../../src/telegram/api';

/** Posts yesterday's fleet roll-up to the configured Telegram chat. */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireAuthorized(req, res)) return;

  try {
    const digest = await buildDailyDigest(new Date());
    const delivered = await notifyDefaultChat(digest);
    log.info('Daily digest sent', { delivered });
    res.status(delivered ? 200 : 500).json({ ok: delivered });
  } catch (error) {
    failed(res, error, 'Daily digest');
  }
}
