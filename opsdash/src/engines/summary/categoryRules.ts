/**
 * Category-taxonomy decisions the P&L rollup needs that
 * `accounting.category` cannot express today.
 *
 * The category table (migration 001) carries only `category_group` and
 * `sign` — nothing marking a row as a balance-sheet movement rather than a
 * recognized expense, and nothing marking two rows as the two legs of one
 * intercompany balance beyond the fixed category ids migration 004 created.
 * Both distinctions are load-bearing for CLAUDE.md §2, so they live here,
 * documented, rather than being silently baked into arithmetic further down.
 */

/**
 * Categories that represent an asset/liability movement, not a recognized
 * P&L expense — excluded from EVERY rollup level (truck, entity, group).
 *
 * `prepaid.registration` (migration 003) is the one that exists today: the
 * IRP/HVUT invoice payment is booked once, in full, as a prepaid asset
 * specifically so the real expense — the twelve monthly `permit.irp` /
 * `tax.hvut` entries this same engine also sees — is what hits the P&L.
 * Summing this row too would double the true annual cost: once here, once
 * again through every month's recognition (exactly the failure
 * SOURCE-DISCOVERY §11c warns "makes that truck catastrophically
 * unprofitable for a day and free for the rest of the year").
 */
export const BALANCE_SHEET_CATEGORY_IDS: ReadonlySet<string> = new Set(['prepaid.registration']);

const PRINCIPAL_PATTERN = /principal/i;

/**
 * SOURCE-DISCOVERY §15: only interest is a cost in equipment financing;
 * principal repayment is a balance-sheet movement (debt going down), not an
 * expense — booking the whole payment overstates cost by "roughly $29.50
 * per truck per day on this fleet." No loan/lease-financing category exists
 * in `accounting.category` yet (§15 is explicit: "open, and needed before
 * any of this posts"), so this is a defensive net for whenever one is
 * added, keyed on the word itself because there is no structural flag to
 * key on instead. Every row it catches is counted and reported (see
 * `excludedBalanceSheetTotal`/`Count` on every `PnlBucket`, and
 * `excludedPrincipalTotal`/`Count` on `WorkQueueSummary`) — never silently
 * dropped.
 */
export function isPrincipalCategory(categoryId: string): boolean {
  return PRINCIPAL_PATTERN.test(categoryId);
}

export function isBalanceSheetCategory(categoryId: string): boolean {
  return BALANCE_SHEET_CATEGORY_IDS.has(categoryId) || isPrincipalCategory(categoryId);
}

/**
 * The two legs migration 004 created for a recharge that crosses entities.
 * Per CLAUDE.md §2 rule 2: a per-entity roll-up uses the base rows (these
 * legs included — they are a real fact about that one entity's books), a
 * GROUP roll-up must drop them (`accounting.v_ledger_consolidated`'s exact
 * job), or the same dollar is counted twice.
 */
export const INTERCOMPANY_CATEGORY_IDS: ReadonlySet<string> = new Set([
  'receivable.intercompany',
  'payable.intercompany',
]);

export function isIntercompanyCategory(categoryId: string): boolean {
  return INTERCOMPANY_CATEGORY_IDS.has(categoryId);
}

/** Mirrors `accounting.v_ledger_consolidated`: the same rows, minus both
 *  intercompany legs. Use for a GROUP total; never for a single entity's
 *  own view. */
export function stripIntercompany<T extends { categoryId: string }>(entries: readonly T[]): T[] {
  return entries.filter((e) => !isIntercompanyCategory(e.categoryId));
}
