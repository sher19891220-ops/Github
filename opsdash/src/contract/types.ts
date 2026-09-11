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

/**
 * How a number got here.
 *
 * `manual` is not a loophole in the provenance rule, it is the rule
 * applied honestly to a case the others could not express: a person typed
 * this, and the evidence is their named attestation on a stated basis
 * rather than a file. That is weaker evidence than a parsed invoice, and
 * every screen showing a manual figure says so instead of letting it pass
 * for the same thing.
 */
export type SourceKind = 'document' | 'connector' | 'derived' | 'manual' | 'adjustment';

/** The four ways a figure can enter the system — every source supports all
 *  four, and a row remembers which one it came in through. */
export type IntakeMethod = 'upload' | 'manual' | 'sheet' | 'api';

/** Provenance for a typed figure. Weaker than a document, stored as a
 *  different thing so it can be rendered as weaker. */
export interface ManualAttestation {
  attestationId: string;
  /** A person who can be asked about this later. Never a service account. */
  assertedBy: string;
  assertedAt: string;
  /** What they are going on — "shop quoted by phone", "driver texted the
   *  odometer". Required: a figure with no stated basis is a guess with a
   *  name attached. */
  basis: string;
  /** Set when a real document later proves the same fact. The attestation
   *  survives, because "we believed X, then the invoice said Y" is exactly
   *  what a reconciliation needs. */
  supersededByDocumentId: string | null;
  supersededAt: string | null;
}

/** What a truck is doing. The fleet board's missing source. */
export type TruckStatus =
  | 'assigned' | 'open' | 'shop' | 'broken_down' | 'home' | 'out_of_service';

/** Where a status came from. Telematics, a sheet, or a person. */
export type StatusSource = 'samsara' | 'motive' | 'manual' | 'sheet';

export interface TruckStatusNow {
  truckId: string;
  status: TruckStatus;
  effectiveFrom: string;
  source: StatusSource;
  note: string | null;
  /** Hours in the current state — what the board's "Ready 24+" and
   *  "Home 48+" timers are built from. */
  hoursInStatus: number;
}
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

/**
 * What kind of account a category is — `accounting.category.account_nature`.
 *
 * `balance_sheet` rows are money moving between an asset and a liability,
 * not money spent: a prepaid registration payment whose real cost is
 * recognized monthly, a loan principal repayment (only the interest is a
 * cost), a receivable. They are excluded from a P&L at every grain.
 *
 * `intercompany` legs are real on one entity's books and eliminated in a
 * group roll-up — a transfer between two group entities proves a
 * relationship, never a reason.
 */
export type AccountNature = 'pnl' | 'balance_sheet' | 'intercompany';

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
  /** A person typed this. The evidence is their named attestation on a
   *  stated basis, which is weaker than a document and must render as
   *  weaker rather than passing for the same thing. */
  | { kind: 'manual'; attestationId: string }
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

/* ------------------------------------------------------------------------
 * Reconciliation.
 *
 * Promoted from the UI workstream's local types after the endpoints were
 * built, so the two sides cannot drift. Four things that workstream
 * correctly declined to decide alone, now decided:
 *
 *  - The ledger side of a reconciliation is posted `ledger_entry` rows for
 *    the run's period. `accounting.reconciliation_match` references a
 *    staging row and a ledger entry and nothing else, so that is what the
 *    schema can actually store. `sourceRef.kind === 'sheet'` remains in the
 *    type because a sheet-side reconciliation is a real future case, but no
 *    endpoint emits it today.
 *  - `near_match` is derived, not stored: `auto_matched` with a non-zero
 *    variance. "The matcher paired these and no human has looked" is true
 *    of an exact and an inexact pairing alike; the variance is the thing
 *    that separates them, and it is already a column.
 * --------------------------------------------------------------------- */

/** Where a reconciliation line traces to. Every row on the screen must be
 *  explicable without leaving it. */
