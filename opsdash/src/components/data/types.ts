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
 *
 * Swapping the mock for the real API is meant to be a one-line change per
 * function in `api.ts` — these types are what both sides agree on today.
 */

import type { Decimal, DocType, IsoDate } from '@/contract/types';

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

/** See file doc note 4. */


