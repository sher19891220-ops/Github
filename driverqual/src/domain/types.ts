import type { IsoDate } from './dates';

/* ------------------------------------------------------------------ *
 * Coverage
 * ------------------------------------------------------------------ */

export const COVERAGE_TYPES = [
  'Auto Liability',
  'General Liability',
  'Cargo',
  'Trailer Interchange',
  'Physical Damage',
  'Workers Compensation',
  'Occupational Accident Insurance',
  'Bobtail / Non-Trucking Liability',
] as const;

export type CoverageType = (typeof COVERAGE_TYPES)[number];

/** The single coverage that controls the driver-level decision. */
export const CONTROLLING_COVERAGE: CoverageType = 'Auto Liability';

/**
 * Legacy and carrier-specific labels seen on real COIs and guideline packets,
 * mapped onto the canonical coverage names above.
 */
const COVERAGE_ALIASES: Record<string, CoverageType> = {
  'motor truck cargo': 'Cargo',
  'motor truck cargo legal liability': 'Cargo',
  'mtc': 'Cargo',
  'cargo legal liability': 'Cargo',
  'auto liability': 'Auto Liability',
  'automobile liability': 'Auto Liability',
  'commercial auto liability': 'Auto Liability',
  'al': 'Auto Liability',
  'general liability': 'General Liability',
  'commercial general liability': 'General Liability',
  'cgl': 'General Liability',
  'gl': 'General Liability',
  'trailer interchange': 'Trailer Interchange',
  'ti': 'Trailer Interchange',
  'physical damage': 'Physical Damage',
  'phys dam': 'Physical Damage',
  'pd': 'Physical Damage',
  'workers compensation': 'Workers Compensation',
  "workers' compensation": 'Workers Compensation',
  'workers comp': 'Workers Compensation',
  'wc': 'Workers Compensation',
  'occupational accident': 'Occupational Accident Insurance',
  'occupational accident insurance': 'Occupational Accident Insurance',
  'occ acc': 'Occupational Accident Insurance',
  'bobtail': 'Bobtail / Non-Trucking Liability',
  'non-trucking liability': 'Bobtail / Non-Trucking Liability',
  'non trucking liability': 'Bobtail / Non-Trucking Liability',
  'ntl': 'Bobtail / Non-Trucking Liability',
  'bobtail / non-trucking liability': 'Bobtail / Non-Trucking Liability',
};

/** Returns the canonical coverage name, or null when the label is unrecognised. */
export function normalizeCoverageType(raw: string): CoverageType | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if ((COVERAGE_TYPES as readonly string[]).includes(raw.trim())) {
    return raw.trim() as CoverageType;
  }
  return COVERAGE_ALIASES[key] ?? null;
}

/* ------------------------------------------------------------------ *
 * Decision statuses
 * ------------------------------------------------------------------ */

export const DECISIONS = [
  'Qualified',
  'Not Qualified',
  'Manual Review',
  'Not Evaluated',
] as const;

export type Decision = (typeof DECISIONS)[number];

/* ------------------------------------------------------------------ *
 * MVR evidence
 * ------------------------------------------------------------------ */

export type EventType = 'Moving Violation' | 'Administrative' | 'Accident' | 'Unknown';

/**
 * Severity tiers for moving violations. `Unknown` means the description did not
 * match any classification rule — it is never silently treated as minor.
 */
export type ViolationSeverity = 'Major' | 'Serious' | 'Minor' | 'Unknown';

export type LicenseStatus =
  | 'Valid'
  | 'Expired'
  | 'Suspended'
  | 'Revoked'
  | 'Disqualified'
  | 'Unknown';

/** Which uploaded document a record or field came from. */
export type SourceDocument = 'CDL' | 'MVR' | 'PSP' | 'Other';

/**
 * Why an event was classified as a major violation.
 *
 * A major classification may only stand when all three are present: the exact
 * record text, the category it was matched to, and the guideline wording that
 * authorises the mapping. Without those, an ambiguous offence stays minor.
 */
export interface MajorClassification {
  eventDescription: string;
  matchedCategory: string;
  guidelineReference: string;
}

