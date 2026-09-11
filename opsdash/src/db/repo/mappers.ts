/**
 * DB row <-> wire type conversion.
 *
 * Two rules drive every function here:
 *  - dates and timestamps are read back as pre-formatted TEXT (`to_char`) in
 *    the SQL itself, never as a JS `Date` object, so there is no timezone
 *    boundary anywhere a date could silently shift by a day.
 *  - NUMERIC already comes back as a string (src/db/pool.ts pins the type
 *    parser); these mappers never touch it with arithmetic or `Number(...)`.
 */
import type { DriverClass, LedgerEntry, Provenance, StagingRow } from '@/contract/types';
import type { ChargedTo, StagingRowRecord, UnitType } from './types';

/** Every column `staging_row` selects need, with date columns pre-formatted
 *  as text. Reused by every query that reads a full staging row. */
export const STAGING_ROW_COLUMNS_SQL = `
  staging_row_id,
  document_id,
  row_index,
  source_page,
  parsed_payload,
  reviewed_payload,
  entity_id,
  truck_id,
  driver_id,
  to_char(accrual_date, 'YYYY-MM-DD') AS accrual_date,
  category_id,
  amount,
  quantity,
  jurisdiction,
  status,
  review_notes,
  charged_to,
  unit_type,
  unit_number,
  committed_entry_id
`;

export const LEDGER_ENTRY_COLUMNS_SQL = `
  entry_id,
  entity_id,
  truck_id,
  driver_id,
  driver_class,
  to_char(accrual_date, 'YYYY-MM-DD') AS accrual_date,
  category_id,
  amount,
  currency,
  quantity,
  jurisdiction,
  source_kind,
  source_document_id,
  staging_row_id,
  connector_pull_id,
  calc_run_id,
  reverses_entry_id,
  attestation_id,
  memo,
  posted_by,
  to_char(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS posted_at
`;

interface StagingRowDbRow {
  staging_row_id: string;
  document_id: string;
  row_index: number;
  source_page: number | null;
  parsed_payload: Record<string, unknown>;
  reviewed_payload: Record<string, unknown> | null;
  entity_id: string | null;
  truck_id: string | null;
  driver_id: string | null;
  accrual_date: string | null;
  category_id: string | null;
  amount: string | null;
  quantity: string | null;
  jurisdiction: string | null;
  status: StagingRow['status'];
  review_notes: string | null;
  charged_to: ChargedTo | null;
  unit_type: UnitType | null;
  unit_number: string | null;
  committed_entry_id: string | null;
}

export function mapDbRowToStagingRowRecord(r: StagingRowDbRow): StagingRowRecord {
  return {
    stagingRowId: r.staging_row_id,
    documentId: r.document_id,
    rowIndex: r.row_index,
    sourcePage: r.source_page,
    parsedPayload: r.parsed_payload,
    reviewedPayload: r.reviewed_payload,
    entityId: r.entity_id,
    truckId: r.truck_id,
    driverId: r.driver_id,
    accrualDate: r.accrual_date,
    categoryId: r.category_id,
    amount: r.amount,
    quantity: r.quantity,
    jurisdiction: r.jurisdiction,
    status: r.status,
    reviewNotes: r.review_notes,
    chargedTo: r.charged_to,
    unitType: r.unit_type,
    unitNumber: r.unit_number,
    committedEntryId: r.committed_entry_id,
  };
}

/** Strips the internal-only columns so the response matches
 *  DATA-CONTRACT.md §6's `StagingRow` exactly — no extra fields. */
export function toWireStagingRow(r: StagingRowRecord): StagingRow {
  const {
    chargedTo: _chargedTo,
    unitType: _unitType,
    unitNumber: _unitNumber,
    committedEntryId: _committedEntryId,
    ...wire
  } = r;
  return wire;
}

interface LedgerEntryDbRow {
  entry_id: string;
  entity_id: string;
  truck_id: string | null;
  driver_id: string | null;
  driver_class: DriverClass;
  accrual_date: string;
  category_id: string;
  amount: string;
  currency: string;
  quantity: string | null;
  jurisdiction: string | null;
  source_kind: Provenance['kind'];
  source_document_id: string | null;
  staging_row_id: string | null;
  connector_pull_id: string | null;
  calc_run_id: string | null;
  reverses_entry_id: string | null;
  attestation_id: string | null;
  memo: string | null;
  posted_by: string;
  posted_at: string;
}

function buildProvenance(r: LedgerEntryDbRow): Provenance {
  switch (r.source_kind) {
    case 'document':
      // provenance_matches_kind guarantees source_document_id is set here.
      return { kind: 'document', sourceDocumentId: r.source_document_id as string, stagingRowId: r.staging_row_id };
    case 'connector':
      return { kind: 'connector', connectorPullId: r.connector_pull_id as string };
    case 'derived':
      return { kind: 'derived', calcRunId: r.calc_run_id as string };
    case 'manual':
      // Same guarantee as the others: provenance_matches_kind will not let
      // a 'manual' row exist without an attestation to point at.
      return { kind: 'manual', attestationId: r.attestation_id as string };
    case 'adjustment':
      return { kind: 'adjustment', reversesEntryId: r.reverses_entry_id as string };
    default:
      throw new Error(`unknown source_kind "${r.source_kind}" read back from ledger_entry`);
  }
}

export function mapDbRowToLedgerEntry(r: LedgerEntryDbRow): LedgerEntry {
  return {
    entryId: r.entry_id,
    entityId: r.entity_id,
    truckId: r.truck_id,
    driverId: r.driver_id,
    driverClass: r.driver_class,
    accrualDate: r.accrual_date,
    categoryId: r.category_id,
    amount: r.amount,
    currency: r.currency,
    quantity: r.quantity,
    jurisdiction: r.jurisdiction,
    provenance: buildProvenance(r),
    memo: r.memo,
    postedBy: r.posted_by,
    postedAt: r.posted_at,
  };
}
