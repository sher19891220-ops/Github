/**
 * Decimal-string arithmetic and amount parsing for the extraction layer.
 *
 * "Money is never a float" (CLAUDE.md §2) applies here as much as anywhere
 * else: every function in this file either returns a decimal *string* or
 * does its arithmetic in fixed-point integers (scaled by 10^4 via BigInt),
 * never a JS `number`, so nothing in the money path round-trips through an
 * IEEE double.
 */
import { isDecimal, type Decimal } from '@/contract/types';
import { flaggedField, cleanField, type ExtractedField } from './types';

const SCALE = 10000n; // 4 decimal places, matching contract.ts's DECIMAL_RE

function toMicros(dec: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(dec);
  if (!m) throw new Error(`not a wire-legal decimal string: "${dec}"`);
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = BigInt(m[2] ?? '0');
  const fracRaw = (m[3] ?? '').padEnd(4, '0');
  const fracPart = BigInt(fracRaw === '' ? '0' : fracRaw);
  return sign * (intPart * SCALE + fracPart);
}

function fromMicros(v: bigint): string {
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  const intPart = abs / SCALE;
  const frac = abs % SCALE;
  const fracStr = frac.toString().padStart(4, '0').replace(/0+$/, '');
  return sign + intPart.toString() + (fracStr ? `.${fracStr}` : '');
}

/** Exact decimal-string addition — no float ever touches the values. */
export function sumDecimals(values: readonly string[]): Decimal {
  const total = values.reduce((acc, v) => acc + toMicros(v), 0n);
  return fromMicros(total);
}

export interface SumCheckResult {
  ok: boolean;
  computedSum: Decimal;
  statedTotal: Decimal;
  /** computedSum - statedTotal, exact. */
  difference: Decimal;
}

/**
 * "Totals that don't sum" (CLAUDE.md §2 / SOURCE-DISCOVERY.md §14): if a
 * document states a total and its lines don't add to it, every line must be
 * flagged — never trust either the lines or the total silently. Callers use
 * `ok` to decide whether to flag the whole set; this function never guesses
 * which side is wrong.
 */
export function checkTotalsSum(lineAmounts: readonly string[], statedTotal: string): SumCheckResult {
  const computedSum = sumDecimals(lineAmounts);
  const difference = fromMicros(toMicros(computedSum) - toMicros(statedTotal));
  return { ok: toMicros(difference) === 0n, computedSum, statedTotal, difference };
}

/**
 * Parses a free-text money cell into a wire-legal decimal string, surviving
 * the shapes SOURCE-DISCOVERY.md documents from the real sheets: `$2,400.00`,
 * bare `3000`, `$ 2,346` (leading space), `3.56$` (suffix sign),
 * parenthesised negatives `($40.00)`. Never returns a JS number, and never
 * fabricates a value for unparseable input — an empty/unparseable cell comes
 * back as `value: null`, needing review, not a zero.
 */
export function extractMoney(raw: string): ExtractedField<Decimal> {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return flaggedField<Decimal>(null, 0, 'empty amount cell — no figure to read, not a zero.');
  }

  const isParenNegative = /^\(.*\)$/.test(trimmed);
  const stripped = trimmed
    .replace(/^\(|\)$/g, '')
    .replace(/\$/g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '')
    .trim();

  if (!/^-?\d+(\.\d+)?$/.test(stripped)) {
    return flaggedField<Decimal>(null, 0, `"${raw}" does not parse as an amount.`);
  }

  const negative = isParenNegative || stripped.startsWith('-');
  const magnitude = stripped.replace(/^-/, '');
  const candidate = (negative ? '-' : '') + magnitude;

  if (!isDecimal(candidate)) {
    return flaggedField<Decimal>(null, 0, `"${raw}" parsed to "${candidate}", which fails wire decimal validation.`);
  }

  return cleanField(candidate, 0.9);
}
