import { config } from '../config';
import { buildDailyDigest, buildPtiReport } from '../reports';
import { getSamsaraClient, type SamsaraClient } from '../samsara/client';
import { fromSafetyEvent } from '../samsara/events';
import type { Driver, Vehicle } from '../samsara/types';
import { bold, code, escapeHtml, formatDuration, formatTime, metersToMiles } from './format';
import type { TelegramMessage } from './api';

export interface ParsedCommand {
  name: string;
  args: string;
}

/** Extracts `/command@bot arg arg` from message text. */
export function parseCommand(text: string | undefined): ParsedCommand | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return undefined;
  return { name: (match[1] ?? '').toLowerCase(), args: (match[2] ?? '').trim() };
}

/** Empty allow-list means the bot is open; otherwise the user ID must match. */
export function isAllowedUser(userId: number | undefined, allowed: string[]): boolean {
  if (!allowed.length) return true;
  if (userId === undefined) return false;
  return allowed.includes(String(userId));
}

function score(candidate: string, needle: string): number {
  const haystack = candidate.toLowerCase();
  const query = needle.toLowerCase();
  if (haystack === query) return 100;
  if (haystack.startsWith(query)) return 80;
  if (haystack.includes(query)) return 60;
  return 0;
}

/** Ranks vehicles/drivers by name, ID and (for vehicles) VIN or plate. */
export function findBestMatch<T extends { id: string; name?: string }>(
  items: T[],
  query: string,
  extraFields: (item: T) => (string | undefined)[] = () => [],
): T | undefined {
  if (!query) return undefined;
  let best: T | undefined;
  let bestScore = 0;
  for (const item of items) {
    const fields = [item.name, item.id, ...extraFields(item)].filter(
      (value): value is string => Boolean(value),
    );
    const itemScore = Math.max(0, ...fields.map((field) => score(field, query)));
    if (itemScore > bestScore) {
      best = item;
      bestScore = itemScore;
    }
  }
  return bestScore > 0 ? best : undefined;
}

const HELP = [
  `🤖 ${bold('Samsara fleet bot')}`,
  '',
  'Alerts for crashes, phone use, seat belts, speeding, unassigned driving and',
  'DVIR defects arrive here automatically. You can also ask:',
  '',
  `${code('/status')} — fleet snapshot right now`,
  `${code('/where <vehicle>')} — last known location`,
  `${code('/vehicle <name|VIN|plate>')} — full vehicle detail`,
  `${code('/driver <name>')} — driver HOS clocks`,
  `${code('/hos')} — drivers closest to running out of hours`,
  `${code('/safety [hours]')} — safety events in the last N hours (default 12)`,
  `${code('/pti')} — today's pre-trip inspection compliance`,
  `${code('/digest')} — yesterday's fleet roll-up`,
  `${code('/whoami')} — show this chat and user ID`,
].join('\n');

export interface CommandContext {
  message: TelegramMessage;
  client: SamsaraClient;
  now: Date;
}

type Handler = (args: string, ctx: CommandContext) => Promise<string>;

async function statusCommand(_args: string, ctx: CommandContext): Promise<string> {
  const [vehicles, drivers, stats] = await Promise.all([
    ctx.client.listVehicles(),
    ctx.client.listDrivers(),
    ctx.client.listVehicleStats(['engineStates', 'gps']),
  ]);
  const running = stats.filter(
    (stat) => (stat.engineStates?.value ?? '').toLowerCase() === 'running',
  );
  const moving = stats.filter((stat) => (stat.gps?.speedMilesPerHour ?? 0) > 1);

  return [
    `🚛 ${bold('Fleet status')}`,
    '',
    `• Vehicles: ${vehicles.length}`,
    `• Active drivers: ${drivers.length}`,
    `• Engines running: ${running.length}`,
    `• Currently moving: ${moving.length}`,
    '',
    `As of ${escapeHtml(formatTime(ctx.now))}`,
  ].join('\n');
}

async function resolveVehicle(query: string, client: SamsaraClient): Promise<Vehicle | undefined> {
  const vehicles = await client.listVehicles();
  return findBestMatch(vehicles, query, (vehicle) => [vehicle.vin, vehicle.licensePlate]);
}

