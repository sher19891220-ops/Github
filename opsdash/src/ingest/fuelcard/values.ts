/**
 * Reading the values out of a statement cell, exactly.
 *
 * Every number here becomes a `StagingRow.amount` or `.quantity`, which
 * cross the wire as decimal strings and land in `numeric` columns. Nothing
 * in this file calls `Number()` on a money or gallons value.
 */

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

/** Canadian provinces are IFTA jurisdictions too, and a fleet that runs to
 *  Ontario will see them on a card statement. Recognised so they are not
 *  silently dropped as "not a state". */
const CA_PROVINCES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);

export function isJurisdiction(code: string): boolean {
  const up = code.trim().toUpperCase();
  return US_STATES.has(up) || CA_PROVINCES.has(up);
}

/**
 * A two-letter jurisdiction, or null.
 *
 * Reads a dedicated state column first; falls back to pulling one out of a
 * location string (`"PILOT #123, COLUMBUS OH"`, `"Columbus, OH 43004"`).
 * Never guesses from a city name — two states share plenty of city names,
 * and a wrong jurisdiction moves a credit to the wrong return.
 */
export function parseJurisdiction(stateCell: string, locationCell: string): string | null {
  const direct = stateCell.trim().toUpperCase();
  if (isJurisdiction(direct)) return direct;

  const loc = locationCell.trim();
  if (loc === '') return null;

  // `, OH 43004` / `, OH, 43004` — a state before a ZIP is the strongest signal.
  for (const m of loc.matchAll(/,\s*([A-Za-z]{2})\s*,?\s*(\d{5})(?:-\d{4})?\b/g)) {
    const code = m[1]!.toUpperCase();
    if (isJurisdiction(code)) return code;
  }
  // `COLUMBUS OH` / `COLUMBUS, OH` at the end of the string.
  //
  // The preceding word must contain a letter. Measured against the
  // operator's real fuel sheet, the unguarded version read the cell
  // "80 GA" — eighty *gallons* — as Georgia, on real rows. A wrong
  // jurisdiction moves a tax-paid credit onto the wrong state's return,
  // which is worse than finding no state at all.
  const tail = /(^|[,\s])([A-Za-z]{2})\s*$/.exec(loc);
  if (tail) {
    const code = tail[2]!.toUpperCase();
    const before = loc.slice(0, tail.index).trim();
    if (isJurisdiction(code) && /[A-Za-z]/.test(before)) return code;
  }
  return null;
}

export interface ParsedDate {
  iso: string | null;
  problem: string | null;
}

/**
 * Reads a statement date.
 *
 * US card vendors print `MM/DD/YYYY`. A day-first file would silently
 * misdate every purchase before the 13th of a month and produce an
 * impossible month for the rest — so rather than assume, a month above 12
 * is *reported* instead of being quietly swapped into a day-first reading.
 * Swapping would make the file parse and the dates wrong.
 */
export function parseStatementDate(raw: string): ParsedDate {
  const s = raw.trim();
  if (s === '') return { iso: null, problem: null };

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return validate(Number(iso[1]), Number(iso[2]), Number(iso[3]), s);

  // `\d{4}` MUST precede `\d{2}` in the alternation. Tried the other way
  // round, the regex matches the first two digits of a four-digit year and
  // stops: "03/14/2026" parses as year 20, i.e. 2020. Every date in the
  // file lands six years early, and nothing about the output looks wrong.
  const slash = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})(?!\d)/.exec(s);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let year = Number(slash[3]);
    if (slash[3]!.length === 2) year += year >= 70 ? 1900 : 2000;
    if (month > 12 && day <= 12) {
      return {
        iso: null,
        problem:
          `Date ${JSON.stringify(s)} has a month above 12. This file is probably day-first (DD/MM), ` +
          'not the US MM/DD these are read as. Reading it either way would silently misdate every ' +
          'purchase before the 13th, so it is reported instead.',
      };
    }
    return validate(year, month, day, s);
  }

  return { iso: null, problem: `Unreadable date ${JSON.stringify(s)}.` };
}

function validate(year: number, month: number, day: number, raw: string): ParsedDate {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { iso: null, problem: `Impossible date ${JSON.stringify(raw)}.` };
  }
  const p = (n: number) => String(n).padStart(2, '0');
  const candidate = `${year}-${p(month)}-${p(day)}`;
  // Rejects 31 February and friends: Date normalises them, so a round-trip
  // that changes the string means the date did not exist.
  const d = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== candidate) {
    return { iso: null, problem: `Impossible date ${JSON.stringify(raw)}.` };
  }
  return { iso: candidate, problem: null };
}

/**
 * Money, to the cent, as an exact decimal string.
 *
 * Handles `$1,234.56`, `1234.56`, a leading or trailing minus, and
 * accounting parentheses `(1,234.56)` — which vendors use for credits and
 * reversals, and which a naive parser reads as a positive number. A
 * reversal read as a charge doubles the error: the refund is added instead
 * of subtracted.
 */
export function parseMoney(raw: string): string | null {
  let s = raw.trim();
  if (s === '') return null;

  // Currency symbol first: vendors write both "$(1,234.56)" and
  // "(  $1,234.56 )", so a parenthesis check that runs before the symbol
  // is stripped misses the negative and reads a credit as a charge.
  s = s.replace(/[$\s]/g, '');

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/,/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.startsWith('+')) s = s.slice(1);

  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  const value = `${m[1]}.${frac}`;
  return negative && value !== '0.00' ? `-${value}` : value;
}

/**
 * Gallons, as an exact decimal string, or null.
 *
 * **Never 0 for an unreadable cell.** Zero gallons is a claim that no fuel
 * was bought; an unreadable cell means nobody knows. The fuel *sheet* path
 * already taught this lesson — 97.5% of its rows say "full tank" — and the
 * same rule holds here for a blank or a dash.
 */
export function parseQuantity(raw: string): string | null {
  let s = raw.trim();
  if (s === '' || s === '-' || s === '—') return null;

  s = s.replace(/\s/g, '');

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/,/g, '').replace(/(gal|gals|gallons|g)$/i, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }

  const m = /^(\d{1,10})(?:\.(\d{1,4}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  const value = `${m[1]}.${frac}`;
  return negative && !/^0\.0+$/.test(value) ? `-${value}` : value;
}

/**
 * A unit price, which is not money to two places.
 *
 * Fuel is priced in tenths of a cent: measured across the operator's real
 * fuel sheet, 319 of 399 price cells carry **three** decimals (`3.799$`)
 * and only 79 carry two. `parseMoney` caps at two because that is what
 * `numeric(14,2)` holds and what a ledger amount is; a unit price is
 * reference data on the row, so it keeps every digit the statement
 * printed rather than being quietly truncated.
 *
 * The dollar sign may lead or trail — the operator's own sheets write
 * `3.56$`, card statements write `$3.56`, and both appear.
 */
export function parseUnitPrice(raw: string): string | null {
  const s = raw.trim().replace(/[$\s]/g, '').replace(/,/g, '');
  if (s === '') return null;
  const m = /^(-?)(\d{1,8})(?:\.(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(2, '0');
  return `${m[1]}${m[2]}.${frac}`;
}

/** Exact cents from a money decimal string, for checksums. */
export function centsOf(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`Not a money value: ${JSON.stringify(value)}`);
  const frac = (m[3] ?? '').padEnd(2, '0');
  const abs = BigInt(m[2]!) * 100n + BigInt(frac);
  return m[1] === '-' ? -abs : abs;
}

export function moneyOf(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg && abs !== 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
