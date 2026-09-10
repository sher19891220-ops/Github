import type { IsoDate } from '@/contract/types';

/** Truncates any ISO date down to the first of its month, e.g. `2026-09-17` -> `2026-09-01`. */
export function toPeriodMonth(isoDate: IsoDate): IsoDate {
  return `${isoDate.slice(0, 7)}-01`;
}

export function periodMonthOf(year: number, month1to12: number): IsoDate {
  return `${String(year).padStart(4, '0')}-${String(month1to12).padStart(2, '0')}-01`;
}

/** Adds (or subtracts, for negative `n`) whole calendar months to a period-month. */
export function addMonths(periodMonth: IsoDate, n: number): IsoDate {
  const [y, m] = periodMonth.split('-').map(Number) as [number, number];
  const totalMonths = y * 12 + (m - 1) + n;
  const ny = Math.floor(totalMonths / 12);
  const nm = ((totalMonths % 12) + 12) % 12; // 0-based, always positive
  return periodMonthOf(ny, nm + 1);
}

/** The `count` consecutive period-months starting at `startPeriodMonth`, inclusive. */
export function monthRange(startPeriodMonth: IsoDate, count: number): IsoDate[] {
  return Array.from({ length: count }, (_, i) => addMonths(startPeriodMonth, i));
}

/**
 * A month "has closed" once the calendar has moved past its last day —
 * i.e. `asOf` has reached the first day of the *next* month. A registration
 * paid on 2026-09-09 for coverage starting 2026-09 must NOT post September's
 * share as an actual on the 9th: September has not ended yet. This is what
 * keeps a future (or even same-month) schedule row a commitment rather than
 * a posted ledger entry.
 */
export function isMonthClosed(periodMonth: IsoDate, asOf: IsoDate): boolean {
  const nextMonth = addMonths(periodMonth, 1);
  // ISO 'YYYY-MM-DD' strings compare lexicographically exactly like dates.
  return asOf >= nextMonth;
}
