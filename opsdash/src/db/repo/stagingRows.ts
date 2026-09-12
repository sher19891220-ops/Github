/**
 * The human-edit path: `PATCH /api/staging/:rowId`.
 *
 * `parsed_payload` is never touched here — it is not even in the UPDATE
 * statement. Every edit lands in `reviewed_payload` and the normalized
 * columns, which is what keeps "what the machine read" and "what the
 * operator decided" separately traceable (DATA-CONTRACT.md §4).
 *
 * `edit` is `Partial<StagingRowEdit>` from `@/contract/types` — the shape
 * the UI workstream defined and now imports directly. It carries no
 * `reviewedPayload`/`status`/`reviewedBy`: `reviewedPayload` is derived here
 * from whichever normalized fields changed, and `reviewedBy` is a side
 * channel the route reads from a header rather than the body, since the
 * contract type has no slot for it.
 *
 * **An edit clears `under_review`.** `under_review` means "a machine flagged
 * this and a person has not looked yet"; a person editing the row is that
 * person looking, so the row becomes `parsed` and the next commit posts it.
 * What the operator decided stays traceable through `reviewed_payload`,
 * `reviewed_by` and `reviewed_at` — the status is a queue position, not the
 * audit trail.
 *
 * This used to move every edit TO `under_review`, which was harmless only
 * because `commitDocument` posted `under_review` rows too. Once commit
 * started honouring the flag, that pair became a deadlock: an edit could
 * never be posted. Holding the flag is the useful half, so the edit side
 * gives way.
 *
 * An edit can never reopen a `committed` row, and can never itself set
 * `committed` — only `POST /commit` does that.
 */
import { isDecimal, isIsoDate, type StagingRow, type StagingRowEdit } from '@/contract/types';
import { withTransaction } from '@/db/pool';
import { STAGING_ROW_COLUMNS_SQL, mapDbRowToStagingRowRecord, toWireStagingRow } from './mappers';
import type { StagingRowRecord, UpdateStagingRowResult } from './types';

type QueryFn = (text: string, params?: readonly unknown[]) => Promise<unknown[]>;

export async function getStagingRowRecord(rowId: string): Promise<StagingRowRecord | null> {
  const { query } = await import('@/db/pool');
  const rows = await query(
    `SELECT ${STAGING_ROW_COLUMNS_SQL} FROM accounting.staging_row WHERE staging_row_id = $1`,
    [rowId],
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows[0] ? mapDbRowToStagingRowRecord(rows[0] as any) : null;
}

const VALUE_FIELDS = [
  'entityId',
  'truckId',
  'driverId',
  'accrualDate',
  'categoryId',
  'amount',
  'quantity',
  'jurisdiction',
  'reviewNotes',
] as const satisfies readonly (keyof StagingRowEdit)[];

function pick<V>(editValue: V | undefined, current: V): V {
  return editValue !== undefined ? editValue : current;
}

export async function updateStagingRow(
  rowId: string,
  edit: Partial<StagingRowEdit>,
  reviewedBy = 'unknown',
): Promise<UpdateStagingRowResult> {
  if (edit.amount !== undefined && edit.amount !== null && !isDecimal(edit.amount)) {
    return { ok: false, reason: 'invalid', message: `amount "${edit.amount}" is not a valid decimal string.` };
  }
  if (edit.quantity !== undefined && edit.quantity !== null && !isDecimal(edit.quantity)) {
    return { ok: false, reason: 'invalid', message: `quantity "${edit.quantity}" is not a valid decimal string.` };
  }
  if (edit.accrualDate !== undefined && edit.accrualDate !== null && !isIsoDate(edit.accrualDate)) {
    return { ok: false, reason: 'invalid', message: `accrualDate "${edit.accrualDate}" is not a valid YYYY-MM-DD date.` };
  }

  return withTransaction(async (q: QueryFn) => {
    const rows = await q(
      `SELECT ${STAGING_ROW_COLUMNS_SQL} FROM accounting.staging_row WHERE staging_row_id = $1 FOR UPDATE`,
      [rowId],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentRow = rows[0] as any;
    if (!currentRow) return { ok: false, reason: 'not_found' };
    const current = mapDbRowToStagingRowRecord(currentRow);

    const touchesValue = VALUE_FIELDS.some((f) => edit[f] !== undefined);
    if (current.status === 'committed' && touchesValue) {
      return {
        ok: false,
        reason: 'immutable',
        message: 'this row already posted a ledger entry; correct it with an adjustment entry, not a staging edit.',
      };
    }

    const next: StagingRow = {
      ...current,
      entityId: pick(edit.entityId, current.entityId),
      truckId: pick(edit.truckId, current.truckId),
      driverId: pick(edit.driverId, current.driverId),
      accrualDate: pick(edit.accrualDate, current.accrualDate),
      categoryId: pick(edit.categoryId, current.categoryId),
      amount: pick(edit.amount, current.amount),
      quantity: pick(edit.quantity, current.quantity),
      jurisdiction: pick(edit.jurisdiction, current.jurisdiction),
      reviewNotes: pick(edit.reviewNotes, current.reviewNotes),
      status: touchesValue && current.status !== 'committed' ? 'parsed' : current.status,
    };

    // reviewed_payload is never sent by the caller (the contract's
    // StagingRowEdit has no field for it) — it is always derived here, a
    // sparse overlay of exactly the fields this edit touched, so it answers
    // "what did a human actually change" distinctly from parsedPayload.
    let reviewedPayloadToWrite = current.reviewedPayload;
    if (touchesValue) {
      reviewedPayloadToWrite = { ...(current.reviewedPayload ?? {}), ...edit };
    }

    await q(
      `UPDATE accounting.staging_row SET
         reviewed_payload = $2::jsonb,
         entity_id = $3, truck_id = $4, driver_id = $5, accrual_date = $6::date,
         category_id = $7, amount = $8, quantity = $9, jurisdiction = $10,
         status = $11, review_notes = $12, reviewed_by = $13, reviewed_at = now()
       WHERE staging_row_id = $1`,
      [
        rowId,
        reviewedPayloadToWrite ? JSON.stringify(reviewedPayloadToWrite) : null,
        next.entityId,
        next.truckId,
        next.driverId,
        next.accrualDate,
        next.categoryId,
        next.amount,
        next.quantity,
        next.jurisdiction,
        next.status,
        next.reviewNotes,
        reviewedBy,
      ],
    );

    const refreshed = await q(
      `SELECT ${STAGING_ROW_COLUMNS_SQL} FROM accounting.staging_row WHERE staging_row_id = $1`,
      [rowId],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ok: true, row: toWireStagingRow(mapDbRowToStagingRowRecord(refreshed[0] as any)) };
  });
}
