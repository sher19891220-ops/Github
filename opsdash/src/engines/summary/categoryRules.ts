/**
 * Which rows belong on a P&L, and at which level.
 *
 * This file used to answer that by looking at the category *name* — a
 * regex for the word "principal", plus a hardcoded id for the prepaid
 * registration asset — because `accounting.category` carried only a group
 * and a sign and could not say what kind of account a category was.
 *
 * Migration 009 added `account_nature`, so the guess is gone. The name
 * rule did not disappear, it moved: it is now a CHECK on the category
 * table, applied once when a category is defined, where a person is right
 * there to correct it. That is a strictly better place for it than a
 * filter running over every ledger row forever — a genuine expense
 * category that happened to contain the word "principal" used to vanish
 * from every P&L at every grain with nothing anywhere saying why.
 *
 * What is left here reads the flag and nothing else.
 */
import type { AccountNature } from '@/contract/types';

/** The shape both rules need: a row that knows what kind of account it
 *  came from. Deliberately structural rather than `SummaryLedgerEntry`, so
 *  these stay usable from anywhere that has resolved the nature. */
export interface HasAccountNature {
  accountNature: AccountNature;
}

/**
 * An asset/liability movement, not a recognized expense. Excluded from
 * EVERY rollup level — truck, entity and group alike.
 *
 * The two cases this exists for, both measured on real documents:
 *
 *  - `prepaid.registration`: the IRP/HVUT invoice is booked once, in full,
 *    as a prepaid asset precisely so the real cost reaches the P&L through
 *    twelve monthly `permit.irp` / `tax.hvut` recognitions. Counting the
 *    payment as well double-counts the year — the truck reads
 *    catastrophically unprofitable for one day and free for the rest of it.
 *
 *  - loan principal: only interest is a cost. Principal repayment is debt
 *    going down, not money spent. Booking whole payments overstates cost by
 *    roughly $29.50 per truck per day on this fleet.
 *
 * Every row this excludes is counted and reported rather than silently
 * dropped — see `excludedBalanceSheetTotal`/`Count` on every `PnlBucket`
 * and `excludedPrincipalTotal`/`Count` on `WorkQueueSummary`.
 */
export function isBalanceSheetEntry(entry: HasAccountNature): boolean {
  return entry.accountNature === 'balance_sheet';
}

/**
 * One leg of a balance between two entities in this group.
 *
 * Per CLAUDE.md §2 rule 2: a per-entity roll-up keeps these — they are a
 * real fact about that one entity's books — and a GROUP roll-up drops
 * them, which is exactly `accounting.v_ledger_consolidated`'s job. Mixing
 * the two counts the same dollar twice.
 */
export function isIntercompanyEntry(entry: HasAccountNature): boolean {
  return entry.accountNature === 'intercompany';
}

/** Mirrors `accounting.v_ledger_consolidated`: the same rows, minus both
 *  intercompany legs. Use for a GROUP total; never for a single entity's
 *  own view. */
export function stripIntercompany<T extends HasAccountNature>(entries: readonly T[]): T[] {
  return entries.filter((e) => !isIntercompanyEntry(e));
}