export interface MvrEvent {
  id: string;
  /** Verbatim text from the MVR or PSP. Never rewritten, never summarised. */
  description: string;
  violationDate: IsoDate | null;
  convictionDate: IsoDate | null;
  state: string | null;
  statePoints: number | null;
  mvrActivityPoints: number | null;
  disposition: string | null;
  /** Set by the classifier, or overridden by a reviewer. */
  eventType: EventType;
  severity: ViolationSeverity;
  /** True only when a reviewer explicitly confirmed the classification. */
  reviewerConfirmed?: boolean;
  /** Present on accident records only; never inferred from a description. */
  atFault?: boolean | null;
  preventable?: boolean | null;
  /** Which document this record came from. Defaults to MVR. */
  source?: SourceDocument;
  /**
   * PSP roadside inspections. They are records of an inspection taking place,
   * not convictions, and never count toward a violation threshold.
   */
  isInspection?: boolean;
  /** Set only when a guideline explicitly authorises a major classification. */
  majorClassification?: MajorClassification | null;
}

/**
 * One date that could be the original CDL issue date, with enough provenance to
 * choose between candidates and to show a reviewer why one was chosen.
 *
 * An MVR commonly prints the most recent state issuance or transfer date. Held
 * as a bare date it is indistinguishable from an original issue date, and
 * choosing it silently costs a driver years of credited experience — which is
 * why the label and the source are carried alongside the date itself.
 */
export interface CdlIssueDateCandidate {
  date: IsoDate;
  sourceDocument: SourceDocument;
  /** The label exactly as printed, e.g. "ORIG ISS" or "STATE ISSUE DATE". */
  printedLabel: string;
  /** True only when the document itself says this is the first/original issue. */
  explicitlyOriginal: boolean;
}

/**
 * A suspension is only ever recorded when the source document carries an
 * explicit suspension/revocation record. It is never derived from a violation,
 * a fee, a court entry or a disposition.
 */
export interface SuspensionRecord {
  id: string;
  description: string;
  startDate: IsoDate | null;
  endDate: IsoDate | null;
  reinstatedDate: IsoDate | null;
  state: string | null;
  /** Provenance guard: only 'explicit_document_record' is admissible evidence. */
  source: 'explicit_document_record' | 'inferred';
}

export interface MedicalCardEvidence {
  present: boolean;
  expirationDate: IsoDate | null;
  examinerName: string | null;
}

/* ------------------------------------------------------------------ *
 * Extraction envelope
 * ------------------------------------------------------------------ */

/**
 * Bumped whenever the extraction contract changes in a way that makes older
 * stored evidence unsafe to evaluate. Evidence below this version is forced to
 * Manual Review until the documents are re-read.
 */
export const CURRENT_EXTRACTION_FORMAT_VERSION = 4;

/** Field-level confidence below this makes a dependent condition indeterminate. */
export const MIN_FIELD_CONFIDENCE = 0.8;

/** An MVR older than this many days is stale evidence. */
export const MVR_STALENESS_DAYS = 90;

export interface FieldConfidence {
  [field: string]: number;
}

export interface DriverEvidence {
  extractionFormatVersion: number;
  /** The MVR's own order/report date — the anchor for every MVR lookback. */
  mvrOrderDate: IsoDate | null;
  dateOfBirth: IsoDate | null;
  cdlNumber: string | null;
  cdlState: string | null;
  cdlClass: string | null;
  /**
   * The resolved first/original CDL issue date. Never a renewal, duplicate or
   * expiry date. When `cdlIssueDateCandidates` is populated this is derived from
   * them by `resolveOriginalIssueDate`, not entered independently.
   */
  cdlOriginalIssueDate: IsoDate | null;
  /** Every issue date found across the uploaded documents, with provenance. */
  cdlIssueDateCandidates: CdlIssueDateCandidate[];
  /** Kept for display and audit only — never used to compute experience. */
  cdlCurrentIssueDate: IsoDate | null;
  cdlExpirationDate: IsoDate | null;
  licenseStatus: LicenseStatus;
  medicalCard: MedicalCardEvidence | null;
  events: MvrEvent[];
  suspensions: SuspensionRecord[];
  /** Experience typed in by staff. Ignored whenever the original date exists. */
  reportedExperienceMonths: number | null;
  confidence: FieldConfidence;
  warnings: string[];
}

export function emptyEvidence(): DriverEvidence {
  return {
    extractionFormatVersion: CURRENT_EXTRACTION_FORMAT_VERSION,
    mvrOrderDate: null,
    cdlIssueDateCandidates: [],
    dateOfBirth: null,
    cdlNumber: null,
    cdlState: null,
    cdlClass: null,
    cdlOriginalIssueDate: null,
    cdlCurrentIssueDate: null,
    cdlExpirationDate: null,
    licenseStatus: 'Unknown',
    medicalCard: null,
    events: [],
    suspensions: [],
    reportedExperienceMonths: null,
    confidence: {},
    warnings: [],
  };
}
