/**
 * Per-truck fixed-cost overhead rate: turns an annual cost into the daily
 * and weekly analysis rates the operator wants for per-truck margin
 * decisions, alongside the monthly figure that's actually posted.
 *
 * Deliberately NOT registration-specific: `computeOverheadRate` takes
 * nothing but an annual total (in cents) and a coverage window. Insurance,
 * permits and ELD can feed this exact same function later just by calling
 * it with their own annual total and coverage window — registration is
 * only its first caller (see `postRegistration.ts`, which tags the result
 * with `categoryIds: ['permit.irp', 'tax.hvut']`).
 *
 * `monthlyLedger` IS the posted accounting truth — the same base (no
 * remainder-penny) monthly figure already amortized into
 * `scheduleRows`/`postedEntries` via `evenSplitCents`. It reconciles
 * exactly and is safe to sum across trucks.
 *
 * `dailyRate` and `weeklyRate` are DERIVED analysis rates. They are never
 * posted to the ledger — 42 trucks x 365 days would be 15,330 entries a
 * year for registration alone, with no accuracy gain over the monthly
 * grain the ledger already posts at. Because a "week" is a fixed 7-day
 * unit while a real coverage year is 365 or 366 days, `weeklyRate * 52`
 * will NOT equal `annualTotal` (52 weeks is 364 days, one or two short of
 * the real year) — that gap is expected for a rate and must never be
 * "fixed" by fudging the number. What DOES hold, exactly, for any coverage
 * window, is `dailyRate * coverageDays === annualTotal` to the cent — see
 * `AnalysisRate` for why six decimal places of precision is what makes
 * that reconstruction exact rather than approximate.
 */

import type { Decimal, IsoDate } from '@/contract/types';
import { daysBetweenInclusive } from './dates';
import { decimalFromCents, evenSplitCents } from './money';

/**
 * A decimal string carrying more precision than `Decimal` (contract/types.ts
 * caps `isDecimal` at 4 fractional digits, the tier reserved for ledger
 * `quantity` fields). `dailyRate`/`weeklyRate` need six digits so that
 * `dailyRate * coverageDays` rounds back to the annual total to the cent
 * for any real coverage window (up to ~366 days, the rounding error from a
 * single six-decimal-place division is at most ~0.02 cents accumulated —
 * comfortably under the half-cent that would flip a rounded result). These
 * values are never posted to a `numeric(14,2)` ledger column, so they never
 * need to satisfy the ledger's `isDecimal` wire check — but they are still
 * a decimal STRING, never a float, all the way through.
 */
export type AnalysisRate = string;

/** Units per dollar for `AnalysisRate` values: dollars * 1e6. */
const RATE_SCALE = 1_000_000;

function decimalFromScaled(scaled: number): AnalysisRate {
  if (!Number.isInteger(scaled)) {
    throw new Error(`decimalFromScaled requires an integer, got ${scaled}`);
  }
  const sign = scaled < 0 ? '-' : '';
  const abs = Math.abs(scaled);
  const whole = Math.trunc(abs / RATE_SCALE);
  const frac = abs % RATE_SCALE;
  return `${sign}${whole}.${String(frac).padStart(6, '0')}`;
}

const ANALYSIS_RATE_RE = /^(-)?(\d{1,15})\.(\d{6})$/;

/** Inverse of `decimalFromScaled` — parses an `AnalysisRate` back into an
 *  exact integer count of "dollars * 1e6" units, entirely via string/int
 *  operations (never `Number()`/`parseFloat` on the whole value). Exported
 *  so callers (and tests) can verify the exact-reconstruction property
 *  without resorting to float arithmetic themselves. */
export function scaledFromAnalysisRate(rate: AnalysisRate): number {
  const m = ANALYSIS_RATE_RE.exec(rate.trim());
  if (!m) {
    throw new Error(`Not a valid 6-decimal analysis rate: ${JSON.stringify(rate)}`);
  }
  const sign = m[1] === '-' ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number(m[3]);
  return sign * (whole * RATE_SCALE + frac);
}

export interface OverheadRateInput {
  /** The full coverage-period cost, in integer cents — exact, never a
   *  float, matching every other money value in this engine. */
  annualCents: number;
  /** First day of the coverage period, inclusive. */
  coverageStart: IsoDate;
  /** Last day of the coverage period, inclusive. */
  coverageEnd: IsoDate;
}

export interface OverheadRate {
  annualTotal: Decimal;
  coverageStart: IsoDate;
  coverageEnd: IsoDate;
  coverageDays: number;
  /** Analysis rate only — see module doc. Never posted. */
  dailyRate: AnalysisRate;
  /** Analysis rate only, `dailyRate * 7` exactly — see module doc. Never posted. */
  weeklyRate: AnalysisRate;
  /** The posted accounting truth: `annualTotal` amortized 1/12, the same
   *  base figure already recognized monthly in the ledger. */
  monthlyLedger: Decimal;
}

export function computeOverheadRate(input: OverheadRateInput): OverheadRate {
  const { annualCents, coverageStart, coverageEnd } = input;
  if (!Number.isInteger(annualCents) || annualCents < 0) {
    throw new Error(`computeOverheadRate requires a non-negative integer annualCents, got ${annualCents}`);
  }
  const coverageDays = daysBetweenInclusive(coverageStart, coverageEnd);
  if (coverageDays <= 0) {
    throw new Error(`Coverage period ${coverageStart}..${coverageEnd} has no days`);
  }

  // annualCents * (RATE_SCALE / 100) is exact integer arithmetic: RATE_SCALE
  // is a multiple of 100, so no fractional cent is ever created here — the
  // only rounding in this whole function is the single division below,
  // exactly like `evenSplitCents`'s single floor division.
  const annualScaled = annualCents * (RATE_SCALE / 100);
  const dailyRateScaled = Math.round(annualScaled / coverageDays);
  const weeklyRateScaled = dailyRateScaled * 7;

  const monthlyShares = evenSplitCents(annualCents, 12);
  const monthlyLedgerCents = Math.min(...monthlyShares);

  return {
    annualTotal: decimalFromCents(annualCents),
    coverageStart,
    coverageEnd,
    coverageDays,
    dailyRate: decimalFromScaled(dailyRateScaled),
    weeklyRate: decimalFromScaled(weeklyRateScaled),
    monthlyLedger: decimalFromCents(monthlyLedgerCents),
  };
}
