/**
 * Shared contract types — the field names every Phase 2+ agent builds against.
 *
 * Mirrors docs/DATA-CONTRACT.md §6 and db/migrations/001_accounting_core.sql.
 * Money and quantities cross the wire as decimal STRINGS. A JSON number is an
 * IEEE double, and 0.1 + 0.2 is not 0.3; a ledger that rounds differently from
 * the database it was read out of is worse than no ledger.
 */

/** A signed exact decimal, e.g. "-812.44". Never a JS number. */
export type Decimal = string;

/** ISO calendar date, YYYY-MM-DD. */
export type IsoDate = string;

export type SourceKind = 'document' | 'connector' | 'derived' | 'adjustment';
/**
 * Mirrors `accounting.doc_type`. This list had drifted behind the database —
 * `ifta_mileage` and `revenue` landed in migration 002 and never reached here,
 * and `registration` was missing from the enum itself, which is why a
 * registration PDF could not be uploaded at all despite its parser working.
 */
export type DocType =
  | 'fuel' | 'toll' | 'maintenance' | 'ifta_mileage' | 'revenue'
  | 'registration' | 'factoring' | 'loan_schedule';
export type StagingStatus = 'parsed' | 'under_review' | 'committed' | 'rejected';
/**
 * The arrangement a truck runs under. Four, not three: lease-to-walk-away is
 * a fixed weekly rate plus a per-mile charge where the driver never acquires
 * the truck — neither lease-to-own (no equity accrues) nor owner-operator
 * (the group still holds title and carries the equipment).
 *
 * These populations are NOT comparable on any cost line the arrangement
 * itself determines. On an owner-operator truck the company's margin is the
 * company charge plus the fuel-discount margin and nothing else; fuel and
 * rent sit in the driver's deductions, not the company's cost side.
 */
export type DriverClass =
  | 'lease_to_own' | 'company' | 'owner_operator' | 'ltwa' | 'unassigned';

/**
 * Where a booked invoice actually got to. Booked gross is not collected cash,
 * and this is not a binary: `funded` means the factor advanced against the
 * invoice and the debtor has NOT paid, so a different party carries the risk
 * today. Never sum `funded` and `paid` as though both were settled.
 *
 * Absence of a status is unknown, never `paid` and never zero.
 */
export type CollectionStatus =
  | 'unsubmitted' | 'submitted' | 'funded' | 'paid'
  | 'short_paid' | 'denied' | 'recoursed' | 'rejected';

/**
 * How a cost behaves when the truck runs more, or stops. Conflating the three
 * is the most common way to produce a wrong break-even number.
 */
export type CostShape = 'fixed' | 'variable_per_mile' | 'variable_pct_of_gross';

/**
 * What a rate is measured against. Insurance alone is priced on five of these
 * within one policy set, which is why a single blended "insurance per truck"
 * misprices exactly the trucks it matters most for — the idle ones.
 */
export type CostBasis =
  | 'per_unit' | 'per_value' | 'per_gross_dollar'
  | 'per_mile' | 'per_enrollee' | 'per_period';

/** A contractual rate and a measured one are different facts. Keep both. */
export type RateKind = 'stated' | 'measured';
export type Grain = 'day' | 'week' | 'month' | 'quarter' | 'year';

export type CategoryGroup =
  | 'revenue' | 'fuel' | 'toll' | 'maintenance' | 'permit'
  | 'ifta' | 'insurance' | 'driver_pay' | 'lease' | 'other_cost';

export interface StagingRow {
  stagingRowId: string;
  documentId: string;
  rowIndex: number;
  sourcePage: number | null;
  /** Exactly what the parser read. Never mutated. */
  parsedPayload: Record<string, unknown>;
  /** The operator's edits, if any. */
  reviewedPayload: Record<string, unknown> | null;
  entityId: string | null;
  truckId: string | null;
  driverId: string | null;
  accrualDate: IsoDate | null;
  categoryId: string | null;
  amount: Decimal | null;
  quantity: Decimal | null;
  /** Two-letter purchase/travel state. IFTA depends on this being populated. */
  jurisdiction: string | null;
  status: StagingStatus;
  reviewNotes: string | null;
}

