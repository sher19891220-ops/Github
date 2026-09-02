import type { Dvir, SafetyEvent, SamsaraRef, SamsaraWebhookPayload } from './types';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity as Severity] ?? 0;
}

export interface BehaviorSpec {
  key: string;
  title: string;
  emoji: string;
  severity: Severity;
  /** Normalised spellings seen across the API, webhooks and the Samsara UI. */
  aliases: string[];
}

/** Lowercases and drops punctuation so "No Seat Belt" === "noSeatbelt". */
export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const BEHAVIORS: BehaviorSpec[] = [
  {
    key: 'crash',
    title: 'Crash detected',
    emoji: '🚨',
    severity: 'critical',
    aliases: ['crash', 'crashdetected', 'collision', 'accident', 'vehiclecrash', 'severecrash'],
  },
  {
    key: 'rollover',
    title: 'Rollover detected',
    emoji: '🚨',
    severity: 'critical',
    aliases: ['rollover', 'vehiclerollover'],
  },
  {
    key: 'panicButton',
    title: 'Panic button pressed',
    emoji: '🆘',
    severity: 'critical',
    aliases: ['panicbutton', 'panic', 'sos', 'emergency'],
  },
  {
    key: 'forwardCollisionWarning',
    title: 'Forward collision warning',
    emoji: '⚠️',
    severity: 'high',
    aliases: ['forwardcollisionwarning', 'fcw', 'imminentcollision', 'nearcollision'],
  },
  {
    key: 'mobileUsage',
    title: 'Mobile phone usage',
    emoji: '📱',
    severity: 'high',
    aliases: [
      'mobileusage',
      'mobiledeviceusage',
      'mobilephoneusage',
      'cellphone',
      'cellphoneusage',
      'phoneusage',
      'handheldphone',
      'texting',
    ],
  },
  {
    key: 'distractedDriving',
    title: 'Distracted driving',
    emoji: '👀',
    severity: 'high',
    aliases: [
      'distracteddriving',
      'distraction',
      'driverdistraction',
      'inattentivedriving',
      'eyesofftheroad',
    ],
  },
  {
    key: 'drowsy',
    title: 'Drowsy driving',
    emoji: '😴',
    severity: 'high',
    aliases: ['drowsy', 'drowsydriving', 'drowsiness', 'fatigue', 'microsleep'],
  },
  {
    key: 'noSeatbelt',
    title: 'Seat belt not worn',
    emoji: '🔒',
    severity: 'high',
    aliases: ['noseatbelt', 'seatbelt', 'seatbeltviolation', 'unbuckled', 'nosafetybelt'],
  },
  {
    key: 'severeSpeeding',
    title: 'Severe speeding',
    emoji: '🏎️',
    severity: 'high',
    aliases: ['severespeeding', 'extremespeeding', 'speedingsevere', 'egregiousspeeding'],
  },
  {
    key: 'hosViolation',
    title: 'Hours-of-service violation',
    emoji: '⏱️',
    severity: 'high',
    aliases: ['hosviolation', 'hoursofservice', 'hosviolationdetected', 'drivetimeviolation'],
  },
  {
    key: 'speeding',
    title: 'Speeding',
    emoji: '🚦',
    severity: 'medium',
    aliases: ['speeding', 'overspeeding', 'speedlimitviolation', 'speedingviolation', 'moderatespeeding'],
  },
  {
    key: 'unassignedDriving',
    title: 'Unassigned / unattended driving',
    emoji: '🕵️',
    severity: 'medium',
    aliases: [
      'unassigneddriving',
      'unattendeddriving',
      'unidentifieddriving',
      'nodriverassigned',
      'unassignedhos',
    ],
  },
  {
    key: 'harshBrake',
    title: 'Harsh braking',
    emoji: '🛑',
    severity: 'medium',
    aliases: ['harshbrake', 'harshbraking', 'harshdeceleration', 'hardbrake'],
  },
  {
    key: 'harshAccel',
    title: 'Harsh acceleration',
    emoji: '⚡',
    severity: 'medium',
    aliases: ['harshaccel', 'harshacceleration', 'hardaccel'],
  },
  {
    key: 'harshTurn',
    title: 'Harsh turn',
    emoji: '↩️',
    severity: 'medium',
    aliases: ['harshturn', 'harshcornering', 'hardturn'],
  },
  {
    key: 'rollingStop',
    title: 'Rolling stop',
    emoji: '🛑',
    severity: 'medium',
    aliases: ['rollingstop', 'didnotstop', 'ranstopsign', 'stopsignviolation'],
  },
  {
    key: 'tailgating',
    title: 'Tailgating',
    emoji: '🚙',
    severity: 'medium',
    aliases: ['tailgating', 'followingdistance', 'followingtooclose', 'closefollowing'],
  },
  {
    key: 'laneDeparture',
    title: 'Lane departure',
    emoji: '🛣️',
    severity: 'medium',
    aliases: ['lanedeparture', 'unsafelanechange', 'lanedrift'],
  },
  {
    key: 'engineFault',
    title: 'Engine fault',
    emoji: '🔧',
    severity: 'medium',
    aliases: ['enginefault', 'faultcode', 'dtc', 'checkengine', 'vehiclefault', 'defectivevehicle'],
  },
  {
    key: 'dvirDefect',
    title: 'DVIR defect reported',
    emoji: '🔧',
    severity: 'medium',
    aliases: ['dvir', 'dvirsubmitted', 'dvirdefect', 'unsafedvir', 'inspectiondefect'],
  },
  {
    key: 'cameraObstruction',
    title: 'Camera covered / obstructed',
    emoji: '📷',
    severity: 'high',
    aliases: [
      'cameracovered',
      'cameraclosed',
      'cameracoveredclosed',
      'cameraobstruction',
      'obstructedcamera',
      'cameratampering',
      'camerablocked',
      'inwardcameraobstructed',
    ],
  },
  {
    key: 'smoking',
    title: 'Smoking in cab',
    emoji: '🚬',
    severity: 'low',
    aliases: ['smoking', 'smokingincab'],
  },
  {
    key: 'geofence',
    title: 'Geofence event',
    emoji: '📍',
    severity: 'low',
    aliases: ['geofenceentry', 'geofenceexit', 'geofence'],
  },
];

