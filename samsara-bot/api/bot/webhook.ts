import type { VercelRequest, VercelResponse } from '@vercel/node';
import { config } from '../../src/config';
import { log } from '../../src/logger';
import { safeEqual } from '../../src/security';
import { getTelegramClient, type TelegramUpdate } from '../../src/telegram/api';
import { handleCommand } from '../../src/telegram/commands';

/**
 * Receives Telegram updates and answers commands.
 *
 * Always replies 200: a non-2xx makes Telegram retry the same update, which for
 * a slow Samsara query means duplicate work rather than recovery. Failures are
 * reported to the user in-chat and to the logs instead.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const expectedSecret = config.telegramWebhookSecret;
  if (expectedSecret) {
    const provided = req.headers['x-telegram-bot-api-secret-token'];
    const token = Array.isArray(provided) ? provided[0] : provided;
    if (!token || !safeEqual(token, expectedSecret)) {
      log.warn('Rejected Telegram update with bad secret token');
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  const update = req.body as TelegramUpdate | undefined;
  const message = update?.message ?? update?.edited_message;

  if (!message?.text) {
    res.status(200).json({ ok: true, handled: false });
    return;
  }

  try {
    const reply = await handleCommand(message);
    if (reply) {
      await getTelegramClient().sendMessage(message.chat.id, reply, {
        replyToMessageId: message.message_id,
        disableWebPagePreview: true,
      });
    }
    res.status(200).json({ ok: true, handled: Boolean(reply) });
  } catch (error) {
    log.error('Failed to handle Telegram update', { error, updateId: update?.update_id });
    res.status(200).json({ ok: true, handled: false, error: 'internal error' });
  }
}
