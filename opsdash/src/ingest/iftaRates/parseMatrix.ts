/**
 * Reads the official IFTA tax-rate matrix.
 *
 * IFTA, Inc. publishes one matrix per quarter at iftach.org. It is the
 * only source for these numbers — nothing in this build can derive them —
 * so this parser exists to get them in accurately and, more importantly,
 * to refuse a plausible-looking wrong reading.
 *
 * **The band check is the point of this module, and it is here because the
 * failure already happened.** The published matrix carries several columns
 * for the same fuel — US dollars per gallon, Canadian dollars per litre,
 * and others. On the first attempt to read Q3 2026, the wrong column came
 * back: Ohio as `0.1737` and Pennsylvania as `0.2738`, against true values
 * of `0.4700` and `0.7410`. Every figure was internally consistent, in the
 * right shape, and low by roughly sixty percent. Entered without a guard,
 * it would have understated every return the engine produced, in a way no
 * downstream check could have caught — the arithmetic would have been
 * perfect.
 *
 * A per-value band alone does NOT catch it, and finding that out is the
 * useful part. The wrong column read 0.09–0.36; real US diesel rates run
 * about 0.19 (Oklahoma) to 0.98 (California). Those overlap across most of
 * their range, so no single-value test can separate a wrong-column figure
 * from a real one — 0.2738 is an implausible Pennsylvania and a perfectly
 * ordinary Oklahoma.
 *
 * What separates them is the **shape of the whole set**. Every real
 * quarterly matrix has several jurisdictions well above $0.50 —
 * California, Pennsylvania, Illinois, Washington, New Jersey — and a
 * per-litre or Canadian-dollar column has none at all. So a matrix that
 * claims to be complete and whose highest rate is under $0.50 is rejected
 * whole, not rate by rate. That is the check that actually fires.
 *
 * The per-value band stays as well, for the wilder cases (a percentage, a
 * cents-not-dollars column, a stray total).
 */

/** US diesel, dollars per gallon. The real spread across jurisdictions is
 *  roughly $0.19 (Oklahoma) to $0.98 (California); this band is wider than
 *  that on both sides so an ordinary quarterly move never trips it, while a
 *  per-litre or Canadian-dollar column — which lands around $0.09–$0.28 —
 *  does. */
const MIN_PLAUSIBLE = 0.15;
const MAX_PLAUSIBLE = 1.5;

/**
 * The set-level check. In every real quarterly matrix the top few
 * jurisdictions sit well above this; in a per-litre or Canadian-dollar
 * column nothing does. Applied only to a matrix large enough to be
 * claiming completeness — a two-line paste legitimately might not include
 * a high-rate state.
 */
const EXPECTED_MAX_AT_LEAST = 0.5;
const COMPLETENESS_THRESHOLD = 20;

export interface ParsedRate {
  jurisdiction: string;
  /** Exact decimal string, five places, as `ifta_rate.rate_per_gallon`. */
  ratePerGallon: string;
  surchargePerGallon: string;
  /** True where the matrix prints no rate at all rather than a zero. */
  noFuelTax: boolean;
}

export interface RateMatrixParse {
  rates: ParsedRate[];
  /** Jurisdictions the parser saw but would not store, and why. Never
   *  silently dropped: a missing jurisdiction becomes a withheld line on
   *  the return, and the operator has to know which and why. */
  rejected: Array<{ jurisdiction: string; raw: string; reason: string }>;
  problems: string[];
}

/**
 * Oregon has no IFTA fuel tax — it is a weight-mile jurisdiction, and
 * carriers pay there through a separate weight-mile tax on a separate
 * return.
 *
 * That makes a zero rate for OR **correct and deliberate**, which is a
 * different thing from a missing rate. The engine withholds a jurisdiction
 * with no rate on file and says the total is incomplete; for Oregon that
 * would be wrong — the tax really is zero, the miles really do belong on
 * the return, and the line should read $0.00 rather than "unknown".
 */
export const NO_FUEL_TAX_JURISDICTIONS = new Set(['OR']);

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

/** Canadian provinces publish in CAD per litre. Recognised so they are
 *  reported as deliberately skipped rather than silently absent — a US
 *  carrier's return does not use them, and converting a currency and a
 *  unit here would be exactly the guessing this build refuses. */
const CA_PROVINCES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);

function toFive(value: string): string {
  const m = /^(\d+)(?:\.(\d{1,5}))?$/.exec(value.trim());
  if (!m) throw new Error(`not a rate: ${value}`);
  return `${m[1]}.${(m[2] ?? '').padEnd(5, '0')}`;
}

/**
 * Parses a pasted matrix.
 *
 * Deliberately tolerant of shape — the operator may paste a markdown
 * table, a CSV, or the rows copied straight off the page — and strict about
 * value. Each line is scanned for a two-letter jurisdiction followed by one
 * or two decimal figures; everything else is ignored as page furniture.
 */
