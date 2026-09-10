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

/** Last calendar day of a period-month, as an ISO date, e.g. `2027-08-01` ->
 *  `2027-08-31`. Computed via "day 0 of the next month", which JS's `Date`
 *  resolves correctly for every month including February in a leap year —
 *  no hardcoded 28/30/31 table to get wrong. */
export function lastDayOfPeriodMonth(periodMonth: IsoDate): IsoDate {
  const [y, m] = periodMonth.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of month `m` (1-indexed) = last day of month `m`
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Inclusive day count between two ISO dates, computed in UTC so no local
 * timezone can shift either date across a midnight boundary. This is what
 * lets a per-truck daily rate be computed from the real coverage window
 * (e.g. 365 days for 2026-09-01..2027-08-31) instead of assuming a fixed
 * 365 and quietly drifting wrong on the next leap-year renewal.
 */
export function daysBetweenInclusive(startIso: IsoDate, endIso: IsoDate): number {
  const [sy, sm, sd] = startIso.split('-').map(Number) as [number, number, number];
  const [ey, em, ed] = endIso.split('-').map(Number) as [number, number, number];
  const startUtc = Date.UTC(sy, sm - 1, sd);
  const endUtc = Date.UTC(ey, em - 1, ed);
  const diffDays = Math.round((endUtc - startUtc) / 86_400_000);
  if (diffDays < 0) {
    throw new Error(`Coverage end ${endIso} is before coverage start ${startIso}`);
  }
  return diffDays + 1;
}
