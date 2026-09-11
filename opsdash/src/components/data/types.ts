/**
 * UI-side data shapes.
 *
 * `StagingRow`, `PnlLine`, `Decimal`, `LedgerEntry` come straight from
 * `@/contract/types` and are re-exported here for convenience — they are
 * NOT redefined.
 *
 * Everything else in this file is something the UI needs that
 * `docs/DATA-CONTRACT.md` §6 does not (yet) specify. Each is called out
 * below rather than silently invented as if it were load-bearing contract:
 *
 * 1. `ParseStatus` — the contract's `GET /api/documents/:id` returns a bare
 *    `parseStatus: string`. The actual value set lives in
 *    `db/migrations/001_accounting_core.sql`'s CHECK constraint
 *    ('pending' | 'parsed' | 'failed'), which DATA-CONTRACT.md §0 says wins
 *    on disagreement. Mirrored here, not invented.
 * 2. `DocumentSummary` / a list endpoint — §6 only specifies
 *    `GET /api/documents/:id` (singular). The "Document list" screen this
 *    build was asked for needs a `GET /api/documents` (plural) that returns
 *    `DocumentSummary[]`. That endpoint is not in the contract. This is
 *    flagged in the handoff report, not worked around silently — the shape
 *    below is the minimum the screen needs and mirrors the singular GET
 *    exactly, so adding the real route is additive, not a rework.
 * 3. `StagingRowEdit` — §6 says `PATCH /api/staging/:rowId` takes
 *    `Partial<StagingRowEdit>` but never defines `StagingRowEdit` itself.
 *    Defined here as the editable subset of `StagingRow`'s normalized
 *    fields (never `parsedPayload`, which is immutable by contract).
 * 4. Reference data (`entity`/`truck`/`driver`/`category` pickers) — the
 *    review table needs option lists for its selects. No `/api/entities`,
 *    `/api/trucks`, `/api/drivers` or `/api/categories` endpoint exists in
 *    §6. `ReferenceData` is this screen's minimum ask, flagged the same way.
 * 5. `TruckOverheadRate` (from `@/engines/registration/types` and
 *    `overheadRate.ts`) is a real, already-built engine output, but §6 has
 *    no endpoint that serves it to a browser. `getOverheadRates()` assumes
 *    a `GET /api/registration/overhead` this build does not own; flagged
 *    the same way rather than invented as if it were settled.
 * 6. Reconciliation — §6 has no `GET/POST /api/reconciliation*` route, and
 *    `fuel_reconciliation` (the one reconciliation table the migration
 *    does define, §4 table map) is an aggregate-per-truck-per-period
 *    gallons check, not the line-level "this document row vs. this
 *    ledger/sheet row" match the reconciliation screen needs. `ReconLine`,
 *    `ReconMatch` and `ReconciliationSet` below are this screen's minimum
 *    ask — flagged, not invented as settled. A real endpoint would need to
 *    decide where the "ledger side" of a match actually comes from (posted
 *    `ledger_entry` rows for a committed period, or the Google Sheet a
 *    document is being checked against before anything is posted); this
 *    build cannot decide that unilaterally and leaves both reachable
 *    through `sourceRef.kind`.
 * 7. Chargeback — the contract says `ledger_entry.charged_to` exists
 *    (§6 table map: "Ledger | `ledger_entry` (incl. `charged_to`,
 *    `unit_type`)"), but `db/migrations/001_accounting_core.sql`'s actual
 *    `CREATE TABLE accounting.ledger_entry` has neither column, and per
 *    DATA-CONTRACT.md §0 the migration wins on disagreement. There is also
 *    no `charged_to` on `staging_row`, and no endpoint to list cost rows
 *    still needing a chargeback decision or to record one. `ChargedTo`,
 *    `SplitRatio`, `ChargebackRow` and `ChargebackDecision` below are this
 *    screen's minimum ask. Flagged rather than silently added to the
 *    ledger schema, which is out of this workstream's files.
 *
 * Swapping the mock for the real API is meant to be a one-line change per
 * function in `api.ts` — these types are what both sides agree on today.
 */

import type { Decimal, DocType, DriverClass, IsoDate, ParseStatus } from '@/contract/types';

export type {
  StagingRow, PnlLine, LedgerEntry, Decimal, IsoDate, DocType,
  // Promoted into the contract after this workstream flagged them; imported
  // rather than redefined so the two sides cannot drift.
  ParseStatus, DocumentSummary, StagingRowEdit,
  NamedOption, CategoryOption, ReferenceData,
} from '@/contract/types';
export type { TruckOverheadRate } from '@/engines/registration/types';




