/**
 * `GET /api/ledger` — read-only, filtered listing of `ledger_entry`.
 *
 * Queries the base table, not `accounting.v_ledger_consolidated`: that view
 * drops intercompany legs and exists specifically for a group roll-up
 * (migration 004's comment is explicit that mixing the two double-counts).
 * A single-entity or single-truck slice, which is what these filters are
 * for, wants the base table.
 */
import type { LedgerEntry } from '@/contract/types';
import { query } from '@/db/pool';
import { LEDGER_ENTRY_COLUMNS_SQL, mapDbRowToLedgerEntry } from './mappers';

export interface LedgerFilter {
  entityId?: string;
  truckId?: string;
  driverId?: string;
  categoryId?: string;
  /** Inclusive accrual_date lower bound, YYYY-MM-DD. */
  from?: string;
  /** Inclusive accrual_date upper bound, YYYY-MM-DD. */
  to?: string;
}

export async function listLedgerEntries(filter: LedgerFilter): Promise<LedgerEntry[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const add = (column: string, value: string): void => {
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  };

  if (filter.entityId) add('entity_id', filter.entityId);
  if (filter.truckId) add('truck_id', filter.truckId);
  if (filter.driverId) add('driver_id', filter.driverId);
  if (filter.categoryId) add('category_id', filter.categoryId);
  if (filter.from) {
    params.push(filter.from);
    clauses.push(`accrual_date >= $${params.length}::date`);
  }
  if (filter.to) {
    params.push(filter.to);
    clauses.push(`accrual_date <= $${params.length}::date`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await query(
    `SELECT ${LEDGER_ENTRY_COLUMNS_SQL} FROM accounting.ledger_entry ${where} ORDER BY accrual_date, entry_id`,
    params,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r) => mapDbRowToLedgerEntry(r as any));
}
