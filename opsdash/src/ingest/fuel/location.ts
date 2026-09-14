const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

/**
 * `Location` is a full postal address (`"66377 <street>, Belmont, OH 43718,
 * United States"`, sometimes without the trailing "United States", sometimes
 * with a comma before the zip instead of a space). This is the IFTA
 * purchase-jurisdiction signal SOURCE-DISCOVERY calls "the one genuinely
 * good news" in this sheet — extract the two-letter state, or null if the
 * cell is scheduling noise ("load yoq", "PU: 09/21 08:00", "INACTIVE")
 * rather than an address.
 */
export function extractPurchaseState(raw: string): string | null {
  const matches = raw.matchAll(/,\s*([A-Za-z]{2})\s*,?\s*(\d{5})(?:-\d{4})?\b/g);
  for (const m of matches) {
    const code = m[1]?.toUpperCase();
    if (code && US_STATES.has(code)) return code;
  }
  return null;
}