async function vehicleCommand(args: string, ctx: CommandContext): Promise<string> {
  if (!args) return 'Usage: <code>/vehicle &lt;name, VIN or plate&gt;</code>';
  const vehicle = await resolveVehicle(args, ctx.client);
  if (!vehicle) return `No vehicle matched ${code(args)}.`;

  const stats = await ctx.client.listVehicleStats(
    ['gps', 'engineStates', 'fuelPercents', 'obdOdometerMeters'],
    [vehicle.id],
  );
  const stat = stats[0];
  const gps = stat?.gps;
  const miles = metersToMiles(stat?.obdOdometerMeters?.value);

  const lines = [
    `🚛 ${bold(vehicle.name ?? `#${vehicle.id}`)}`,
    '',
    vehicle.vin ? `• VIN: ${code(vehicle.vin)}` : undefined,
    vehicle.licensePlate ? `• Plate: ${code(vehicle.licensePlate)}` : undefined,
    vehicle.make || vehicle.model
      ? `• ${escapeHtml([vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' '))}`
      : undefined,
    stat?.engineStates?.value ? `• Engine: ${escapeHtml(stat.engineStates.value)}` : undefined,
    typeof stat?.fuelPercents?.value === 'number' ? `• Fuel: ${stat.fuelPercents.value}%` : undefined,
    miles !== undefined ? `• Odometer: ${Math.round(miles).toLocaleString('en-US')} mi` : undefined,
    gps?.reverseGeo?.formattedLocation
      ? `• Location: ${escapeHtml(gps.reverseGeo.formattedLocation)}`
      : undefined,
    typeof gps?.speedMilesPerHour === 'number'
      ? `• Speed: ${Math.round(gps.speedMilesPerHour)} mph`
      : undefined,
    gps?.time ? `• GPS fix: ${escapeHtml(formatTime(new Date(gps.time)))}` : undefined,
  ].filter((line): line is string => line !== undefined);

  if (typeof gps?.latitude === 'number' && typeof gps.longitude === 'number') {
    lines.push('');
    lines.push(`<a href="https://maps.google.com/?q=${gps.latitude},${gps.longitude}">Open map</a>`);
  }
  return lines.join('\n');
}

async function whereCommand(args: string, ctx: CommandContext): Promise<string> {
  if (!args) return 'Usage: <code>/where &lt;vehicle&gt;</code>';
  const vehicle = await resolveVehicle(args, ctx.client);
  if (!vehicle) return `No vehicle matched ${code(args)}.`;

  const stats = await ctx.client.listVehicleStats(['gps'], [vehicle.id]);
  const gps = stats[0]?.gps;
  if (!gps) return `No recent GPS fix for ${bold(vehicle.name ?? vehicle.id)}.`;

  const place = gps.reverseGeo?.formattedLocation ?? gps.address?.name;
  const lines = [
    `📍 ${bold(vehicle.name ?? `#${vehicle.id}`)}`,
    place ? escapeHtml(place) : undefined,
    typeof gps.speedMilesPerHour === 'number'
      ? `Moving at ${Math.round(gps.speedMilesPerHour)} mph`
      : undefined,
    gps.time ? `As of ${escapeHtml(formatTime(new Date(gps.time)))}` : undefined,
  ].filter((line): line is string => line !== undefined);

  if (typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
    lines.push(`<a href="https://maps.google.com/?q=${gps.latitude},${gps.longitude}">Open map</a>`);
  }
  return lines.join('\n');
}

function hosLines(driverName: string, clocks: NonNullable<Awaited<ReturnType<SamsaraClient['listHosClocks']>>>[number]['clocks']): string[] {
  return [
    `👤 ${bold(driverName)}`,
    `• Drive remaining: ${formatDuration(clocks?.drive?.driveRemainingDurationMs)}`,
    `• Shift remaining: ${formatDuration(clocks?.shift?.shiftRemainingDurationMs)}`,
    `• Cycle remaining: ${formatDuration(clocks?.cycle?.cycleRemainingDurationMs)}`,
    `• Until break: ${formatDuration(clocks?.break?.timeUntilBreakDurationMs)}`,
  ];
}

async function driverCommand(args: string, ctx: CommandContext): Promise<string> {
  if (!args) return 'Usage: <code>/driver &lt;name&gt;</code>';
  const drivers = await ctx.client.listDrivers();
  const driver = findBestMatch<Driver>(drivers, args, (item) => [item.username, item.phone]);
  if (!driver) return `No active driver matched ${code(args)}.`;

  const clocks = await ctx.client.listHosClocks([driver.id]);
  const entry = clocks.find((clock) => clock.driver?.id === driver.id) ?? clocks[0];
  return hosLines(driver.name ?? `#${driver.id}`, entry?.clocks).join('\n');
}

