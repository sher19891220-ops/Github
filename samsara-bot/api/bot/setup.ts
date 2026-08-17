import type { VercelRequest, VercelResponse } from '@vercel/node';
import { config } from '../../src/config';
import { firstQueryValue } from '../../src/http';
import { log } from '../../src/logger';
import { isAuthorized } from '../../src/security';
import { getTelegramClient } from '../../src/telegram/api';

/**
 * Registers (or inspects/removes) this deployment's Telegram webhook.
 *
 *   GET /api/bot/setup?secret=<ADMIN_SECRET>            -> register
 *   GET /api/bot/setup?secret=...&action=info           -> current webhook info
 *   GET /api/bot/setup?secret=...&action=delete         -> unregister
 *
 * The target URL defaults to this deployment's own host, so it works for
 * preview deployments without extra configuration.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const authorized = isAuthorized(
    {
      authorizationHeader: req.headers.authorization,
      querySecret: firstQueryValue(req.query, 'secret'),
    },
    { cronSecret: config.cronSecret, adminSecret: config.adminSecret },
  );
  if (!authorized) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const action = firstQueryValue(req.query, 'action') ?? 'set';
  const telegram = getTelegramClient();

  try {
    if (action === 'info') {
      res.status(200).json({ ok: true, action, info: await telegram.getWebhookInfo() });
      return;
    }

    if (action === 'delete') {
      await telegram.deleteWebhook();
      res.status(200).json({ ok: true, action });
      return;
    }

    const host = firstQueryValue(req.query, 'host') ?? req.headers.host;
    if (!host) {
      res.status(400).json({ ok: false, error: 'could not determine host; pass ?host=' });
      return;
    }
    const webhookUrl = `https://${host}/api/bot/webhook`;

    await telegram.setWebhook(webhookUrl, config.telegramWebhookSecret);
    const me = await telegram.getMe();
    log.info('Telegram webhook registered', { webhookUrl, bot: me.username });

    res.status(200).json({
      ok: true,
      action: 'set',
      webhookUrl,
      bot: me.username,
      secretTokenConfigured: Boolean(config.telegramWebhookSecret),
    });
  } catch (error) {
    log.error('Webhook setup failed', { error });
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
