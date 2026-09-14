/**
 * Chargeback persistence — `accounting.chargeback_decision` (migration 006).
 *
 * The queue is `accounting.staging_row`: cost rows a parser produced with
 * nobody having yet said whether the company or the driver bears them.
 * Measured against the real expense sheet that is 713 rows, which is why
 * the screen supports deciding many at once.
 *
 * The thing this module exists to make true: **a decision is recorded, not
 * applied.** `staging_row.charged_to` says what a row is charged to now; it
 * is a mutable field on a review table and tells you nothing about who
 * decided or why. `chargeback_decision` is the record, and a replacement
 * names what it supersedes, so a driver disputing a deduction eight months
 * later gets the whole chain instead of whatever the column happens to say
 * that day.
 */
import type { ChargebackDecision, ChargebackRow, ChargedTo, DriverClass } from '@/contract/types';
import { query } from '@/db/pool';

export class InvalidChargebackDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidChargebackDecisionError';
  }
}

export class UnknownCostRowError extends Error {
  constructor(costRowId: string) {
    super(`cost row ${costRowId} not found, or is not a row awaiting a chargeback decision`);
    this.name = 'UnknownCostRowError';
  }
}

export interface ChargebackFilter {
  /** `'open'` (the default) is null-or-unknown; `'decided'` is everything
   *  a person has ruled on; `'all'` is both. */
  status?: 'open' | 'decided' | 'all';
  entityId?: string;
  /** Inclusive accrual_date bounds, YYYY-MM-DD. */
  from?: string;
  to?: string;
  limit?: number;
  /** Exactly these rows, whatever their status. Used to read back what a
   *  bulk decision just wrote. */
  costRowIds?: readonly string[];
}

interface QueueDbRow {
  staging_row_id: string;
  document_id: string;
  file_name: string;
  truck_id: string | null;
  driver_id: string | null;
  driver_class: DriverClass | null;
  vendor: string | null;
  description: string | null;
  accrual_date: string | null;
  amount: string;
  category_id: string | null;
  unit_number: string | null;
  charged_to: ChargedTo | null;
  decision_charged_to: ChargedTo | null;
  split_amount: string | null;
  split_percent: string | null;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
}

/**
 * The decision currently standing is the one nothing supersedes — the tail
 * of the chain, not the head. Migration 006's unique index only guarantees
 * one chain start per row; walking to the end is this query's job.
 */
const CURRENT_DECISION_SQL = `
  LEFT JOIN LATERAL (
    SELECT d.charged_to AS decision_charged_to,
           d.split_amount,
           d.split_percent,
           d.decided_by,
           to_char(d.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at,
           d.note
      FROM accounting.chargeback_decision d
     WHERE d.staging_row_id = sr.staging_row_id
       AND NOT EXISTS (
         SELECT 1 FROM accounting.chargeback_decision later
          WHERE later.supersedes_id = d.decision_id
       )
     ORDER BY d.decided_at DESC
     LIMIT 1
  ) cd ON true
`;

export async function listChargebackRows(filter: ChargebackFilter = {}): Promise<ChargebackRow[]> {
  const status = filter.status ?? 'open';
  const params: unknown[] = [];
  const clauses: string[] = [
    // A chargeback question only arises for a cost. Revenue is never
    // charged to a driver, and offering it as a choice invites the answer.
    'sr.amount IS NOT NULL',
    'sr.amount < 0',
    "sr.status <> 'rejected'",
  ];

  if (status === 'open') {
    clauses.push("(sr.charged_to IS NULL OR sr.charged_to = 'unknown')");
  } else if (status === 'decided') {
    clauses.push('cd.decision_charged_to IS NOT NULL');
  }
  if (filter.entityId) {
    params.push(filter.entityId);
    clauses.push(`sr.entity_id = $${params.length}`);
  }
  if (filter.from) {
    params.push(filter.from);
    clauses.push(`sr.accrual_date >= $${params.length}::date`);
  }
  if (filter.to) {
    params.push(filter.to);
    clauses.push(`sr.accrual_date <= $${params.length}::date`);
  }
  if (filter.costRowIds) {
    if (filter.costRowIds.length === 0) return [];
    params.push([...filter.costRowIds]);
    clauses.push(`sr.staging_row_id = ANY($${params.length}::uuid[])`);
  }

  params.push(Math.min(Math.max(filter.limit ?? 500, 1), 2000));
  const limitParam = `$${params.length}`;

  const rows = (await query(
    `SELECT sr.staging_row_id,
            sr.document_id,
            sd.file_name,
            sr.truck_id,
            sr.driver_id,
            dch.class AS driver_class,
            COALESCE(sr.reviewed_payload ->> 'vendor', sr.parsed_payload ->> 'vendor') AS vendor,
            COALESCE(sr.reviewed_payload ->> 'description', sr.parsed_payload ->> 'description') AS description,
            to_char(sr.accrual_date, 'YYYY-MM-DD') AS accrual_date,
            sr.amount,
            sr.category_id,
            sr.unit_number,
            sr.charged_to,
            cd.decision_charged_to,
            cd.split_amount,
            cd.split_percent,
            cd.decided_by,
            cd.decided_at,
            cd.note
       FROM accounting.staging_row sr
       JOIN accounting.source_document sd ON sd.document_id = sr.document_id
       ${CURRENT_DECISION_SQL}
       LEFT JOIN LATERAL (
         SELECT h.class
           FROM accounting.driver_class_history h
          WHERE h.driver_id = sr.driver_id
            AND sr.accrual_date IS NOT NULL
            AND h.effective_from <= sr.accrual_date
            AND (h.effective_to IS NULL OR h.effective_to >= sr.accrual_date)
          ORDER BY h.effective_from DESC
          LIMIT 1
       ) dch ON true
      WHERE ${clauses.join(' AND ')}
      ORDER BY sr.accrual_date NULLS LAST, sr.staging_row_id
      LIMIT ${limitParam}`,
    params,
  )) as unknown as QueueDbRow[];

  return rows.map(toWire);
}

