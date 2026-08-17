import { createHash } from 'node:crypto';
import { config } from './config';
import { log } from './logger';
import { shouldDeliver, type FleetAlert } from './samsara/events';
import { getStore } from './store';
import { getTelegramClient } from './telegram/api';
import { renderAlert } from './telegram/format';

export interface DispatchResult {
  considered: number;
  filtered: number;
  duplicates: number;
  sent: number;
  failed: number;
}

function dedupeKey(alert: FleetAlert): string {
  return `alert:${createHash('sha1').update(alert.fingerprint).digest('hex')}`;
}

/**
 * Filters, de-duplicates and delivers alerts to the configured Telegram chat.
 *
 * Delivery is sequential on purpose: Telegram throttles bursts to a channel,
 * and alert volume is low enough that ordering is worth more than throughput.
 */
export async function dispatchAlerts(
  alerts: FleetAlert[],
  options: { chatId?: string } = {},
): Promise<DispatchResult> {
  const result: DispatchResult = {
    considered: alerts.length,
    filtered: 0,
    duplicates: 0,
    sent: 0,
    failed: 0,
  };
  if (!alerts.length) return result;

  const policy = { behaviors: config.alertBehaviors, minSeverity: config.minSeverity };
  const store = getStore();
  const telegram = getTelegramClient();
  const chatId = options.chatId ?? config.telegramChatId;

  // Oldest first, so a batch reads as a timeline in the channel.
  const ordered = [...alerts].sort((a, b) => {
    const aTime = a.occurredAt?.getTime() ?? 0;
    const bTime = b.occurredAt?.getTime() ?? 0;
    return aTime - bTime;
  });

  for (const alert of ordered) {
    if (!shouldDeliver(alert, policy)) {
      result.filtered += 1;
      continue;
    }

    const fresh = await store.claim(dedupeKey(alert), config.dedupeTtlSeconds).catch((error) => {
      log.warn('De-duplication lookup failed; delivering anyway', { error });
      return true;
    });
    if (!fresh) {
      result.duplicates += 1;
      continue;
    }

    try {
      await telegram.sendMessage(chatId, renderAlert(alert), {
        disableWebPagePreview: true,
        disableNotification: alert.severity === 'low',
      });
      result.sent += 1;
    } catch (error) {
      result.failed += 1;
      log.error('Failed to send alert', { error, behavior: alert.behaviorKey });
    }
  }

  return result;
}