export interface PnlLine {
  grain: Grain;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  entityId: string | null;
  truckId: string | null;
  driverId: string | null;
  driverClass: DriverClass | null;
  categoryGroup: CategoryGroup;
  amount: Decimal;
  entryCount: number;
}

/**
 * Provenance, as a discriminated union. It mirrors the database's
 * `provenance_matches_kind` CHECK: a figure that cannot name its origin is
 * unrepresentable here, exactly as it is uninsertable there.
 */
export type Provenance =
  | { kind: 'document'; sourceDocumentId: string; stagingRowId: string | null }
  | { kind: 'connector'; connectorPullId: string }
  | { kind: 'derived'; calcRunId: string }
  | { kind: 'adjustment'; reversesEntryId: string };

export interface LedgerEntry {
  entryId: string;
  entityId: string;
  truckId: string | null;
  driverId: string | null;
  driverClass: DriverClass;
  accrualDate: IsoDate;
  categoryId: string;
  /** Signed: positive is an inflow, negative is an outflow. */
  amount: Decimal;
  currency: string;
  quantity: Decimal | null;
  jurisdiction: string | null;
  provenance: Provenance;
  memo: string | null;
  postedBy: string;
  postedAt: string;
}

const DECIMAL_RE = /^-?\d{1,12}(\.\d{1,4})?$/;

/** Guards the wire boundary: rejects JS numbers, exponent notation and NaN. */
export function isDecimal(value: unknown): value is Decimal {
  return typeof value === 'string' && DECIMAL_RE.test(value);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/* ------------------------------------------------------------------------
 * Additions closing gaps the review screens hit.
 *
 * The first pass at §6 specified the endpoints the ingestion flow needed and
 * missed the ones a usable screen needs around it: listing documents, the
 * shape of an edit, the option lists every picker requires, and a way to
 * serve the overhead rates the engine already computes. Each was flagged by
 * the UI workstream rather than invented locally, and is promoted here so
 * both sides build to one definition instead of two that drift.
 * --------------------------------------------------------------------- */

/** Mirrors `source_document.parse_status`'s CHECK constraint. */
export type ParseStatus = 'pending' | 'parsed' | 'failed';

export interface DocumentSummary {
  documentId: string;
  docType: DocType;
  fileName: string;
  parseStatus: ParseStatus;
  parseError: string | null;
  rowCount: number;
  uploadedAt: string;
  sha256: string;
  /** Set when an upload was a byte-identical repeat: reported, not re-ingested. */
  duplicateOf: string | null;
}

/**
 * Every field a human may change on a staging row before commit.
 *
 * Deliberately excludes `parsedPayload`. What the parser read is immutable;
 * an edit is expressed as `reviewedPayload` plus these normalized columns,
 * so the difference between the two remains visible afterwards.
 */
export interface StagingRowEdit {
  entityId: string | null;
  truckId: string | null;
  driverId: string | null;
  accrualDate: IsoDate | null;
  categoryId: string | null;
  amount: Decimal | null;
  quantity: Decimal | null;
  jurisdiction: string | null;
  reviewNotes: string | null;
}

export interface NamedOption {
  id: string;
  label: string;
  /** Inactive options still render so historical rows stay explicable, but
   *  must not be offered for new selections. */
  isActive: boolean;
}

/**
 * Categories carry their group and sign because the screen needs both: the
 * group drives which P&L line a row lands on, and the sign says whether a
 * positive amount is money in or money out. Without them the UI would have
 * to infer direction from the category name, which is how a cost eventually
 * gets rendered as revenue.
 */
export interface CategoryOption extends NamedOption {
  categoryGroup: CategoryGroup;
  sign: 1 | -1;
}

export interface ReferenceData {
  entities: NamedOption[];
  trucks: NamedOption[];
  drivers: NamedOption[];
  categories: CategoryOption[];
}