function toWire(r: QueueDbRow): ChargebackRow {
  const decision: ChargebackDecision | null =
    r.decision_charged_to === null
      ? null
      : {
          chargedTo: r.decision_charged_to,
          splitRatio:
            r.split_percent !== null
              ? { kind: 'percentage', driverShare: r.split_percent }
              : r.split_amount !== null
                ? { kind: 'amount', driverShare: r.split_amount }
                : null,
          note: r.note,
          decidedBy: r.decided_by ?? 'unknown',
          decidedAt: r.decided_at ?? '',
        };

  return {
    costRowId: r.staging_row_id,
    sourceRef: {
      kind: 'document',
      documentId: r.document_id,
      stagingRowId: r.staging_row_id,
      label: r.unit_number !== null ? `${r.file_name} · unit ${r.unit_number}` : r.file_name,
    },
    truckId: r.truck_id,
    driverId: r.driver_id,
    driverClass: r.driver_class,
    vendor: r.vendor,
    description: r.description,
    accrualDate: r.accrual_date,
    amount: r.amount,
    categoryId: r.category_id,
    // Null and 'unknown' both mean undecided; the wire type says 'unknown'
    // so a screen never has to treat two spellings of the same state.
    chargedTo: r.charged_to ?? 'unknown',
    decision,
  };
}

/**
 * Validates before touching the database. The CHECK constraints would catch
 * every one of these, but a constraint violation surfaces as a 500 with a
 * Postgres error string, and a person applying a decision to 40 rows
 * deserves to be told which rule they broke.
 */
function assertValid(decision: ChargebackDecision): void {
  const { chargedTo, splitRatio } = decision;
  if (chargedTo === 'split') {
    if (splitRatio === null) {
      throw new InvalidChargebackDecisionError(
        'A split needs a ratio. A row marked "split" with no proportion is a deferral, not a decision.',
      );
    }
    if (splitRatio.kind === 'percentage') {
      const pct = Number(splitRatio.driverShare);
      if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
        throw new InvalidChargebackDecisionError(
          `A split percentage must be between 0 and 100, exclusive; got ${splitRatio.driverShare}.`,
        );
      }
    }
  } else if (splitRatio !== null) {
    throw new InvalidChargebackDecisionError(
      `A ratio only means something on a split; "${chargedTo}" carries the whole amount.`,
    );
  }
  if (decision.decidedBy.trim().length === 0) {
    throw new InvalidChargebackDecisionError('A decision records who made it.');
  }
}

/**
 * Applies one decision to every named row and to no other row. Re-applying
 * the same decision is safe: each call supersedes whatever stood before, so
 * a double-click records a second identical decision rather than corrupting
 * the chain.
 */
export async function recordChargebackDecisions(
  costRowIds: readonly string[],
  decision: ChargebackDecision,
): Promise<ChargebackRow[]> {
  assertValid(decision);
  if (costRowIds.length === 0) return [];

  const splitAmount =
    decision.chargedTo === 'split' && decision.splitRatio?.kind === 'amount'
      ? decision.splitRatio.driverShare
      : null;
  const splitPercent =
    decision.chargedTo === 'split' && decision.splitRatio?.kind === 'percentage'
      ? decision.splitRatio.driverShare
      : null;

  for (const costRowId of costRowIds) {
    const existing = (await query(
      `SELECT sr.staging_row_id, sr.driver_id,
              (SELECT d.decision_id
                 FROM accounting.chargeback_decision d
                WHERE d.staging_row_id = sr.staging_row_id
                  AND NOT EXISTS (
                    SELECT 1 FROM accounting.chargeback_decision later
                     WHERE later.supersedes_id = d.decision_id
                  )
                ORDER BY d.decided_at DESC
                LIMIT 1) AS current_decision_id
         FROM accounting.staging_row sr
        WHERE sr.staging_row_id = $1`,
      [costRowId],
    )) as unknown as { staging_row_id: string; driver_id: string | null; current_decision_id: string | null }[];

    const row = existing[0];
    if (!row) throw new UnknownCostRowError(costRowId);

    // The database refuses a driver charge that names no driver, and it is
    // right to: an amount owed by nobody in particular is an amount not
    // charged. Caught here so the message says which row.
    if ((decision.chargedTo === 'driver' || decision.chargedTo === 'split') && row.driver_id === null) {
      throw new InvalidChargebackDecisionError(
        `Row ${costRowId} charges a driver but names none. Resolve the driver on the review screen first.`,
      );
    }

    await query(
      `INSERT INTO accounting.chargeback_decision
         (staging_row_id, charged_to, split_amount, split_percent, driver_id,
          decided_by, note, supersedes_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        costRowId,
        decision.chargedTo,
        splitAmount,
        splitPercent,
        row.driver_id,
        decision.decidedBy,
        decision.note,
        row.current_decision_id,
      ],
    );

    // The staging row's own column follows the decision, because that is
    // what the commit path reads when it posts to the ledger.
    await query(`UPDATE accounting.staging_row SET charged_to = $2 WHERE staging_row_id = $1`, [
      costRowId,
      decision.chargedTo,
    ]);
  }

  return listChargebackRows({ status: 'all', costRowIds, limit: costRowIds.length });
}
