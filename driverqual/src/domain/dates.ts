/**
 * Calendar-date arithmetic for the qualification engine.
 *
 * Every date in this system is a *calendar date* (`YYYY-MM-DD`) with no time and
 * no timezone. Driver documents record calendar dates; converting them to
 * instants introduces off-by-one-day errors that silently shift lookback
 * windows and experience months across a boundary. All maths here is done on
 * (year, month, day) integer triples.
 */

export type IsoDate = string; // 'YYYY-MM-DD'

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

export function parseIsoDate(value: string): CalendarDate {
  if (!isValidIsoDate(value)) {
    throw new RangeError(`Not a valid ISO calendar date: ${JSON.stringify(value)}`);
  }
  const m = ISO_DATE_RE.exec(value)!;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function formatIsoDate(d: CalendarDate): IsoDate {
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${d.year}-${mm}-${dd}`;
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareIsoDates(a: IsoDate, b: IsoDate): number {
  const x = parseIsoDate(a);
  const y = parseIsoDate(b);
  if (x.year !== y.year) return x.year - y.year;
  if (x.month !== y.month) return x.month - y.month;
  return x.day - y.day;
}

/**
 * Shift a calendar date by a whole number of months, clamping the day to the
 * last day of the target month. `2026-03-31` minus one month is `2026-02-28`
 * (or `-29` in a leap year), never `2026-03-02`.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const d = parseIsoDate(date);
  const zeroBased = d.year * 12 + (d.month - 1) + months;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  const day = Math.min(d.day, daysInMonth(year, month));
  return formatIsoDate({ year, month, day });
}

/**
 * Whole calendar months elapsed between two dates, never rounded up.
 *
 * A month is "completed" on its monthly anniversary. When the anniversary day
 * does not exist in the target month (issued the 31st, measured in February)
 * the last day of that month completes it — the same clamping rule courts and
 * insurers use for anniversary dates.
 *
 * Returns 0 when `to` is earlier than `from`; callers that care about a
 * reversed range must check the ordering themselves.
 */
export function completedMonths(from: IsoDate, to: IsoDate): number {
  if (compareIsoDates(to, from) <= 0) return 0;
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);

  let months = (b.year - a.year) * 12 + (b.month - a.month);
  const anniversaryDay = Math.min(a.day, daysInMonth(b.year, b.month));
  if (b.day < anniversaryDay) months -= 1;

  return Math.max(0, months);
}

/** Whole completed years, derived from completed months so the two can never disagree. */
export function completedYears(from: IsoDate, to: IsoDate): number {
  return Math.floor(completedMonths(from, to) / 12);
}

export interface LookbackWindow {
  start: IsoDate;
  end: IsoDate;
  months: number;
}

/**
 * The window a lookback rule covers, anchored on `anchor` and reaching back
 * `months` calendar months. Both endpoints are inclusive.
 */
export function lookbackWindow(anchor: IsoDate, months: number): LookbackWindow {
  if (!Number.isInteger(months) || months <= 0) {
    throw new RangeError(`Lookback months must be a positive integer, got ${months}`);
  }
  return { start: addMonths(anchor, -months), end: anchor, months };
}

export function isWithinWindow(date: IsoDate, window: LookbackWindow): boolean {
  return compareIsoDates(date, window.start) >= 0 && compareIsoDates(date, window.end) <= 0;
}

/** True when `date` is later than the window's anchor — evidence from the future. */
export function isAfterWindow(date: IsoDate, window: LookbackWindow): boolean {
  return compareIsoDates(date, window.end) > 0;
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  const ms =
    Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}
