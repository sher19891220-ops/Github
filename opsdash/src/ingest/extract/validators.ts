/**
 * Generic structural validators shared across document families:
 *  - a total that does not sum (see also money.ts's `checkTotalsSum`, which
 *    this module re-exports for convenience)
 *  - a date outside the document's own stated period
 *
 * "A field that failed a structural check must be flagged, not dropped and
 * not silently accepted" — these return `ExtractedField`s, same as every
 * other extractor in this directory, so a caller never has to special-case
 * how a validator's opinion is represented.
 */
import { isIsoDate, type Decimal, type IsoDate } from '@/contract/types';
import { cleanField, flaggedField, type ExtractedField } from './types';
import { checkTotalsSum } from './money';

export { checkTotalsSum, sumDecimals, type SumCheckResult } from './money';

/**
 * "If a document states a total and the lines don't add to it, flag every
 * line — do not silently trust either" (CLAUDE.md §2). This is the
 * operational form of that rule: given the line-item fields as already
 * extracted (each with its own confidence) and the document's stated total,
 * every line comes back `needsReview: true` when the sum is off — never just
 * the total, never just one arbitrarily-chosen line, and never silently
 * accepted because each individual line "looked" fine on its own.
 */
export function flagLinesIfTotalMismatch<Line extends ExtractedField<Decimal>>(
  lines: readonly Line[],
  statedTotal: Decimal,
): Line[] {
  const values = lines.map((l) => l.value).filter((v): v is Decimal => v !== null);
  if (values.length !== lines.length) {
    // A line that failed to parse as an amount already needsReview on its
    // own; the sum check can't run meaningfully with a hole in it, so every
    // line is flagged for the same reason: the total can't be trusted either.
    return lines.map((l) => ({
      ...l,
      needsReview: true,
      reason: l.reason ?? 'total cannot be verified: at least one line amount failed to parse.',
    }));
  }

  const check = checkTotalsSum(values, statedTotal);
  if (check.ok) return lines.map((l) => ({ ...l }));

  const reason =
    `stated total ${statedTotal} does not match the sum of its lines ` +
    `(computed ${check.computedSum}, difference ${check.difference}); every line is flagged, not just one.`;
  return lines.map((l) => ({ ...l, needsReview: true, reason }));
}

/** Lexicographic comparison is exact for `YYYY-MM-DD` strings — no `Date`
 *  object, no timezone boundary. */
export function isDateWithinPeriod(dateIso: string, periodStartIso: string, periodEndIso: string): boolean {
  return dateIso >= periodStartIso && dateIso <= periodEndIso;
}

/**
 * Flags a date that falls outside the document's own declared period (e.g.
 * an invoice line dated outside its billing period, or a fuel purchase
 * dated outside the statement's date range). Also flags anything that isn't
 * a well-formed ISO date in the first place, rather than silently passing
 * a garbage string through.
 */
export function checkDateInPeriod(
  dateIso: string | null,
  periodStartIso: IsoDate,
  periodEndIso: IsoDate,
): ExtractedField<IsoDate> {
  if (dateIso === null || dateIso.trim() === '') {
    return flaggedField<IsoDate>(null, 0, 'no date extracted.');
  }
  if (!isIsoDate(dateIso)) {
    return flaggedField<IsoDate>(dateIso, 0.1, `"${dateIso}" is not a well-formed ISO date.`);
  }
  if (!isDateWithinPeriod(dateIso, periodStartIso, periodEndIso)) {
    return flaggedField(
      dateIso,
      0.3,
      `${dateIso} falls outside the document's own period (${periodStartIso}..${periodEndIso}).`,
    );
  }
  return cleanField(dateIso, 0.9);
}
