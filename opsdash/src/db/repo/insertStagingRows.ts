/**
 * Writes a parser's `StagingRow[]` output into `accounting.staging_row`.
 *
 * This is the one place a parser's output is translated into what the
 * database will actually accept:
 *  - `entityId` is resolved through `source_key_map` (see entityResolution.ts)
 *    rather than trusted as a canonical id, because the dispatch parser
 *    hands back a raw sheet marker (`"XTRACK"`), not a uuid.
 *  - `charged_to` / `unit_type` / `unit_number` — columns `staging_row` has
 *    but the wire `StagingRow` type does not (see repo/types.ts) — are
 *    lifted out of `parsedPayload` where the expenses parser already put
 *    them, so the signal survives into the database even though the fixed
 *    API contract has no top-level field for it yet.
 *
 * Runs entirely against the query function passed in, so a caller can wrap
 * it in a transaction alongside document bookkeeping (sheetSync.ts does).
 */
import type { StagingRow } from '@/contract/types';
import { resolveEntityId } from './entityResolution';
import type { ChargedTo, UnitType } from './types';

type QueryFn = (text: string, params?: readonly unknown[]) => Promise<unknown[]>;

const CHARGED_TO_VALUES: ReadonlySet<string> = new Set(['company', 'driver', 'split', 'unknown']);
const UNIT_TYPE_VALUES: ReadonlySet<string> = new Set(['truck', 'trailer', 'other', 'unknown']);

function readChargedTo(payload: Record<string, unknown>): ChargedTo | null {
  const v = payload.chargedTo;
  return typeof v === 'string' && CHARGED_TO_VALUES.has(v) ? (v as ChargedTo) : null;
}

function readUnitType(payload: Record<string, unknown>): UnitType | null {
  const v = payload.unitType;
  return typeof v === 'string' && UNIT_TYPE_VALUES.has(v) ? (v as UnitType) : null;
}

function readUnitNumber(payload: Record<string, unknown>): string | null {
  const fromIssuedTo = payload.extractedTruckNumber;
  if (typeof fromIssuedTo === 'string' && fromIssuedTo.trim() !== '') return fromIssuedTo;
  const fromUnitRaw = payload.unitRaw;
  if (typeof fromUnitRaw === 'string' && fromUnitRaw.trim() !== '') return fromUnitRaw;
  return null;
}

export interface InsertStagingRowsOptions {
  /** Which upstream vocabulary raw entity/truck/driver signals are written
   *  in, for the source_key_map lookup. Defaults to 'dispatch', the only
   *  parser that currently emits an unresolved entity signal. */
  entitySourceSystem?: string;
}

export async function insertStagingRows(
  q: QueryFn,
  rows: readonly StagingRow[],
  options: InsertStagingRowsOptions = {},
): Promise<void> {
  const entitySourceSystem = options.entitySourceSystem ?? 'dispatch';

  for (const row of rows) {
    const resolved = await resolveEntityId(q, row.entityId, entitySourceSystem);

    let status = row.status;
    let reviewNotes = row.reviewNotes;
    if (row.entityId !== null && resolved.resolvedFrom === 'unresolved') {
      // A marker was present but source_key_map has no mapping for it yet.
      // Never default to a guessed entity (SOURCE-DISCOVERY.md §8) — surface
      // it for review instead of silently dropping the signal.
      const note = `entity marker "${row.entityId}" not found in source_key_map (source_system=${entitySourceSystem}); left unattributed.`;
      status = 'under_review';
      reviewNotes = reviewNotes ? `${reviewNotes} ${note}` : note;
    }

    const payload = row.parsedPayload;
    const chargedTo = readChargedTo(payload);
    const unitType = readUnitType(payload);
    const unitNumber = readUnitNumber(payload);

    await q(
      `INSERT INTO accounting.staging_row
         (staging_row_id, document_id, row_index, source_page, parsed_payload, reviewed_payload,
          entity_id, truck_id, driver_id, accrual_date, category_id, amount, quantity, jurisdiction,
          status, review_notes, charged_to, unit_type, unit_number)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10::date,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        row.stagingRowId,
        row.documentId,
        row.rowIndex,
        row.sourcePage,
        JSON.stringify(row.parsedPayload),
        row.reviewedPayload ? JSON.stringify(row.reviewedPayload) : null,
        resolved.entityId,
        row.truckId,
        row.driverId,
        row.accrualDate,
        row.categoryId,
        row.amount,
        row.quantity,
        row.jurisdiction,
        status,
        reviewNotes,
        chargedTo,
        unitType,
        unitNumber,
      ],
    );
  }
}
