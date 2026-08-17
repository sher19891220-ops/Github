import { log } from './logger';
import type { FleetAlert } from './samsara/events';

/**
 * Fan-out routing: every alert goes to the central events group, and — when the
 * unit is recognised — to that unit's own destination as well.
 */
export interface Route {
  chatId: string;
  /** Forum topic within the chat, when the group uses topics. */
  threadId?: number;
  /** Human label used in logs and de-duplication keys. */
  label: string;
  kind: 'central' | 'unit';
}

export interface Destination {
  chatId: string;
  threadId?: number;
}

/**
 * Splits a Samsara vehicle label into every identifier it contains.
 *
 * Real fleet labels look like `5269 (GZP5W69Z75) 281474991641331` — unit
 * number, plate, then Samsara vehicle ID. People map units by the number they
 * actually say out loud ("5269"), so all three become routable keys.
 */
export function candidateKeys(alert: FleetAlert): string[] {
  const keys: string[] = [];
  if (alert.vehicleId) keys.push(alert.vehicleId);

  if (alert.vehicle) {
    keys.push(alert.vehicle);
    for (const token of alert.vehicle.split(/[\s()[\],]+/)) {
      if (token) keys.push(token);
    }
  }

  const seen = new Set<string>();
  return keys
    .map(routingKey)
    .filter((key) => key.length > 0 && !seen.has(key) && (seen.add(key), true));
}

/** Normalises a unit identifier so "Truck 12" and "truck12" match. */
export function routingKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/^#/, '');
}

/**
 * Parses a destination value. Accepts a bare chat ID, or `chatId:threadId` for
 * a forum topic — the Samsara Events group is a forum, so alerts can be pinned
 * to a per-unit topic instead of needing a whole separate group.
 */
export function parseDestination(raw: string): Destination | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  // A leading "-100…" chat ID contains no colon, so the last colon separates
  // the thread when present.
  const separator = value.lastIndexOf(':');
  if (separator === -1) return { chatId: value };

  const chatId = value.slice(0, separator).trim();
  const threadRaw = value.slice(separator + 1).trim();
  const threadId = Number(threadRaw);
  if (!chatId || !Number.isInteger(threadId) || threadId <= 0) {
    log.warn('Ignoring malformed UNIT_CHAT_MAP destination', { value });
    return undefined;
  }
  return { chatId, threadId };
}

/**
 * Parses UNIT_CHAT_MAP, a JSON object keyed by unit number, plate, vehicle name
 * or Samsara vehicle ID, valued with that unit's destination:
 *
 *   {"5269": "-1001234567890", "1645": "-1002922384236:42"}
 *
 * Keys are matched case- and space-insensitively.
 */
export function parseUnitChatMap(raw: string | undefined): Map<string, Destination> {
  const map = new Map<string, Destination>();
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

  for (const [unit, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      log.warn('Ignoring UNIT_CHAT_MAP entry with a non-scalar destination', { unit });
      continue;
    }
    const destination = parseDestination(String(value));
    if (destination) map.set(routingKey(unit), destination);
  }
  return map;
}

/**
 * Resolves an alert's destinations: always the central group, plus the unit's
 * own group or topic when one is mapped.
 */
export function resolveRoutes(
  alert: FleetAlert,
  options: { centralChatId: string; centralThreadId?: number; unitMap: Map<string, Destination> },
): Route[] {
  const routes: Route[] = [
    {
      chatId: options.centralChatId,
      threadId: options.centralThreadId,
      label: 'central',
      kind: 'central',
    },
  ];

  const keys = candidateKeys(alert);
  for (const key of keys) {
    const destination = options.unitMap.get(key);
    if (!destination) continue;
    const duplicate =
      destination.chatId === options.centralChatId &&
      destination.threadId === options.centralThreadId;
    if (!duplicate) {
      routes.push({ ...destination, label: key, kind: 'unit' });
    }
    return routes;
  }

  if (options.unitMap.size > 0 && keys.length > 0) {
    log.warn('No unit destination mapped for this vehicle; central group only', {
      vehicle: alert.vehicle,
      vehicleId: alert.vehicleId,
      triedKeys: keys,
    });
  }

  return routes;
}
