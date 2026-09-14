import type { IsoDate } from '@/contract/types';

export interface ParsedExpenseDate {
  iso: IsoDate | null;
  raw: string;
  flagged: boolean;
  reason: string | null;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (maxDays[month - 1] as number);
}

function toIso(year: number, month: number, day: number): IsoDate {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The sheet's dates are `MM.DD.YY`, and at least one real row is mistyped
 * with the wrong year embedded in a run of an otherwise-consistent year
 * (`01.06.25` inside a run of `01.06.26`). That specific defect is
 * syntactically indistinguishable from a correct date — there is no signal
 * in the row itself, and CLAUDE.md forbids inferring the year from
 * neighbouring rows. So a strictly well-formed `MM.DD.YY` value is taken
 * literally, exactly as the discovery doc requires, and is NOT flagged: a
 * human reviewing the row in context (sorted by date, next to the document)
 * is the only reliable way to catch it.
 *
 * What this DOES flag, because it is detectable from the string alone:
 * a missing date, a date that doesn't fit the MM.DD.YY shape at all (a
 * four-digit year, a doubled separator), one that fits the shape but names a
 * calendar date that does not exist (`11.31.2023`), or one that has not
 * happened yet.
 *
 * That last one is the same mistyped-year defect, in the one direction where
 * the single value gives it away. The real sheet has a run of eight
 * interior-detailing rows at the same price dated `02.18.25` through
 * `02.18.32` — a drag-fill that incremented the year instead of the day. A
 * wrong year in the past is indistinguishable from a real date and is taken
 * literally; a wrong year in the future is not, because a cost cannot have
 * been incurred after today. Flagging it needs no reference to neighbouring
 * rows, so it does not become the year-inference CLAUDE.md forbids.
 *
 * It is flagged for review, never dropped. A genuinely post-dated document
 * (a scheduled payment, a prepaid renewal) is a real thing; it just is not
 * an accrued cost, and a person decides which it is.
 */
export function parseExpenseDate(raw: string, today: Date = new Date()): ParsedExpenseDate {
  const asOf = today.toISOString().slice(0, 10);
  /** Keeps the flag but preserves whatever reason the shape already earned. */
  const withFutureCheck = (r: ParsedExpenseDate): ParsedExpenseDate =>
    r.iso !== null && r.iso > asOf
      ? { ...r, flagged: true, reason: r.reason === null ? 'future_date' : `${r.reason}+future_date` }
      : r;

  const trimmed = raw.trim();
  if (!trimmed) {
    return { iso: null, raw, flagged: true, reason: 'missing_date' };
  }

  const strict = /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/.exec(trimmed);
  if (strict) {
    const month = Number(strict[1]);
    const day = Number(strict[2]);
    const year = 2000 + Number(strict[3]);
    if (!isValidCalendarDate(year, month, day)) {
      return { iso: null, raw, flagged: true, reason: 'invalid_calendar_date' };
    }
    return withFutureCheck({ iso: toIso(year, month, day), raw, flagged: false, reason: null });
  }

  // Lenient fallback for real-world typos: a doubled separator
  // ("05.23..21") or a four-digit year ("12.29.2025"). We still parse the
  // literal digits rather than guess — but since the shape itself deviates
  // from the sheet's format, we surface it for review rather than treat it
  // as ordinary.
  const lenient = /^(\d{1,2})\.{1,2}(\d{1,2})\.{1,2}(\d{2}|\d{4})$/.exec(trimmed);
  if (lenient) {
    const month = Number(lenient[1]);
    const day = Number(lenient[2]);
    const yearRaw = lenient[3] as string;
    const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
    if (!isValidCalendarDate(year, month, day)) {
      return { iso: null, raw, flagged: true, reason: 'invalid_calendar_date' };
    }
    return withFutureCheck({
      iso: toIso(year, month, day),
      raw,
      flagged: true,
      reason: 'nonstandard_date_format',
    });
  }

  return { iso: null, raw, flagged: true, reason: 'unparseable_date' };
}
