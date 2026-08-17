import { log } from './logger';
import type { FleetAlert } from './samsara/events';

/**
 * Fan-out routing: every alert goes to the central events group, and — when the
 * unit is recognised — to that unit's own group as well.
 */
export interface Route {
  chatId: string;
  /** Human label used in logs and de-duplication keys. */
  label: string;
  kind: 'central' | 'unit';
}

/**
 * Parses UNIT_CHAT_MAP, a JSON object keyed by Samsara vehicle ID *or* vehicle
 * name, valued with the Telegram chat ID of that unit's group:
 *
 *   {"Truck 12": "-1001234567890", "281": "-1009876543210"}
 *
 * Keys are matched case-insensitively and whitespace-insensitively, so
 * "truck 12", "Truck  12" and "TRUCK12" all resolve to the same group.
 */
export function parseUnitChatMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.error('UNIT_CHAT_MAP is not valid JSON; per-unit routing is disabled');
    return map;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.error('UNIT_CHAT_MAP must be a JSON object of {unit: chatId}');
    return map;
  }

  for (const [unit, chatId] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof chatId !== 'string' && typeof chatId !== 'number') {
      log.warn('Ignoring UNIT_CHAT_MAP entry with a non-string chat ID', { unit });
      continue;
    }
    map.set(routingKey(unit), String(chatId));
  }
  return map;
}

/** Normalises a unit identifier so "Truck 12" and "truck12" match. */
export function routingKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/^#/, '');
}

/**
 * Resolves an alert's destinations.
 *
 * The unit is looked up by Samsara vehicle ID first (stable) and then by
 * display name (what people actually put in the map). A unit group that is the
 * same chat as the central group is collapsed, so nobody gets the alert twice.
 */
export function resolveRoutes(
  alert: FleetAlert,
  options: { centralChatId: string; unitMap: Map<string, string> },
): Route[] {
  const routes: Route[] = [
    { chatId: options.centralChatId, label: 'central', kind: 'central' },
  ];

  const candidates = [alert.vehicleId, alert.vehicle].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidate of candidates) {
    const chatId = options.unitMap.get(routingKey(candidate));
    if (!chatId) continue;
    if (chatId === options.centralChatId) break;
    routes.push({ chatId, label: candidate, kind: 'unit' });
    break;
  }

  if (routes.length === 1 && options.unitMap.size > 0 && candidates.length > 0) {
    log.warn('No unit group mapped for this vehicle; central group only', {
      vehicle: alert.vehicle,
      vehicleId: alert.vehicleId,
    });
  }

  return routes;
}