export function parseIftaRateMatrix(text: string): RateMatrixParse {
  const rates: ParsedRate[] = [];
  const rejected: RateMatrixParse['rejected'] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    // `CODE` then the first figure, optionally a second. Separators vary:
    // pipes, commas, tabs, runs of spaces.
    const m = /^[|\s]*([A-Za-z]{2})\s*[|,\t]+\s*([0-9.]+|[-—–]|N\/A)\s*(?:[|,\t]+\s*([0-9.]+|[-—–]|N\/A)\s*)?/i.exec(line);
    if (!m) continue;

    const jurisdiction = m[1]!.toUpperCase();
    const rateRaw = m[2]!.trim();
    const surchargeRaw = (m[3] ?? '').trim();

    if (CA_PROVINCES.has(jurisdiction)) {
      rejected.push({
        jurisdiction,
        raw: rateRaw,
        reason:
          'Canadian province — published in Canadian dollars per litre. Not converted here: a currency and a unit conversion in a rate importer is exactly the kind of silent transformation that produces a confident wrong filing.',
      });
      continue;
    }
    if (!US_STATES.has(jurisdiction)) continue;
    if (seen.has(jurisdiction)) continue;
    seen.add(jurisdiction);

    const blank = /^([-—–]|N\/A)$/i.test(rateRaw);

    if (blank || rateRaw === '') {
      if (NO_FUEL_TAX_JURISDICTIONS.has(jurisdiction)) {
        // A real zero, not a gap. See the note on the constant.
        rates.push({
          jurisdiction,
          ratePerGallon: '0.00000',
          surchargePerGallon: '0.00000',
          noFuelTax: true,
        });
      } else {
        rejected.push({
          jurisdiction,
          raw: rateRaw || '(blank)',
          reason:
            'The matrix prints no rate for this jurisdiction, and it is not one of the weight-mile jurisdictions where zero is correct. Left unstored, so the engine withholds its line rather than taxing it at zero.',
        });
      }
      continue;
    }

    const value = Number(rateRaw);
    if (!Number.isFinite(value)) {
      rejected.push({ jurisdiction, raw: rateRaw, reason: 'Not a number.' });
      continue;
    }
    if (value < MIN_PLAUSIBLE || value > MAX_PLAUSIBLE) {
      rejected.push({
        jurisdiction,
        raw: rateRaw,
        reason:
          `${rateRaw} is outside the plausible band for a US diesel rate ($${MIN_PLAUSIBLE.toFixed(2)}–$${MAX_PLAUSIBLE.toFixed(2)} per gallon). ` +
          'The matrix publishes several columns for the same fuel — US dollars per gallon, Canadian dollars per litre, and others — and a figure this far out is almost always the wrong column rather than a real rate.',
      });
      continue;
    }

    let surcharge = '0.00000';
    if (surchargeRaw !== '' && !/^([-—–]|N\/A)$/i.test(surchargeRaw)) {
      const s = Number(surchargeRaw);
      if (!Number.isFinite(s) || s < 0 || s > MAX_PLAUSIBLE) {
        problems.push(
          `${jurisdiction}: surcharge ${JSON.stringify(surchargeRaw)} is not a usable figure; stored as zero surcharge, which under-reports if this jurisdiction really levies one. Check it.`,
        );
      } else {
        surcharge = toFive(surchargeRaw);
      }
    }

    rates.push({
      jurisdiction,
      ratePerGallon: toFive(rateRaw),
      surchargePerGallon: surcharge,
      noFuelTax: false,
    });
  }

  if (rates.length === 0) {
    problems.push('No usable rates were found in this text.');
  } else if (rates.length < 40) {
    // The matrix covers 48 contiguous states plus DC. Substantially fewer
    // means part of the paste is missing, and every absent jurisdiction is
    // a line the engine will withhold.
    problems.push(
      `Only ${rates.length} US jurisdictions parsed. The full matrix carries around 48 — check the paste is complete, ` +
        'because every jurisdiction missing here becomes a withheld line on the return.',
    );
  }
  if (rejected.some((r) => /plausible band/.test(r.reason))) {
    problems.push(
      'One or more rates were outside the plausible band and were NOT stored. This usually means the wrong column was copied — the matrix prints US$/gallon alongside CAN$/litre.',
    );
  }

  // The set-level check. See the module doc: this is the one that catches a
  // wrong column, because the per-value band cannot.
  //
  // Completeness is judged on how many jurisdictions the matrix MENTIONED
  // (`seen`), not on how many survived the per-value band. Judged on
  // survivors, the two guards cancel: the band strips the lowest rows,
  // that drops the count below the threshold, and the set check then never
  // runs on precisely the input it exists to reject.
  const taxed = rates.filter((r) => !r.noFuelTax);
  if (seen.size >= COMPLETENESS_THRESHOLD && taxed.length > 0) {
    const highest = taxed.reduce(
      (best, r) => (Number(r.ratePerGallon) > Number(best.ratePerGallon) ? r : best),
      taxed[0]!,
    );
    if (Number(highest.ratePerGallon) < EXPECTED_MAX_AT_LEAST) {
      problems.push(
        `Refused: the highest rate in this matrix is ${highest.jurisdiction} at ${highest.ratePerGallon}, ` +
          `and every real quarterly matrix has several jurisdictions above $${EXPECTED_MAX_AT_LEAST.toFixed(2)} per gallon ` +
          '(California, Pennsylvania, Illinois, Washington, New Jersey among them). A whole column this low is ' +
          'the wrong column — US$/gallon is printed alongside CAN$/litre — not a quarter where every state cut its tax.',
      );
      for (const r of taxed) {
        rejected.push({
          jurisdiction: r.jurisdiction,
          raw: r.ratePerGallon,
          reason: 'Part of a matrix rejected whole: its highest rate is too low to be the US dollars-per-gallon column.',
        });
      }
      return { rates: [], rejected, problems };
    }
  }

  return { rates, rejected, problems };
}
