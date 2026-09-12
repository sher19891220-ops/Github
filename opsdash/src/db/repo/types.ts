/**
 * Repo-internal types.
 *
 * These extend/complement `@/contract/types` for the persistence layer's own
 * needs. Nothing here is part of the fixed wire contract (DATA-CONTRACT.md
 * §6) — `toWireStagingRow` strips these fields before a `StagingRow` ever
 * reaches an HTTP response, so the API surface matches the contract exactly.
 */
import type { DocType, StagingRow } from '@/contract/types';

/** `charged_to` / `unit_type` as the DB enums spell them. */
export type ChargedTo = 'company' | 'driver' | 'split' | 'unknown';
export type UnitType = 'truck' | 'trailer' | 'other' | 'unknown';

/**
 * The full staging_row record, including columns the wire `StagingRow` type
 * does not carry (DATA-CONTRACT.md §6 omits `charged_to`/`unit_type`/
 * `unit_number` even though ledger_entry needs them at commit time — see the
 * final report for why this is flagged as a contract gap rather than worked
 * around by changing `src/contract/types.ts`).
 */
export interface StagingRowRecord extends StagingRow {
  chargedTo: ChargedTo | null;
  unitType: UnitType | null;
  unitNumber: string | null;
  /** Set once this row has posted; mirrors staging_row.committed_entry_id. */
  committedEntryId: string | null;
}

/**
 * The exact 5-field shape DATA-CONTRACT.md §6 specifies for
 * `GET /api/documents/:id` (singular). Deliberately distinct from
 * `@/contract/types`' richer `DocumentSummary` (9 fields, added later for the
 * list screen — see documents.ts's `listDocumentSummaries`): the fixed
 * singular-GET shape is not renegotiated just because a sibling type grew.
 */
export interface DocumentStatusSummary {
  documentId: string;
  docType: DocType | string;
  parseStatus: 'pending' | 'parsed' | 'failed';
  parseError: string | null;
  rowCount: number;
}

export interface CommitResult {
  committed: number;
  rejected: number;
  /** Rows left in `under_review`: a person flagged them, so the commit does
   *  not post them and does not reject them either. They wait. */
  held: number;
  entryIds: string[];
}

export type UpdateStagingRowResult =
  | { ok: true; row: StagingRow }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'immutable'; message: string }
  | { ok: false; reason: 'invalid'; message: string };

export class DocumentNotFoundError extends Error {
  constructor(documentId: string) {
    super(`document ${documentId} not found`);
    this.name = 'DocumentNotFoundError';
  }
}
