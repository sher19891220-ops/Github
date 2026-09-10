/**
 * `POST /api/documents/:id/commit` — the all-or-nothing move from staging
 * into the ledger.
 *
 * Atomicity: the whole document commits inside one `withTransaction`. Any
 * unhandled error (including a real constraint violation this code did not
 * pre-validate, e.g. a `categoryId` a human typo'd into something that does
 * not exist in `accounting.category`) rolls back everything — zero ledger
 * rows, zero staging rows flipped to `committed`. Only the four fields the
 * contract names (entity, date, category, amount) are pre-checked and turned
 * into a graceful per-row rejection instead of a hard failure; anything else
 * the database itself rejects aborts the batch. See the final report for why
 * that split was chosen over pre-validating every foreign key.
 *
 * Idempotency: a row already `committed` or `rejected` from a previous call
 * is never reprocessed, and the ledger insert additionally goes through
 * `ON CONFLICT (staging_row_id) DO NOTHING` against `ux_ledger_staging_once`
 * as defense in depth. The result reports the document's current cumulative
 * totals, so calling this twice returns the same numbers and never double-
 * posts, rather than reporting "0 committed" on the second call and leaving
 * the caller to wonder whether anything happened.
 */
import { randomUUID } from 'node:crypto';
import { withTransaction } from '@/db/pool';
import { LEDGER_ENTRY_COLUMNS_SQL, STAGING_ROW_COLUMNS_SQL, mapDbRowToStagingRowRecord } from './mappers';
import { DocumentNotFoundError, type CommitResult, type StagingRowRecord } from './types';

type QueryFn = (text: string, params?: readonly unknown[]) => Promise<unknown[]>;

const REQUIRED_FIELDS: ReadonlyArray<{ key: keyof StagingRowRecord; label: string }> = [
  { key: 'entityId', label: 'entityId' },
  { key: 'accrualDate', label: 'accrualDate' },
  { key: 'categoryId', label: 'categoryId' },
  { key: 'amount', label: 'amount' },
];

function missingFields(row: StagingRowRecord): string[] {
  return REQUIRED_FIELDS.filter((f) => {
    const v = row[f.key];
    return v === null || v === undefined || v === '';
  }).map((f) => f.label);
}

export interface CommitOptions {
  /** TEST ONLY. Throws after committing this many rows, to prove the
   *  transaction rolls back everything rather than leaving a partial batch.
   *  Never set outside tests/integration. */
  __testThrowAfter?: number;
}

export async function commitDocument(documentId: string, postedBy: string, opts: CommitOptions = {}): Promise<CommitResult> {
  return withTransaction(async (q: QueryFn) => {
    const docRows = await q(`SELECT document_id FROM accounting.source_document WHERE document_id = $1 FOR UPDATE`, [documentId]);
    if (docRows.length === 0) throw new DocumentNotFoundError(documentId);

    const pendingRaw = await q(
      `SELECT ${STAGING_ROW_COLUMNS_SQL} FROM accounting.staging_row
       WHERE document_id = $1 AND status IN ('parsed','under_review')
       ORDER BY row_index
       FOR UPDATE`,
      [documentId],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = pendingRaw.map((r) => mapDbRowToStagingRowRecord(r as any));

    let processed = 0;
    for (const row of pending) {
      const missing = missingFields(row);
      if (missing.length > 0) {
        const reason = `REJECTED: missing required field(s): ${missing.join(', ')}.`;
        await q(
          `UPDATE accounting.staging_row
             SET status = 'rejected',
                 review_notes = CASE WHEN review_notes IS NULL OR review_notes = '' THEN $2 ELSE review_notes || ' ' || $2 END,
                 reviewed_by = $3, reviewed_at = now()
           WHERE staging_row_id = $1`,
          [row.stagingRowId, reason, postedBy],
        );
        continue;
      }

      const entryId = randomUUID();
      const inserted = await q(
        `INSERT INTO accounting.ledger_entry
           (entry_id, entity_id, truck_id, driver_id, driver_class, accrual_date, category_id,
            amount, quantity, jurisdiction, source_kind, source_document_id, staging_row_id,
            charged_to, unit_type, unit_number, posted_by)
         VALUES (
           $1, $2, $3, $4,
           COALESCE(
             (SELECT class FROM accounting.driver_class_history
                WHERE driver_id = $4 AND effective_from <= $5::date
                  AND (effective_to IS NULL OR effective_to > $5::date)
                ORDER BY effective_from DESC LIMIT 1),
             'unassigned'
           ),
           $5::date, $6, $7, $8, $9, 'document', $10, $11,
           COALESCE($12, 'company'), COALESCE($13, 'unknown'), $14, $15
         )
         ON CONFLICT (staging_row_id) WHERE staging_row_id IS NOT NULL DO NOTHING
         RETURNING entry_id`,
        [
          entryId,
          row.entityId,
          row.truckId,
          row.driverId,
          row.accrualDate,
          row.categoryId,
          row.amount,
          row.quantity,
          row.jurisdiction,
          documentId,
          row.stagingRowId,
          row.chargedTo,
          row.unitType,
          row.unitNumber,
          postedBy,
        ],
      );

      let resultEntryId = (inserted[0] as { entry_id: string } | undefined)?.entry_id;
      if (!resultEntryId) {
        // ON CONFLICT hit — an entry for this staging row already exists
        // (e.g. a crash between insert and status update on a prior run).
        // Idempotent: reuse it rather than posting a second one.
        const existing = await q(`SELECT entry_id FROM accounting.ledger_entry WHERE staging_row_id = $1`, [row.stagingRowId]);
        resultEntryId = (existing[0] as { entry_id: string } | undefined)?.entry_id;
      }

      await q(
        `UPDATE accounting.staging_row
           SET status = 'committed', committed_entry_id = $2, reviewed_by = $3, reviewed_at = now()
         WHERE staging_row_id = $1`,
        [row.stagingRowId, resultEntryId, postedBy],
      );

      processed += 1;
      if (opts.__testThrowAfter !== undefined && processed === opts.__testThrowAfter) {
        throw new Error('TEST-ONLY: injected mid-batch failure to prove commitDocument rolls back atomically');
      }
    }

    const totals = await q(
      `SELECT status, COUNT(*)::int AS n FROM accounting.staging_row
       WHERE document_id = $1 AND status IN ('committed','rejected')
       GROUP BY status`,
      [documentId],
    );
    const committed = (totals.find((t) => (t as { status: string }).status === 'committed') as { n: number } | undefined)?.n ?? 0;
    const rejected = (totals.find((t) => (t as { status: string }).status === 'rejected') as { n: number } | undefined)?.n ?? 0;

    const entryRows = await q(
      `SELECT entry_id FROM accounting.ledger_entry
       WHERE staging_row_id IN (SELECT staging_row_id FROM accounting.staging_row WHERE document_id = $1 AND status = 'committed')
       ORDER BY entry_id`,
      [documentId],
    );
    const entryIds = entryRows.map((r) => (r as { entry_id: string }).entry_id);

    return { committed, rejected, entryIds };
  });
}

// Re-exported for callers that want to select a freshly-committed entry by
// the same column shape `listLedgerEntries` uses.
export { LEDGER_ENTRY_COLUMNS_SQL };
