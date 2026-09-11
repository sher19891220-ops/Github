/**
 * Period-boundary math for the five grains the P&L screen needs
 * (day/week/month/quarter/year), all built from one primitive (`periodFor`)
 * so that "the parts sum to the whole" holds: every grain partitions exactly
 * the calendar days asked for, nothing more and nothing less.
 *
 * That last clause is load-bearing and was not free. `periodFor` returns the
 * WHOLE period containing a date, which for a series means the first and
 * last buckets can reach outside the requested range — and an ISO week does
 * not respect a year boundary at all. Measured before the fix: a weekly
 * series for calendar 2026 covered 2025-12-29 to 2027-01-03, so a truck with
 * $5,000 booked on 30 Dec 2025, $1,000 in June 2026 and $7,000 on 2 Jan 2027
 * summed to $13,000 across the weeks while the year period reported $1,000.
 * Both figures rendered as "2026 revenue".
 *
 * `periodsCovering` therefore CLAMPS each period to the requested range. A
 * partial first or last bucket reports the days it actually covers, so the
 * screen can see it is partial instead of the extra days being folded in
 * invisibly.
 *
 * Month/quarter/year arithmetic reuses `@/engines/registration`'s date
 * helpers (already exact for leap years etc.) rather than re-deriving it —
 * read-only import, nothing in that engine is modified.
 */
import type { Grain, IsoDate } from '@/contract/types';
import {
  addMonths,
  daysBetweenInclusive,
  lastDayOfPeriodMonth,
  periodMonthOf,
  toPeriodMonth,
} from '@/engines/registration';
import type { Period } from './types';

function toUtcDate(iso: IsoDate): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtcDate(d: Date): IsoDate {
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Adds (or subtracts, for negative `n`) whole calendar days, in UTC. */
export function addDaysIso(iso: IsoDate, n: number): IsoDate {
  const d = toUtcDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtcDate(d);
}

/** Monday-start, Sunday-end ISO week containing `accrualDate`. */
function weekPeriod(accrualDate: IsoDate): Period {
  const dow = toUtcDate(accrualDate).getUTCDay(); // 0 Sun .. 6 Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const periodStart = addDaysIso(accrualDate, mondayOffset);
  const periodEnd = addDaysIso(periodStart, 6);
  return { periodStart, periodEnd };
}

function quarterPeriod(accrualDate: IsoDate): Period {
  const monthStart = toPeriodMonth(accrualDate);
  const [y, m] = monthStart.split('-').map(Number) as [number, number];
  const quarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const periodStart = periodMonthOf(y, quarterStartMonth);
  const periodEnd = lastDayOfPeriodMonth(addMonths(periodStart, 2));
  return { periodStart, periodEnd };
}

function yearPeriod(accrualDate: IsoDate): Period {
  const [y] = toPeriodMonth(accrualDate).split('-').map(Number) as [number, number];
  return { periodStart: periodMonthOf(y, 1), periodEnd: `${String(y).padStart(4, '0')}-12-31` };
}

/** The single primitive every grain, and every series function, is built
 *  from: the period of `grain` that contains `accrualDate`. */
export function periodFor(grain: Grain, accrualDate: IsoDate): Period {
  switch (grain) {
    case 'day':
      return { periodStart: accrualDate, periodEnd: accrualDate };
    case 'week':
      return weekPeriod(accrualDate);
    case 'month': {
      const periodStart = toPeriodMonth(accrualDate);
      return { periodStart, periodEnd: lastDayOfPeriodMonth(periodStart) };
    }
    case 'quarter':
      return quarterPeriod(accrualDate);
    case 'year':
      return yearPeriod(accrualDate);
    default: {
      const exhaustive: never = grain;
      throw new Error(`Unknown grain: ${String(exhaustive)}`);
    }
  }
}

/**
 * Every period of `grain` covering `[rangeStart, rangeEnd]`, inclusive, in
 * chronological order, with no gap, no overlap, and **no day outside the
 * requested range**.
 *
 * The first and last buckets are clamped to the range. A caller asking for
 * whole calendar months gets whole months because the range already aligns
 * to them; a caller asking for weeks across a year boundary, or for a range
 * starting mid-month, gets a partial bucket that says so in its own start
 * and end rather than quietly reporting days from the neighbouring year.
 *
 * ISO date strings compare chronologically, so `<` and `>` are the whole
 * comparison — no Date objects, no timezone anywhere in the clamp.
 */
export function periodsCovering(grain: Grain, rangeStart: IsoDate, rangeEnd: IsoDate): Period[] {
  if (rangeEnd < rangeStart) {
    throw new Error(`periodsCovering: rangeEnd ${rangeEnd} is before rangeStart ${rangeStart}`);
  }
  const periods: Period[] = [];
  // The cursor walks WHOLE periods — clamping it would make the next step
  // land mid-period and the walk would never leave the first bucket.
  let cursor = periodFor(grain, rangeStart);
  while (cursor.periodStart <= rangeEnd) {
    periods.push({
      periodStart: cursor.periodStart < rangeStart ? rangeStart : cursor.periodStart,
      periodEnd: cursor.periodEnd > rangeEnd ? rangeEnd : cursor.periodEnd,
    });
    cursor = periodFor(grain, addDaysIso(cursor.periodEnd, 1));
  }
  return periods;
}

export function daysInPeriod(p: Period): number {
  return daysBetweenInclusive(p.periodStart, p.periodEnd);
}

export function isWithinPeriod(accrualDate: IsoDate, p: Period): boolean {
  return accrualDate >= p.periodStart && accrualDate <= p.periodEnd;
}
