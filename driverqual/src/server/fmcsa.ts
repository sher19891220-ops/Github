/**
 * Parsing helpers for the FMCSA QCMobile API.
 *
 * Kept out of the route module because Next.js permits only its own exports
 * there, and because the shape these depend on is worth pinning by a test.
 */

export interface DocketNumber {
  docketNumber?: number | string | null;
  prefix?: string | null;
}

/**
 * Picks the MC docket from a carrier's docket list.
 *
 * The MC number is not on the carrier record — QCMobile keeps docket numbers on
 * a separate resource. Reading `carrier.mcNumber` returns undefined for every
 * carrier without erroring, so the field simply appears blank and reads as
 * missing FMCSA data rather than a defect.
 */
export function pickMcNumber(dockets: unknown): string | null {
  if (!Array.isArray(dockets)) return null;
  // Carriers can hold FF or MX dockets alongside MC; only MC is wanted here.
  const mc = (dockets as DocketNumber[]).find(
    (d) => (d?.prefix ?? '').toString().toUpperCase() === 'MC',
  );
  if (!mc?.docketNumber) return null;
  return `MC${mc.docketNumber}`;
}