const BY_ALIAS = new Map<string, BehaviorSpec>();
for (const spec of BEHAVIORS) {
  BY_ALIAS.set(normalizeKey(spec.key), spec);
  for (const alias of spec.aliases) BY_ALIAS.set(alias, spec);
}

/** Turns "someUnknownThing" into "Some unknown thing" for the fallback title. */
function titleize(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!spaced) return 'Fleet event';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Maps any Samsara behaviour spelling onto a known spec. Unknown behaviours
 * still produce an alert — a silently dropped safety event is worse than an
 * imperfectly labelled one.
 */
export function classifyBehavior(input: string | undefined): BehaviorSpec {
  const normalized = normalizeKey(input ?? '');
  const exact = BY_ALIAS.get(normalized);
  if (exact) return exact;

  // Substring fallback catches compounds like "HarshEventSevereSpeeding".
  if (normalized) {
    let best: BehaviorSpec | undefined;
    let bestLength = 0;
    for (const [alias, spec] of BY_ALIAS) {
      if (alias.length > 4 && normalized.includes(alias) && alias.length > bestLength) {
        best = spec;
        bestLength = alias.length;
      }
    }
    if (best) return best;
  }

  return {
    key: normalized || 'unknown',
    title: titleize(input ?? 'Fleet event'),
    emoji: '🔔',
    severity: 'low',
    aliases: [],
  };
}

export interface AlertLink {
  label: string;
  url: string;
}

/** A Samsara clip to forward into Telegram, kept apart from ordinary links. */
export interface VideoRef {
  label: string;
  url: string;
}

export interface FleetAlert {
  /** Stable identity used for de-duplication. */
  fingerprint: string;
  behaviorKey: string;
  title: string;
  emoji: string;
  severity: Severity;
  occurredAt?: Date;
  /** Display name, e.g. "5269 (GZP5W69Z75) 281474991641331". */
  vehicle?: string;
  /** Samsara vehicle ID — the reliable key for per-unit chat routing. */
  vehicleId?: string;
  driver?: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  speedMph?: number;
  /** Deep link into the Samsara incident view. */
  incidentUrl?: string;
  /** Samsara's own event/incident ID, echoed so alerts can be cross-referenced. */
  eventId?: string;
  /** Extra "Label: value" lines rendered under the header. */
  details: string[];
  links: AlertLink[];
  videos: VideoRef[];
  source: 'webhook' | 'poll';
}

function refName(ref: SamsaraRef | undefined, fallbackId?: string): string | undefined {
  if (ref?.name) return ref.name;
  if (ref?.id) return `#${ref.id}`;
  if (fallbackId) return `#${fallbackId}`;
  return undefined;
}