export type ReconSourceRef =
  | { kind: 'document'; documentId: string; stagingRowId: string | null; label: string }
  | { kind: 'ledger'; entryId: string; label: string }
  | { kind: 'sheet'; label: string; rowRef: string };

export interface ReconLine {
  lineId: string;
  side: 'document' | 'ledger';
  sourceRef: ReconSourceRef;
  truckId: string | null;
  driverId: string | null;
  accrualDate: IsoDate | null;
  /** Signed, same convention as `LedgerEntry.amount`. */
  amount: Decimal;
  quantity: Decimal | null;
  description: string | null;
}

export type ReconMatchStatus =
  /** Same amount, date and unit — unambiguous, shown collapsed by default. */
  | 'auto_matched'
  /** Same unit and date, amount differs — the case that needs a human. */
  | 'near_match'
  /** A human looked at an auto/near match and confirmed it. */
  | 'confirmed'
  /** A human rejected the pairing; both lines fall back to unmatched. */
  | 'rejected'
  /** No partner, and a human has recorded why that is expected. The
   *  database refuses this status without a reason. */
  | 'expected_missing'
  /** No partner, not yet looked at. */
  | 'unmatched';

/** A pairing (both lines set) or a singleton (exactly one) — never neither. */
export interface ReconMatch {
  matchId: string;
  status: ReconMatchStatus;
  documentLine: ReconLine | null;
  ledgerLine: ReconLine | null;
  /** `document - ledger` for a pairing; null for a singleton. */
  amountVariance: Decimal | null;
  note: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface ReconSummary {
  autoMatched: number;
  nearMatch: number;
  confirmed: number;
  unmatchedDocument: number;
  unmatchedLedger: number;
  expectedMissing: number;
  rejected: number;
  /** Everything a person still has to account for: the variance on open
   *  pairings plus every unmatched line on either side. Confirmed pairings
   *  and expected-missing lines are settled and drop out. */
  netVariance: Decimal;
}

export interface ReconciliationSet {
  reconciliationId: string;
  documentId: string;
  documentLabel: string;
  ledgerLabel: string;
  matches: ReconMatch[];
}

/** The statuses a person can actually set. `auto_matched` and `near_match`
 *  are the matcher's output, not a human decision. */
export type ReconDecisionStatus = 'confirmed' | 'rejected' | 'expected_missing';

/* ------------------------------------------------------------------------
 * Chargeback.
 * --------------------------------------------------------------------- */

export type ChargedTo = 'company' | 'driver' | 'split' | 'unknown';

/** A `split` is not a decision without a ratio — this is what makes that
 *  true in the type system as well as in the database. */
export interface SplitRatio {
  kind: 'amount' | 'percentage';
  /** The driver's share. A money decimal for `amount` (the company bears
   *  the remainder of the row's absolute amount); a decimal in (0, 100)
   *  for `percentage`. */
  driverShare: Decimal;
}

export interface ChargebackDecision {
  chargedTo: ChargedTo;
  /** Required when, and only when, `chargedTo === 'split'`. */
  splitRatio: SplitRatio | null;
  note: string | null;
  decidedBy: string;
  decidedAt: string;
}

/** One cost row needing, or already given, a chargeback decision.
 *  `costRowId` is a `staging_row_id`. */
export interface ChargebackRow {
  costRowId: string;
  sourceRef:
    | { kind: 'document'; documentId: string; stagingRowId: string | null; label: string }
    | { kind: 'sheet'; label: string; rowRef: string };
  truckId: string | null;
  driverId: string | null;
  driverClass: DriverClass | null;
  vendor: string | null;
  description: string | null;
  accrualDate: IsoDate | null;
  /** Signed; a cost row is negative. */
  amount: Decimal;
  categoryId: string | null;
  /** What the parser produced. Null and `'unknown'` both mean undecided. */
  chargedTo: ChargedTo;
  /** The decision currently standing, i.e. the one nothing supersedes. */
  decision: ChargebackDecision | null;
}
