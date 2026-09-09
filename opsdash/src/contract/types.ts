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
export type DocType = 'fuel' | 'toll' | 'maintenance';
export type StagingStatus = 'parsed' | 'under_review' | 'committed' | 'rejected';
export type DriverClass = 'lease_to_own' | 'company' | 'owner_operator' | 'unassigned';
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
