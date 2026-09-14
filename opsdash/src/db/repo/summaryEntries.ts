/**
 * The query that feeds the P&L rollup engine.
 *
 * The engine does no I/O by design, so it declares what it needs
 * (`SummaryLedgerEntry`) and somebody has to actually select it. That
 * somebody is this file, and it exists because the general-purpose
 * `mapDbRowToLedgerEntry` does not: `LEDGER_ENTRY_COLUMNS_SQL` predates
 * migrations 002/003/004 and selects none of `charged_to`,
 * `allocation_basis`, `unit_type`, `unit_number`, `paid_by_entity_id` or
 * `counterparty_entity_id`, and joins nothing to `accounting.category`.
 *
 * Every one of those omissions changes a number rather than leaving a
 * field blank:
 *
 *  - `charged_to` decides whether a cost is the company's or the driver's.
 *    Missing, every driver-borne deduction lands on company margin.
 *  - `account_nature` (migration 009) decides whether a row is an expense
 *    at all. Missing, the prepaid registration payment is counted on top
 *    of the twelve monthly recognitions of the same money, and loan
 *    principal is booked as a cost.
 *  - `unit_type` decides whether a trailer repair corrupts a truck's
 *    per-truck profitability.
 *
 * So this is a deliberate second reader of the same table, not a
 * duplicate: the P&L needs columns the ledger list screen does not.
 */
import type { AccountNature, CategoryGroup, IsoDate } from '@/contract/types';
import type { AllocationBasis, ChargedTo, UnitType } from '@/engines/registration';
import type { SummaryLedgerEntry } from '@/engines/summary';
import { query } from '@/db/pool';

export interface SummaryEntryFilter {
  /** Inclusive accrual_date bounds, YYYY-MM-DD. Both required: a P&L over
   *  "everything ever" is not a period, and the engine's whole contract is
   *  that a result covers exactly the days it was asked for. */
  from: IsoDate;
  to: IsoDate;
  /** One entity, or all of them when omitted. */
  entityId?: string;
  truckId?: string;
}

interface SummaryEntryDbRow {
  entry_id: string;
  entity_id: string;
  truck_id: string | null;
  accrual_date: string;
  category_id: string;
  category_group: CategoryGroup;
  account_nature: AccountNature;
  amount: string;
  charged_to: ChargedTo;
  allocation_basis: AllocationBasis;
  unit_type: UnitType;
  unit_number: string | null;
  paid_by_entity_id: string | null;
  counterparty_entity_id: string | null;
  split_driver_share: string | null;
}

/**
 * Loads the ledger rows a P&L period needs, already carrying the category
 * facts the engine must not infer.
 *
 * `split_driver_share` comes from the chargeback decision currently
 * standing for the row — the one nothing supersedes. `ledger_entry.charged_to`
 * records *that* a cost was split and never the ratio, so without this join
 * a split row reaches the engine indistinguishable from `'unknown'` and is
 * excluded from company cost and flagged for a human. That is the correct
 * behaviour when the ratio genuinely is not known; it is the wrong answer
 * when somebody already decided it, which is what this join prevents.
 */
export async function loadSummaryEntries(
  filter: SummaryEntryFilter,
): Promise<SummaryLedgerEntry[]> {
  const params: unknown[] = [filter.from, filter.to];
  const clauses = ['le.accrual_date BETWEEN $1::date AND $2::date'];

  if (filter.entityId) {
    params.push(filter.entityId);
    clauses.push(`le.entity_id = $${params.length}`);
  }
  if (filter.truckId) {
    params.push(filter.truckId);
    clauses.push(`le.truck_id = $${params.length}`);
  }

  const rows = (await query(
    `SELECT le.entry_id,
            le.entity_id,
            le.truck_id,
            to_char(le.accrual_date, 'YYYY-MM-DD') AS accrual_date,
            le.category_id,
            c.category_group,
            c.account_nature,
            le.amount,
            le.charged_to,
            le.allocation_basis,
            le.unit_type,
            le.unit_number,
            le.paid_by_entity_id,
            le.counterparty_entity_id,
            cd.split_driver_share
       FROM accounting.ledger_entry le
       JOIN accounting.category c ON c.category_id = le.category_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(
                  d.split_amount,
                  CASE WHEN d.split_percent IS NOT NULL
                       THEN round(abs(le.amount) * d.split_percent / 100, 2)
                  END
                ) AS split_driver_share
           FROM accounting.chargeback_decision d
          WHERE d.ledger_entry_id = le.entry_id
            AND NOT EXISTS (
              SELECT 1 FROM accounting.chargeback_decision later
               WHERE later.supersedes_id = d.decision_id
            )
          ORDER BY d.decided_at DESC
          LIMIT 1
       ) cd ON true
      WHERE ${clauses.join(' AND ')}
      ORDER BY le.accrual_date, le.entry_id`,
    params,
  )) as unknown as SummaryEntryDbRow[];

  return rows.map((r) => ({
    entryId: r.entry_id,
    entityId: r.entity_id,
    truckId: r.truck_id,
    accrualDate: r.accrual_date,
    categoryId: r.category_id,
    categoryGroup: r.category_group,
    accountNature: r.account_nature,
    // NUMERIC comes back as a string (src/db/pool.ts pins the parser) and
    // is passed straight through. Nothing here calls Number() on money.
    amount: r.amount,
    chargedTo: r.charged_to,
    allocationBasis: r.allocation_basis,
    unitType: r.unit_type,
    unitNumber: r.unit_number,
    paidByEntityId: r.paid_by_entity_id,
    counterpartyEntityId: r.counterparty_entity_id,
    splitDriverShare: r.split_driver_share,
  }));
}
