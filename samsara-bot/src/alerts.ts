import { createHash } from 'node:crypto';
import { config } from './config';
import { log } from './logger';
import { parseUnitChatMap, resolveRoutes, type Route } from './routing';
import { shouldDeliver, type FleetAlert } from './samsara/events';
import { getStore } from './store';
import { getTelegramClient } from './telegram/api';
import { escapeHtml, link, renderAlert } from './telegram/format';
import { deliverVideos, undelivered, type VideoDelivery } from './video';

export interface DispatchResult {
  considered: number;
  filtered: number;
  duplicates: number;
  sent: number;
  failed: number;
  videosSent: number;
  videosFailed: number;
  /** Chats an alert actually reached, for the response body and logs. */
  routes: string[];
}

/** De-duplication is per destination, so a retry cannot skip the unit group. */
function dedupeKey(alert: FleetAlert, route: Route): string {
  const hash = createHash('sha1').update(alert.fingerprint).digest('hex');
  return `alert:${hash}:${route.chatId}`;
}

/**
 * Filters, de-duplicates and delivers alerts.
 *
 * Every alert goes to the central events group; when the vehicle is mapped in
 * UNIT_CHAT_MAP it also goes to that unit's own group. Clips are pushed after
 * the text so the message lands immediately even if video takes a while, and
 * any clip that could not be delivered is appended to the alert as a link.
 */
export async function dispatchAlerts(
  alerts: FleetAlert[],
  options: { chatId?: string; deadline?: number; sendVideos?: boolean } = {},
): Promise<DispatchResult> {
  const result: DispatchResult = {
    considered: alerts.length,
    filtered: 0,
    duplicates: 0,
    sent: 0,
    failed: 0,
    videosSent: 0,
    videosFailed: 0,
    routes: [],
  };
  if (!alerts.length) return result;

  const policy = { behaviors: config.alertBehaviors, minSeverity: config.minSeverity };
  const store = getStore();
  const telegram = getTelegramClient();
  const centralChatId = options.chatId ?? config.telegramChatId;
  const unitMap = parseUnitChatMap(config.unitChatMap);
  const sendVideos = options.sendVideos ?? config.sendVideos;
  const deadline = options.deadline ?? Date.now() + 45_000;
  const reached = new Set<string>();

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

    const routes = resolveRoutes(alert, { centralChatId, unitMap });

    for (const route of routes) {
      const fresh = await store
        .claim(dedupeKey(alert, route), config.dedupeTtlSeconds)
        .catch((error) => {
          log.warn('De-duplication lookup failed; delivering anyway', { error });
          return true;
        });
      if (!fresh) {
        result.duplicates += 1;
        continue;
      }

      let deliveries: VideoDelivery[] = [];
      if (sendVideos && alert.videos.length) {
        deliveries = await deliverVideos(
          telegram,
          route.chatId,
          alert.videos,
          `${alert.emoji} ${escapeHtml(alert.title)}${
            alert.vehicle ? ` — ${escapeHtml(alert.vehicle)}` : ''
          }`,
          { deadline },
        );
        result.videosSent += deliveries.length - undelivered(deliveries).length;
        result.videosFailed += undelivered(deliveries).length;
      }

      // Anything the clip pipeline could not deliver still gets linked.
      const stragglers = undelivered(deliveries);
      const body = stragglers.length
        ? `${renderAlert(alert)}\n\n${stragglers
            .map((item) => link(`${item.label} (clip)`, item.url))
            .join(' · ')}`
        : renderAlert(alert);

      try {
        await telegram.sendMessage(route.chatId, body, { disableWebPagePreview: true,
          disableNotification: alert.severity === 'low' });
        result.sent += 1;
        reached.add(`${route.kind}:${route.label}`);
      } catch (error) {
        result.failed += 1;
        log.error('Failed to send alert', {
          error,
          behavior: alert.behaviorKey,
          route: route.kind,
        });
      }
    }
  }

  result.routes = [...reached];
  return result;
}
