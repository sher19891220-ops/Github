/**
 * Rendering for decimal strings — the only money path the UI is allowed to
 * use. `Decimal` (contract/types.ts) crosses the wire as a string precisely
 * so a JSON-number round trip never happens; this module keeps that promise
 * on the way back out. Every function here is string/regex manipulation.
 * Nothing calls `Number()` or `parseFloat` on a money value, and nothing
 * does arithmetic that could reintroduce float error — grep this file if
 * that ever needs re-checking.
 */

import type { Decimal } from '@/contract/types';

/** Matches the shape produced by the server: optional sign, digits, optional
 *  fractional digits. Deliberately more permissive than `isDecimal` (which
 *  caps fractional digits at 4) because this module also renders the
 *  6-decimal `AnalysisRate` strings from the registration engine — display
 *  never rejects precision the source actually sent. */
const DECIMAL_SHAPE = /^(-)?(\d+)(?:\.(\d+))?$/;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface FormatDecimalOptions {
  /** Shown when the value is null/undefined. Default '—'. */
  placeholder?: string;
  /** Pad the fractional part to at least this many digits. Never truncates
   *  real digits the source sent — padding only adds trailing zeros. */
  minFractionDigits?: number;
}

/**
 * Formats a decimal string for display: groups the integer part with
 * thousands separators and pads (never rounds or truncates) the fractional
 * part. If the input isn't shaped like a decimal at all, it is returned
 * verbatim rather than guessed at — a malformed value should be visible,
 * not silently coerced into a plausible-looking number.
 */
export function formatDecimalString(
  value: Decimal | string | null | undefined,
  opts: FormatDecimalOptions = {},
): string {
  const { placeholder = '—', minFractionDigits = 0 } = opts;
  if (value == null) return placeholder;
  const trimmed = String(value).trim();
  const m = DECIMAL_SHAPE.exec(trimmed);
  if (!m) return trimmed; // surfaced as-is; never coerced into a guessed number
  const sign = m[1] ?? '';
  const whole = m[2] ?? '0';
  const frac = (m[3] ?? '').padEnd(minFractionDigits, '0');
  return frac.length > 0 ? `${sign}${groupThousands(whole)}.${frac}` : `${sign}${groupThousands(whole)}`;
}

/** Money is always `numeric(14,2)` on the wire — two decimal places,
 *  grouped, sign preserved. */
export function formatMoney(value: Decimal | null | undefined, placeholder = '—'): string {
  return formatDecimalString(value, { placeholder, minFractionDigits: 2 });
}

/** Quantities (gallons, miles) are `numeric(14,4)` — up to four decimal
 *  places, whatever precision the source actually carried. */
export function formatQuantity(value: Decimal | null | undefined, placeholder = '—'): string {
  return formatDecimalString(value, { placeholder, minFractionDigits: 0 });
}

/** The registration engine's 6-decimal `AnalysisRate` strings
 *  (`overheadRate.ts`). Never posted, so never rounded to 2dp for display —
 *  truncating precision here would misrepresent the exact-reconstruction
 *  property the engine guarantees. */
export function formatRate(value: string | null | undefined, placeholder = '—'): string {
  return formatDecimalString(value, { placeholder, minFractionDigits: 6 });
}
