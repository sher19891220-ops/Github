/**
 * Repo-internal types.
 *
 * These extend/complement `@/contract/types` for the persistence layer's own
 * needs. Nothing here is part of the fixed wire contract (DATA-CONTRACT.md
 * §6) — `toWireStagingRow` strips these fields before a `StagingRow` ever
 * reaches an HTTP response, so the API surface matches the contract exactly.
 */
import type { DocType, StagingRow, StagingStatus } from '@/contract/types';

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

export interface DocumentSummary {
  documentId: string;
  docType: DocType | string;
  parseStatus: 'pending' | 'parsed' | 'failed';
  parseError: string | null;
  rowCount: number;
}

export interface CommitResult {
  committed: number;
  rejected: number;
  entryIds: string[];
}

/**
 * The PATCH body shape. DATA-CONTRACT.md §6 references `Partial<StagingRowEdit>`
 * but never defines it — this is the persistence layer's best-effort
 * reconstruction (the editable subset of `StagingRow`, plus `reviewedBy` for
 * the audit columns the wire type never exposes). Recommend the contract
 * owner adopt this formally; see final report.
 */
export interface StagingRowEdit {
  reviewedPayload?: Record<string, unknown> | null;
  entityId?: string | null;
  truckId?: string | null;
  driverId?: string | null;
  accrualDate?: string | null;
  categoryId?: string | null;
  amount?: string | null;
  quantity?: string | null;
  jurisdiction?: string | null;
  status?: StagingStatus;
  reviewNotes?: string | null;
  /** Who made the edit. Tracked in `reviewed_by`/`reviewed_at`; never echoed
   *  back on the wire because `StagingRow` has no slot for it. */
  reviewedBy?: string;
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