export interface CommitResult {
  committed: number;
  rejected: number;
  entryIds: string[];
}

export interface UploadResult {
  documentId: string;
  sha256: string;
  duplicateOf: string | null;
}

/**
 * 8. `GET /api/documents/:id` (singular) returns a 5-field shape — see
 *    `src/db/repo/types.ts`'s `DocumentStatusSummary`, which the migration
 *    and the live route actually implement — deliberately narrower than the
 *    9-field `DocumentSummary` the plural list endpoint returns (no
 *    `fileName`/`uploadedAt`/`sha256`/`duplicateOf`). Redefined here rather
 *    than imported from `src/db/repo/**`, which is out of this workstream's
 *    files: the two must still agree structurally, which is what
 *    `tests/unit/components-data.test.ts` pins down.
 * 9. `POST /api/documents` requires `docType` on the multipart body (the
 *    server has no way to infer it from bytes alone) and the actual `File`,
 *    neither of which the mock's original `{ name, size, type }` stand-in
 *    carried. `UploadInput` is what `UploadDropzone` now collects before
 *    confirming an upload — the operator picks (or accepts an inferred
 *    default for) the document type rather than the UI silently guessing it
 *    the way the mock used to.
 */
export interface DocumentStatus {
  documentId: string;
  docType: DocType;
  parseStatus: ParseStatus;
  parseError: string | null;
  rowCount: number;
}

export interface UploadInput {
  file: File;
  docType: DocType;
  uploadedBy?: string;
}

/* ------------------------------------------------------------------------
 * Reconciliation (see file doc note 6).
 * --------------------------------------------------------------------- */

/** One line to be matched, from either side of a reconciliation. Deliberately
 *  generic over what produced it (`sourceRef`) — a reconciliation is always
 *  "this document" vs. "what is already recorded", and what is already
 *  recorded may be posted `ledger_entry` rows or a not-yet-posted sheet the
 *  operator wants to check the document against before anything commits. */
export interface ReconLine {
  lineId: string;
  side: 'document' | 'ledger';
  /** Where this line traces to — every row must be explicable on screen. */
  sourceRef:
    | { kind: 'document'; documentId: string; stagingRowId: string | null; label: string }
    | { kind: 'ledger'; entryId: string; label: string }
    | { kind: 'sheet'; label: string; rowRef: string };
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
  /** A human looked at a match (auto or near) and rejected it; both lines
   *  fall back to unmatched. */
  | 'rejected'
  /** No candidate on the other side, and a human has recorded why that is
   *  expected rather than a real variance. */
  | 'expected_missing'
  /** No candidate on the other side, not yet looked at. */
  | 'unmatched';

/** One row of the match view: a pairing (both `documentLine` and `ledgerLine`
 *  set) or a singleton (exactly one set) — never both null. */
export interface ReconMatch {
  matchId: string;
  status: ReconMatchStatus;
  documentLine: ReconLine | null;
  ledgerLine: ReconLine | null;
  /** `documentLine.amount - ledgerLine.amount` for a pairing; null for a
   *  singleton or an exact auto-match (always "0.00" there, so omitted). */
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
  /** Net of everything not cancelled out by an accepted pairing — see
   *  `reconciliation/logic.ts` `summarizeRecon` for exactly what is and is
   *  not included. */
  netVariance: Decimal;
}

export interface ReconciliationSet {
  reconciliationId: string;
  documentId: string;
  documentLabel: string;
  ledgerLabel: string;
  matches: ReconMatch[];
}

/* ------------------------------------------------------------------------
 * Chargeback (see file doc note 7).
 * --------------------------------------------------------------------- */

export type ChargedTo = 'company' | 'driver' | 'split' | 'unknown';

/** A `split` decision is not a decision without a ratio — this is what
 *  makes that true in the type system, not just in a validator. */
export interface SplitRatio {
  kind: 'amount' | 'percentage';
  /** The driver's share. For `kind: 'amount'`, a money decimal string (the
   *  company bears the remainder of the row's absolute amount). For
   *  `kind: 'percentage'`, a decimal string in `[0, 100]`. */
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

/** One cost row still needing (or already given) a chargeback decision.
 *  Carries everything SOURCE-DISCOVERY §5/§11h says a human needs to decide
 *  without leaving the screen. */
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
  /** What the sheet/parser produced, per SOURCE-DISCOVERY §5 — `'unknown'`
   *  for the 713 rows nobody has decided yet. */
  chargedTo: ChargedTo;
  decision: ChargebackDecision | null;
}

/** See file doc note 4. */


