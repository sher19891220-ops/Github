/**
 * Experience bands.
 *
 * Insurer guidelines tier drivers by verified experience, and the tiers are
 * mutually exclusive: a driver with 17 months is a one-year driver, not a
 * two-year driver who fell short. That distinction decides which thresholds
 * apply, and getting it wrong produces the specific error this module exists to
 * prevent — comparing a driver against a limit from a band they were never in,
 * or rejecting them for missing a band whose criteria never applied to them.
 */

export const EXPERIENCE_BANDS = ['two_year', 'one_year', 'under_one_year', 'unknown'] as const;

export type ExperienceBand = (typeof EXPERIENCE_BANDS)[number];

export const BAND_LABELS: Record<ExperienceBand, string> = {
  two_year: '2-year driver criteria',
  one_year: '1-year driver criteria',
  under_one_year: 'Under 1 year',
  unknown: 'Not specified',
};

/** Lower bounds, in completed months. */
export const TWO_YEAR_MINIMUM_MONTHS = 24;
export const ONE_YEAR_MINIMUM_MONTHS = 12;

/**
 * The band a driver falls in, from completed months.
 *
 * `null` months means the original CDL issue date could not be verified, which
 * is `unknown` — never `under_one_year`. Treating an unverified date as zero
 * experience would turn missing evidence into a rejection.
 */
export function experienceBand(completedMonths: number | null): ExperienceBand {
  if (completedMonths === null) return 'unknown';
  if (completedMonths >= TWO_YEAR_MINIMUM_MONTHS) return 'two_year';
  if (completedMonths >= ONE_YEAR_MINIMUM_MONTHS) return 'one_year';
  return 'under_one_year';
}

export function bandLabel(band: ExperienceBand): string {
  return BAND_LABELS[band];
}

/**
 * Threshold comparison, inclusive on the maximum.
 *
 * Written out as its own function because "at most three" being read as "fewer
 * than three" is a one-character mistake that silently rejects drivers a
 * guideline accepts, and because the passing case deserves to be as explicit in
 * the code as it is in the explanation.
 */
export function withinThreshold(count: number, maximum: number): boolean {
  return count <= maximum;
}

export function describeThreshold(count: number, maximum: number): string {
  return withinThreshold(count, maximum) ? `${count} ≤ ${maximum}` : `${count} > ${maximum}`;
}