function parseTime(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function pickHighestSeverity(specs: BehaviorSpec[]): BehaviorSpec {
  return specs.reduce((best, spec) =>
    severityRank(spec.severity) > severityRank(best.severity) ? spec : best,
  );
}

/** Converts a polled safety event into a single alert. */
export function fromSafetyEvent(event: SafetyEvent): FleetAlert {
  const labels = event.behaviorLabels?.length ? event.behaviorLabels : [{ name: 'Safety event' }];
  const specs = labels.map((label) => classifyBehavior(label.label ?? label.name));
  const primary = pickHighestSeverity(specs);

  const secondary = specs
    .filter((spec) => spec.key !== primary.key)
    .map((spec) => spec.title);

  const details: string[] = [];
  if (secondary.length) details.push(`Also flagged: ${[...new Set(secondary)].join(', ')}`);
  if (typeof event.maxAccelerationGForce === 'number') {
    details.push(`Peak force: ${event.maxAccelerationGForce.toFixed(2)} g`);
  }
  if (event.coachingState) details.push(`Coaching: ${titleize(event.coachingState)}`);

  const videos: VideoRef[] = [];
  if (event.downloadTriggerVideoUrl) {
    videos.push({ label: 'Trigger clip', url: event.downloadTriggerVideoUrl });
  }
  if (event.downloadForwardVideoUrl) {
    videos.push({ label: 'Road-facing', url: event.downloadForwardVideoUrl });
  }
  if (event.downloadInwardVideoUrl) {
    videos.push({ label: 'Driver-facing', url: event.downloadInwardVideoUrl });
  }

  const links: AlertLink[] = [];

  const occurredAt = parseTime(event.time);
  const identity =
    event.id ??
    [
      event.vehicle?.id ?? event.vehicleId ?? '',
      event.driver?.id ?? event.driverId ?? '',
      event.time ?? '',
      primary.key,
    ].join('|');

  return {
    fingerprint: `safety:${identity}`,
    behaviorKey: primary.key,
    title: primary.title,
    emoji: primary.emoji,
    severity: primary.severity,
    occurredAt,
    vehicle: refName(event.vehicle, event.vehicleId),
    vehicleId: event.vehicle?.id ?? event.vehicleId,
    driver: refName(event.driver, event.driverId),
    location: event.location,
    latitude: event.latitude,
    longitude: event.longitude,
    speedMph: event.speedMilesPerHour,
    eventId: event.id,
    details,
    links,
    videos,
    source: 'poll',
  };
}

/** Converts a submitted DVIR with defects (or an unsafe status) into an alert. */
export function fromDvir(dvir: Dvir): FleetAlert {
  const unresolved = (dvir.defects ?? []).filter((defect) => !defect.isResolved);
  const details: string[] = [];
  if (dvir.inspectionType) details.push(`Inspection: ${titleize(dvir.inspectionType)}`);
  if (dvir.safetyStatus) details.push(`Status: ${titleize(dvir.safetyStatus)}`);
  for (const defect of unresolved.slice(0, 5)) {
    const label = defect.defectType ? titleize(defect.defectType) : 'Defect';
    details.push(`• ${label}${defect.comment ? ` — ${defect.comment}` : ''}`);
  }
  if (unresolved.length > 5) details.push(`• …and ${unresolved.length - 5} more`);

  return {
    fingerprint: `dvir:${dvir.id ?? `${dvir.vehicle?.id ?? ''}|${dvir.endTime ?? ''}`}`,
    behaviorKey: 'dvirDefect',
    title: unresolved.length ? 'DVIR defects reported' : 'DVIR marked unsafe',
    emoji: '🔧',
    severity: 'high',
    occurredAt: parseTime(dvir.endTime ?? dvir.startTime),
    vehicle: refName(dvir.vehicle) ?? refName(dvir.trailer),
    vehicleId: dvir.vehicle?.id,
    driver: refName(dvir.driver),
    details,
    links: [],
    videos: [],
    source: 'poll',
  };
}

/**
 * Converts a Samsara webhook envelope into an alert.
 *
 * Samsara nests the interesting fields differently per event type (and adds new
 * types over time), so this flattens the plausible containers and reads from
 * the merged view rather than hard-coding one shape.
 */
export function fromWebhook(payload: SamsaraWebhookPayload): FleetAlert | undefined {
  if (!payload || typeof payload !== 'object') return undefined;

  const merged: Record<string, unknown> = {
    ...(payload as Record<string, unknown>),
    ...(payload.event ?? {}),
    ...(payload.data ?? {}),
  };

  const nestedDetails = merged['details'];
  if (nestedDetails && typeof nestedDetails === 'object') {
    Object.assign(merged, nestedDetails as Record<string, unknown>);
  }

  const behaviorSource =
    (typeof merged['behaviorLabel'] === 'string' && merged['behaviorLabel']) ||
    (typeof merged['alertConditionType'] === 'string' && merged['alertConditionType']) ||
    (typeof merged['configurationType'] === 'string' && merged['configurationType']) ||
    (typeof merged['eventType'] === 'string' && merged['eventType']) ||
    payload.eventType;

  const behaviorLabels = merged['behaviorLabels'];
  const labelSpecs = Array.isArray(behaviorLabels)
    ? behaviorLabels.map((label) => {
        const record = label as { label?: string; name?: string };
        return classifyBehavior(record?.label ?? record?.name);
      })
    : [];
  const spec = labelSpecs.length
    ? pickHighestSeverity(labelSpecs)
    : classifyBehavior(typeof behaviorSource === 'string' ? behaviorSource : undefined);

  const vehicle = merged['vehicle'] as SamsaraRef | undefined;
  const driver = merged['driver'] as SamsaraRef | undefined;
  const latitude = merged['latitude'];
  const longitude = merged['longitude'];

  const links: AlertLink[] = [];
  const incidentUrl = [merged['incidentUrl'], merged['dashboardUrl'], merged['url']].find(
    (value): value is string => typeof value === 'string' && value.startsWith('http'),
  );

  const videos: VideoRef[] = [];
  for (const [key, label] of [
    ['downloadTriggerVideoUrl', 'Trigger clip'],
    ['downloadForwardVideoUrl', 'Road-facing'],
    ['downloadInwardVideoUrl', 'Driver-facing'],
  ] as const) {
    const url = merged[key];
    if (typeof url === 'string' && url.startsWith('http')) videos.push({ label, url });
  }

  const details: string[] = [];
  const alertName = merged['alertConfigurationName'] ?? merged['name'];
  if (typeof alertName === 'string' && normalizeKey(alertName) !== normalizeKey(spec.title)) {
    details.push(`Alert: ${alertName}`);
  }
  const address = merged['address'];
  if (address && typeof address === 'object' && typeof (address as SamsaraRef).name === 'string') {
    details.push(`Address: ${(address as SamsaraRef).name}`);
  }

  const occurredAt =
    parseTime(payload.happenedAtTime) ?? parseTime(payload.eventTime) ?? parseTime(merged['time']);

  const formattedLocation = merged['formattedLocation'] ?? merged['location'];

  return {
    fingerprint: `webhook:${
      payload.eventId ??
      [payload.eventType ?? '', vehicle?.id ?? '', driver?.id ?? '', occurredAt?.toISOString() ?? '']
        .join('|')
    }`,
    behaviorKey: spec.key,
    title: spec.title,
    emoji: spec.emoji,
    severity: spec.severity,
    occurredAt,
    vehicle: refName(vehicle),
    vehicleId: vehicle?.id,
    driver: refName(driver),
    location: typeof formattedLocation === 'string' ? formattedLocation : undefined,
    latitude: typeof latitude === 'number' ? latitude : undefined,
    longitude: typeof longitude === 'number' ? longitude : undefined,
    incidentUrl,
    eventId: payload.eventId,
    speedMph:
      typeof merged['speedMilesPerHour'] === 'number'
        ? (merged['speedMilesPerHour'] as number)
        : undefined,
    details,
    links,
    videos,
    source: 'webhook',
  };
}

export interface DeliveryPolicy {
  /** Allow-list of behaviour keys. Empty means "everything". */
  behaviors: string[];
  minSeverity: string;
}

/** Applies the ALERT_BEHAVIORS / ALERT_MIN_SEVERITY filters. */
export function shouldDeliver(alert: FleetAlert, policy: DeliveryPolicy): boolean {
  if (severityRank(alert.severity) < severityRank(policy.minSeverity)) return false;
  if (!policy.behaviors.length) return true;
  const allowed = new Set(policy.behaviors.map(normalizeKey));
  return allowed.has(normalizeKey(alert.behaviorKey));
}
