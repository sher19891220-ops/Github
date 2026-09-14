/**
 * Pure chargeback-decision logic. Same split as `review/logic.ts` and
 * `reconciliation/logic.ts`: no React/DOM here, so the queue screen, the
 * bulk-apply action and the mock API all share one definition of "a valid
 * decision" and one definition of "what a driver now owes".
 */

import type { Decimal, DriverClass } from '@/contract/types';
import { addMoney, moneyToCents } from '../format/decimal';
import type { ChargebackDecision, ChargebackRow, ChargedTo, SplitRatio } from '../data/types';

/**
 * `split` is not a decision without a ratio — enforced here, not just by
 * the type (a caller can still construct `{ chargedTo: 'split', splitRatio:
 * null }` in JS, so this is the actual gate the UI and the mock API call
 * before accepting anything).
 */
export function isValidDecision(decision: Pick<ChargebackDecision, 'chargedTo' | 'splitRatio'>): boolean {
  if (decision.chargedTo === 'split') {
    const ratio = decision.splitRatio;
    if (!ratio) return false;
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(ratio.driverShare.trim())) return false;
    if (ratio.kind === 'percentage') {
      const cents = moneyToCents(ratio.driverShare); // reuses the same exact-decimal parse; a percentage is just a bounded decimal
      return cents >= 0n && cents <= 10000n; // 0.00–100.00
    }
    // kind === 'amount': any non-negative money value is structurally valid;
    // whether it exceeds the row's total is a business check the caller can
    // add, not a shape check.
    return moneyToCents(ratio.driverShare) >= 0n;
  }
  // company / driver / unknown never carry a ratio — a stray one would
  // misleadingly suggest a split that was never actually decided.
  return decision.splitRatio === null;
}

export function invalidDecisionReason(decision: Pick<ChargebackDecision, 'chargedTo' | 'splitRatio'>): string | null {
  if (isValidDecision(decision)) return null;
  if (decision.chargedTo === 'split') {
    if (!decision.splitRatio) return 'A split needs an amount or a percentage — pick one.';
    if (decision.splitRatio.kind === 'percentage') return 'Percentage split must be between 0 and 100.';
    return 'Split amount must be a valid, non-negative money value.';
  }
  return `"${decision.chargedTo}" does not take a split ratio.`;
}

/** Exact driver share, in cents, of a cost row's absolute amount, given a
 *  validated split ratio. BigInt fixed-point throughout — a percentage
 *  split multiplies two decimal strings, which is exactly the operation
 *  CLAUDE.md's "money is never a float" rule exists to protect. */
export function driverShareCents(rowAmount: Decimal, ratio: SplitRatio): bigint {
  const totalAbsCents = absCents(moneyToCents(rowAmount));
  if (ratio.kind === 'amount') {
    const shareCents = absCents(moneyToCents(ratio.driverShare));
    return shareCents > totalAbsCents ? totalAbsCents : shareCents;
  }
  // percentage: driverShare is e.g. "60.00" meaning 60.00% — scale as an
  // integer-cents-of-percent (10000 = 100.00%) fixed-point multiply, round
  // half-up, never touch a float.
  const pctCents = moneyToCents(ratio.driverShare); // 0..10000, hundredths of a percent
  const product = totalAbsCents * pctCents; // scaled by 10^4
  const half = 5000n;
  return (product + half) / 10000n;
}

function absCents(c: bigint): bigint {
  return c < 0n ? -c : c;
}

/** What a single decided row contributes to the driver's running total —
 *  `'0.00'` for `company`/`unknown`, the full row amount for `driver`, the
 *  computed share for `split`. Always the driver's *cost* as a positive
 *  money string (what they owe), never signed the way the ledger amount is. */
export function driverOwedFromRow(row: Pick<ChargebackRow, 'amount' | 'decision'>): Decimal {
  const decision = row.decision;
  if (!decision || !isValidDecision(decision)) return '0.00';
  const totalAbsCents = absCents(moneyToCents(row.amount));
  if (decision.chargedTo === 'driver') return centsToDecimal(totalAbsCents);
  if (decision.chargedTo === 'split' && decision.splitRatio) {
    return centsToDecimal(driverShareCents(row.amount, decision.splitRatio));
  }
  return '0.00';
}

function centsToDecimal(cents: bigint): Decimal {
  const whole = cents / 100n;
  const frac = cents % 100n;
  return `${whole.toString()}.${frac.toString().padStart(2, '0')}`;
}

/** Running total, by driver id, of what each driver now owes across a set
 *  of (already-decided) rows — the consequence the task brief says the
 *  decider must see before applying a `driver`/`split` decision. Rows with
 *  no `driverId` or no decision yet do not contribute. */
export function runningDriverTotals(rows: readonly ChargebackRow[]): Map<string, Decimal> {
  const totals = new Map<string, Decimal>();
  for (const row of rows) {
    if (!row.driverId || !row.decision) continue;
    const owed = driverOwedFromRow(row);
    if (owed === '0.00') continue;
    totals.set(row.driverId, addMoney(totals.get(row.driverId) ?? '0.00', owed));
  }
  return totals;
}

/**
 * Orders the queue densest-first: rows are grouped by `(driverId, vendor)`
 * — the pairing most likely to share one correct decision (the same
 * driver's repairs at the same vendor almost always go the same way) — and
 * the largest groups sort to the top, with rows inside a group kept
 * adjacent so a bulk-select naturally covers one group at a time. This is
 * what makes 713 `unknown` rows tractable: the person deciding clears the
 * biggest cluster with one bulk action instead of touching each row once.
 */
export function densestFirst(rows: readonly ChargebackRow[]): ChargebackRow[] {
  const key = (r: ChargebackRow) => `${r.driverId ?? '∅'}::${(r.vendor ?? '∅').trim().toLowerCase()}`;
  const groups = new Map<string, ChargebackRow[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = groups.get(k);
    if (bucket) bucket.push(row);
    else groups.set(k, [row]);
  }
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
  return ordered.flatMap((group) => [...group].sort((a, b) => (a.accrualDate ?? '').localeCompare(b.accrualDate ?? '')));
}

/** Applies one decision to every row in `rowIds` and no other row — the
 *  bulk-apply guarantee the task brief calls out explicitly. Rows not in
 *  `rowIds` come back byte-identical (same reference). */
export function applyBulkDecision(
  rows: readonly ChargebackRow[],
  rowIds: ReadonlySet<string>,
  decision: ChargebackDecision,
): ChargebackRow[] {
  if (!isValidDecision(decision)) {
    throw new Error(invalidDecisionReason(decision) ?? 'Invalid decision');
  }
  return rows.map((row) =>
    rowIds.has(row.costRowId)
      ? { ...row, chargedTo: decision.chargedTo, decision }
      : row,
  );
}

export function needsDecision(row: Pick<ChargebackRow, 'chargedTo' | 'decision'>): boolean {
  return row.chargedTo === 'unknown' && row.decision == null;
}

export type { ChargedTo, DriverClass, SplitRatio };
