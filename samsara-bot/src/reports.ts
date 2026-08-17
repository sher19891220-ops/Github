import { config } from './config';
import { log } from './logger';
import { getSamsaraClient, type SamsaraClient } from './samsara/client';
import { classifyBehavior, fromDvir, type FleetAlert } from './samsara/events';
import type { Dvir, SafetyEvent } from './samsara/types';
import { formatDate, metersToMiles, renderDigest, type DigestSection } from './telegram/format';
import { todayWindow, yesterdayWindow } from './time';

/** Runs a section builder, turning a failure into a visible warning line. */
async function section(
  title: string,
  emoji: string,
  build: () => Promise<string[]>,
): Promise<DigestSection> {
  try {
    return { title, emoji, lines: await build() };
  } catch (error) {
    log.error('Digest section failed', { title, error });
    const message = error instanceof Error ? error.message : String(error);
    return { title, emoji, lines: [], error: `Could not load: ${message}` };
  }
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const bucket = key(item);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return counts;
}

function topLines(counts: Map<string, number>, limit = 8): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, count]) => `• ${label}: ${count}`);
}

function primaryBehaviorTitle(event: SafetyEvent): string {
  const labels = event.behaviorLabels ?? [];
  if (!labels.length) return 'Unlabelled safety event';
  return classifyBehavior(labels[0]?.label ?? labels[0]?.name).title;
}

function unresolvedDefects(dvir: Dvir): number {
  return (dvir.defects ?? []).filter((defect) => !defect.isResolved).length;
}

function isPreTrip(dvir: Dvir): boolean {
  return (dvir.inspectionType ?? '').toLowerCase().includes('pre');
}

export interface PtiReport {
  text: string;
  /** Defect/unsafe DVIRs worth pushing as alerts in their own right. */
  alerts: FleetAlert[];
}

/**
 * Pre-trip inspection compliance for the current local day: which vehicles have
 * a submitted pre-trip DVIR, which came back unsafe, and what is outstanding.
 */
export async function buildPtiReport(
  now: Date,
  client: SamsaraClient = getSamsaraClient(),
): Promise<PtiReport> {
  const window = todayWindow(now, config.timezone);
  const dvirs = await client.listDvirs(window.start, window.end);

  const preTrips = dvirs.filter(isPreTrip);
  const inspectedVehicleIds = new Set(
    preTrips.map((dvir) => dvir.vehicle?.id).filter((id): id is string => Boolean(id)),
  );

  const unsafe = dvirs.filter(
    (dvir) => (dvir.safetyStatus ?? '').toLowerCase() === 'unsafe' || unresolvedDefects(dvir) > 0,
  );

  const sections: DigestSection[] = [];

  sections.push(
    await section('Submitted today', '✅', async () => [
      `• Pre-trip inspections: ${preTrips.length}`,
      `• All DVIRs (pre, post, mechanic): ${dvirs.length}`,
      `• Distinct vehicles inspected: ${inspectedVehicleIds.size}`,
    ]),
  );

  sections.push(
    await section('Missing a pre-trip', '🚫', async () => {
      const vehicles = await client.listVehicles();
      const missing = vehicles.filter((vehicle) => !inspectedVehicleIds.has(vehicle.id));
      if (!missing.length) return ['Every vehicle in the fleet has a pre-trip DVIR today.'];
      const names = missing
        .slice(0, 25)
        .map((vehicle) => `• ${vehicle.name ?? `#${vehicle.id}`}`);
      if (missing.length > 25) names.push(`• …and ${missing.length - 25} more`);
      return [`${missing.length} of ${vehicles.length} vehicles have no pre-trip DVIR:`, ...names];
    }),
  );

  sections.push(
    await section('Unsafe / defects', '🔧', async () =>
      unsafe.slice(0, 15).map((dvir) => {
        const vehicle = dvir.vehicle?.name ?? dvir.trailer?.name ?? `#${dvir.vehicle?.id ?? '?'}`;
        const driver = dvir.driver?.name ?? 'unknown driver';
        const defects = unresolvedDefects(dvir);
        return `• ${vehicle} (${driver}) — ${defects} open defect${defects === 1 ? '' : 's'}`;
      }),
    ),
  );

  return {
    text: renderDigest(`PTI / DVIR check — ${formatDate(now, config.timezone)}`, sections),
    alerts: unsafe.map(fromDvir),
  };
}

/** Yesterday's fleet roll-up: safety, inspections, HOS and utilisation. */
export async function buildDailyDigest(
  now: Date,
  client: SamsaraClient = getSamsaraClient(),
): Promise<string> {
  const window = yesterdayWindow(now, config.timezone);
  const sections: DigestSection[] = [];

  sections.push(
    await section('Safety events', '⚠️', async () => {
      const events = await client.listSafetyEvents(window.start, window.end);
      if (!events.length) return ['No safety events recorded. 🎉'];
      const byBehavior = countBy(events, primaryBehaviorTitle);
      const byDriver = countBy(events, (event) => event.driver?.name ?? 'Unassigned');
      return [
        `Total: ${events.length}`,
        ...topLines(byBehavior),
        '',
        'Top drivers by event count:',
        ...topLines(byDriver, 5),
      ];
    }),
  );

  sections.push(
    await section('Inspections', '🔧', async () => {
      const dvirs = await client.listDvirs(window.start, window.end);
      const preTrips = dvirs.filter(isPreTrip).length;
      const withDefects = dvirs.filter((dvir) => unresolvedDefects(dvir) > 0).length;
      return [
        `• DVIRs submitted: ${dvirs.length}`,
        `• Pre-trip: ${preTrips}`,
        `• With open defects: ${withDefects}`,
      ];
    }),
  );

  sections.push(
    await section('Hours of service', '⏱️', async () => {
      const violations = await client.listHosViolations(window.start, window.end);
      if (!violations.length) return ['No HOS violations. ✅'];
      const byType = countBy(violations, (violation) => violation.violationType ?? 'Unknown');
      return [`Total: ${violations.length}`, ...topLines(byType)];
    }),
  );

  sections.push(
    await section('Fleet', '🚛', async () => {
      const [vehicles, stats] = await Promise.all([
        client.listVehicles(),
        client.listVehicleStats(['engineStates', 'obdOdometerMeters']),
      ]);
      const running = stats.filter(
        (stat) => (stat.engineStates?.value ?? '').toLowerCase() === 'running',
      ).length;
      const odometers = stats
        .map((stat) => metersToMiles(stat.obdOdometerMeters?.value))
        .filter((miles): miles is number => miles !== undefined);
      const lines = [`• Vehicles: ${vehicles.length}`, `• Engines running right now: ${running}`];
      if (odometers.length) {
        const total = odometers.reduce((sum, miles) => sum + miles, 0);
        lines.push(`• Fleet odometer total: ${Math.round(total).toLocaleString('en-US')} mi`);
      }
      return lines;
    }),
  );

  return renderDigest(
    `Daily fleet digest — ${formatDate(window.start, config.timezone)}`,
    sections,
  );
}
