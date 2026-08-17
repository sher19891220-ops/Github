/**
 * Partial models of the Samsara REST payloads this bot touches.
 *
 * Deliberately loose: Samsara adds fields over time and different orgs get
 * different optional blocks, so every consumer treats absence as normal.
 */

export interface Paginated<T> {
  data: T[];
  pagination?: {
    endCursor?: string;
    hasNextPage?: boolean;
  };
}

export interface SamsaraRef {
  id: string;
  name?: string;
}

export interface Vehicle extends SamsaraRef {
  vin?: string;
  licensePlate?: string;
  make?: string;
  model?: string;
  year?: string;
  serial?: string;
  staticAssignedDriver?: SamsaraRef;
}

export interface Driver extends SamsaraRef {
  username?: string;
  phone?: string;
  licenseNumber?: string;
  licenseState?: string;
  driverActivationStatus?: string;
  tags?: SamsaraRef[];
}

export interface GpsReading {
  time?: string;
  latitude?: number;
  longitude?: number;
  headingDegrees?: number;
  speedMilesPerHour?: number;
  reverseGeo?: { formattedLocation?: string };
  address?: { id?: string; name?: string };
  isEcuSpeed?: boolean;
}

export interface VehicleStats extends SamsaraRef {
  gps?: GpsReading;
  engineStates?: { time?: string; value?: string };
  fuelPercents?: { time?: string; value?: number };
  obdOdometerMeters?: { time?: string; value?: number };
  obdEngineSeconds?: { time?: string; value?: number };
}

export interface BehaviorLabel {
  /** Machine-ish key, e.g. "mobileUsage". Not always present. */
  label?: string;
  /** Human label, e.g. "Mobile Usage". */
  name?: string;
}

export interface SafetyEvent {
  id?: string;
  time?: string;
  vehicle?: SamsaraRef;
  driver?: SamsaraRef;
  behaviorLabels?: BehaviorLabel[];
  location?: string;
  latitude?: number;
  longitude?: number;
  speedMilesPerHour?: number;
  maxAccelerationGForce?: number;
  driverId?: string;
  vehicleId?: string;
  coachingState?: string;
  downloadForwardVideoUrl?: string;
  downloadInwardVideoUrl?: string;
  downloadTriggerVideoUrl?: string;
}

export interface DvirDefect {
  id?: string;
  comment?: string;
  isResolved?: boolean;
  defectType?: string;
  trailer?: SamsaraRef;
  vehicle?: SamsaraRef;
  mechanicNotes?: string;
}

export interface Dvir {
  id?: string;
  vehicle?: SamsaraRef;
  trailer?: SamsaraRef;
  driver?: SamsaraRef;
  /** "safe" | "unsafe" | "resolved" */
  safetyStatus?: string;
  /** "preTrip" | "postTrip" | "mechanic" | "adhoc" */
  inspectionType?: string;
  startTime?: string;
  endTime?: string;
  defects?: DvirDefect[];
  odometerMeters?: number;
  authorSignature?: { type?: string; signedAtTime?: string; user?: SamsaraRef };
  mechanicNotes?: string;
}

export interface HosClock {
  driver?: SamsaraRef;
  clocks?: {
    drive?: { driveRemainingDurationMs?: number };
    shift?: { shiftRemainingDurationMs?: number };
    cycle?: { cycleRemainingDurationMs?: number };
    break?: { timeUntilBreakDurationMs?: number };
  };
}

export interface HosViolation {
  driver?: SamsaraRef;
  violationType?: string;
  violationStartTime?: string;
  violationEndTime?: string;
  durationMs?: number;
}

/** Envelope Samsara POSTs to a configured webhook. */
export interface SamsaraWebhookPayload {
  eventId?: string;
  eventType?: string;
  eventTime?: string;
  happenedAtTime?: string;
  orgId?: number | string;
  webhookId?: string;
  data?: Record<string, unknown>;
  /** Alert webhooks nest their detail here. */
  event?: Record<string, unknown>;
}
