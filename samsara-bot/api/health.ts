import type { VercelRequest, VercelResponse } from '@vercel/node';
import { config } from '../src/config';
import { getStore } from '../src/store';

/** Liveness plus a quick "is this thing configured?" readout. */
export default function handler(_req: VercelRequest, res: VercelResponse): void {
  const configured = {
    samsaraToken: Boolean(process.env['SAMSARA_API_TOKEN']),
    samsaraWebhookSecret: Boolean(config.samsaraWebhookSecret),
    telegramToken: Boolean(process.env['TELEGRAM_BOT_TOKEN']),
    telegramChatId: Boolean(process.env['TELEGRAM_CHAT_ID']),
    telegramWebhookSecret: Boolean(config.telegramWebhookSecret),
    cronSecret: Boolean(config.cronSecret),
    persistentStore: getStore().isPersistent,
  };

  const ready = configured.samsaraToken && configured.telegramToken && configured.telegramChatId;

  res.status(ready ? 200 : 503).json({
    ok: ready,
    timezone: config.timezone,
    minSeverity: config.minSeverity,
    alertBehaviors: config.alertBehaviors.length ? config.alertBehaviors : 'all',
    configured,
  });
}
