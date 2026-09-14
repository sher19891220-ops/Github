/**
 * Integer-cents money helpers for the registration engine.
 *
 * Every figure this engine touches is `numeric(14,2)` in Postgres and a
 * decimal string on the wire (`Decimal` in contract/types.ts). Converting to
 * an integer count of cents and back is not "using a float" — it is the
 * standard way to do exact money arithmetic in a language whose only numeric
 * type is a double: as long as every intermediate value stays an integer
 * (never a fractional multiply/divide), the representation is exact for any
 * amount this business will ever see. What is NOT allowed anywhere in this
 * file is parsing a decimal string through `Number()`/`parseFloat` and doing
 * arithmetic on the fractional result — that is exactly how "$78,959.21 / 42"
 * loses the nickel.
 */

const MONEY_RE = /^(-)?(\d{1,12})(?:\.(\d{1,2}))?$/;

/** Parses a `Decimal` money string into an exact integer count of cents. */
export function centsFromDecimal(value: string): number {
  const m = MONEY_RE.exec(value.trim());
  if (!m) {
    throw new Error(`Not a valid money decimal string (at most 2 decimal places): ${JSON.stringify(value)}`);
  }
  const sign = m[1] === '-' ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  return sign * (whole * 100 + frac);
}

/** Formats an exact integer count of cents back into a `Decimal` money string. */
export function decimalFromCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`decimalFromCents requires an integer number of cents, got ${cents}`);
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

export function sumCents(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/**
 * Splits `totalCents` into `n` integer shares that sum back to `totalCents`
 * exactly, using the largest-remainder method: every share gets the floor
 * division result, and the leftover cents (always < n) go one-per-share to
 * the FIRST `remainder` entries in whatever order the caller passed them in.
 *
 * The caller is responsible for putting its items in a stable, deterministic
 * order before calling this (e.g. sorted by VIN, or chronological months) —
 * this function does not know or care what the entries represent, only that
 * position in the input order is the tie-breaker. That is what makes the
 * split reproducible: the same invoice run twice produces the same pennies
 * on the same units every time.
 */
export function evenSplitCents(totalCents: number, n: number): number[] {
  if (!Number.isInteger(totalCents)) {
    throw new Error(`evenSplitCents requires an integer totalCents, got ${totalCents}`);
  }
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`evenSplitCents requires a positive integer n, got ${n}`);
  }
  const negative = totalCents < 0;
  const magnitude = Math.abs(totalCents);
  const base = Math.floor(magnitude / n);
  const remainder = magnitude - base * n;
  const shares = Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
  return negative ? shares.map((s) => -s) : shares;
}
