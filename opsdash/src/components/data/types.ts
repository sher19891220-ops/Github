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
 * Reconciliation and chargeback.
 *
 * Notes 6 and 7 above describe these as this screen's minimum ask, flagged
 * rather than invented as settled. They have since been settled: the
 * endpoints exist, and the types moved into `@/contract/types` unchanged in
 * shape. They are re-exported here rather than redefined so the two sides
 * cannot drift — the same treatment `ParseStatus` and `DocumentSummary`
 * already get above.
 * --------------------------------------------------------------------- */

export type {
  ReconSourceRef, ReconLine, ReconMatchStatus, ReconMatch, ReconSummary,
  ReconciliationSet, ReconDecisionStatus,
  ChargedTo, SplitRatio, ChargebackDecision, ChargebackRow,
} from '@/contract/types';

/** See file doc note 4. */