async function hosCommand(_args: string, ctx: CommandContext): Promise<string> {
  const clocks = await ctx.client.listHosClocks();
  const ranked = clocks
    .map((clock) => ({
      name: clock.driver?.name ?? `#${clock.driver?.id ?? '?'}`,
      remaining: clock.clocks?.drive?.driveRemainingDurationMs ?? Number.POSITIVE_INFINITY,
      shift: clock.clocks?.shift?.shiftRemainingDurationMs,
    }))
    .filter((entry) => Number.isFinite(entry.remaining))
    .sort((a, b) => a.remaining - b.remaining)
    .slice(0, 10);

  if (!ranked.length) return 'No HOS clocks returned for this org.';
  return [
    `⏱️ ${bold('Drivers closest to running out of drive time')}`,
    '',
    ...ranked.map(
      (entry) =>
        `• ${escapeHtml(entry.name)} — drive ${formatDuration(entry.remaining)}, shift ${formatDuration(entry.shift)}`,
    ),
  ].join('\n');
}

async function safetyCommand(args: string, ctx: CommandContext): Promise<string> {
  const hours = Math.min(168, Math.max(1, Number(args) || 12));
  const start = new Date(ctx.now.getTime() - hours * 60 * 60 * 1000);
  const events = await ctx.client.listSafetyEvents(start, ctx.now);
  if (!events.length) return `No safety events in the last ${hours}h. ✅`;

  const alerts = events.map(fromSafetyEvent).slice(-15);
  return [
    `⚠️ ${bold(`${events.length} safety event${events.length === 1 ? '' : 's'} in the last ${hours}h`)}`,
    '',
    ...alerts.map((alert) => {
      const who = alert.driver ?? alert.vehicle ?? 'unknown';
      return `${alert.emoji} ${escapeHtml(alert.title)} — ${escapeHtml(who)} · ${escapeHtml(formatTime(alert.occurredAt))}`;
    }),
  ].join('\n');
}

async function ptiCommand(_args: string, ctx: CommandContext): Promise<string> {
  const report = await buildPtiReport(ctx.now, ctx.client);
  return report.text;
}

async function digestCommand(_args: string, ctx: CommandContext): Promise<string> {
  return buildDailyDigest(ctx.now, ctx.client);
}

async function whoamiCommand(_args: string, ctx: CommandContext): Promise<string> {
  return [
    `Chat ID: ${code(String(ctx.message.chat.id))}`,
    `Chat type: ${code(ctx.message.chat.type)}`,
    `Your user ID: ${code(String(ctx.message.from?.id ?? 'unknown'))}`,
  ].join('\n');
}

const HANDLERS: Record<string, Handler> = {
  start: async () => HELP,
  help: async () => HELP,
  status: statusCommand,
  vehicle: vehicleCommand,
  where: whereCommand,
  driver: driverCommand,
  hos: hosCommand,
  safety: safetyCommand,
  pti: ptiCommand,
  dvir: ptiCommand,
  digest: digestCommand,
  whoami: whoamiCommand,
};

export const KNOWN_COMMANDS = Object.keys(HANDLERS);

/**
 * Runs a command and returns the reply text, or undefined when the message is
 * not a command this bot handles (so group chatter stays silent).
 */
export async function handleCommand(
  message: TelegramMessage,
  options: { client?: SamsaraClient; now?: Date } = {},
): Promise<string | undefined> {
  const parsed = parseCommand(message.text);
  if (!parsed) return undefined;

  const handler = HANDLERS[parsed.name];
  if (!handler) {
    return message.chat.type === 'private'
      ? `Unknown command ${code(`/${parsed.name}`)}. Try ${code('/help')}.`
      : undefined;
  }

  if (!isAllowedUser(message.from?.id, config.allowedUserIds)) {
    return '⛔ You are not authorised to use this bot.';
  }

  const ctx: CommandContext = {
    message,
    client: options.client ?? getSamsaraClient(),
    now: options.now ?? new Date(),
  };

  try {
    return await handler(parsed.args, ctx);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `⚠️ ${escapeHtml(`/${parsed.name} failed: ${detail}`)}`;
  }
}
