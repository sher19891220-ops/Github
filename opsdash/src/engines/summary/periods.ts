/**
 * Period-boundary math for the five grains the P&L screen needs
 * (day/week/month/quarter/year), all built from one primitive
 * (`periodFor`) so a "twelve months sum to the year" property holds by
 * construction: every grain partitions the same calendar days, nothing
 * more.
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

/** Every period of `grain` covering `[rangeStart, rangeEnd]`, inclusive,
 *  in chronological order, with no gap and no overlap — the property that
 *  makes "the parts sum to the whole" hold for a period series. */
export function periodsCovering(grain: Grain, rangeStart: IsoDate, rangeEnd: IsoDate): Period[] {
  if (rangeEnd < rangeStart) {
    throw new Error(`periodsCovering: rangeEnd ${rangeEnd} is before rangeStart ${rangeStart}`);
  }
  const periods: Period[] = [];
  let cursor = periodFor(grain, rangeStart);
  while (cursor.periodStart <= rangeEnd) {
    periods.push(cursor);
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
