/**
 * Reading the official IFTA rate matrix.
 *
 * The wrong-column check is the reason this module exists, and it is not
 * hypothetical. Reading the real Q3 2026 matrix off iftach.org, the first
 * attempt came back with Ohio at 0.1737 and Pennsylvania at 0.2738 — the
 * wrong column. The true values are 0.4700 and 0.7410. Every figure was
 * the right shape, internally consistent, and low by about sixty percent;
 * the engine's arithmetic would have been perfect and every return
 * understated. Nothing downstream could have caught it.
 *
 * The first guard written here — a plausible band per rate — did NOT catch
 * it, and the test below is what proved that: the wrong column read
 * 0.09–0.36 and real rates run 0.19–0.98, so the two overlap and no
 * single-value test can separate them. What catches it is the shape of the
 * whole set, and that is what these tests now pin.
 *
 * The fixtures below are the real published Q3 2026 values (public data)
 * and the real wrong-column reading that nearly got entered.
 */
import { describe, expect, it } from 'vitest';
import { parseIftaRateMatrix } from '@/ingest/iftaRates/parseMatrix';

/** As published by IFTA, Inc. for 3Q 2026 — a representative slice. */
const CORRECT = `
| AL | 0.3100 | — |
| CA | 0.9790 | — |
| IL | 0.7380 | — |
| IN | 0.6300 | 0.6300 |
| KY | 0.2200 | 0.1050 |
| OH | 0.4700 | — |
| OK | 0.1900 | — |
| OR | — | — |
| PA | 0.7410 | — |
| VA | 0.3360 | 0.1430 |
`;

/** The wrong column, as it actually came back on the first read — enough
 *  jurisdictions for the matrix to be claiming completeness. */
const WRONG_COLUMN = [
  ['AL', '0.1145'], ['AZ', '0.0961'], ['AR', '0.1053'], ['CA', '0.3618'], ['CO', '0.1238'],
  ['CT', '0.1843'], ['DE', '0.0812'], ['FL', '0.1513'], ['GA', '0.1377'], ['ID', '0.1182'],
  ['IL', '0.2727'], ['IN', '0.2327'], ['IA', '0.1201'], ['KS', '0.0961'], ['KY', '0.0812'],
  ['LA', '0.0738'], ['ME', '0.1152'], ['MD', '0.1754'], ['MA', '0.0887'], ['MI', '0.1935'],
  ['MN', '0.1204'], ['MS', '0.0887'], ['OH', '0.1737'], ['PA', '0.2738'],
]
  .map(([j, r]) => `${j}|${r}|0`)
  .join('\n');

describe('parseIftaRateMatrix', () => {
  const r = parseIftaRateMatrix(CORRECT);

  it('reads the published rates to five places', () => {
    const byJ = new Map(r.rates.map((x) => [x.jurisdiction, x]));
    expect(byJ.get('OH')?.ratePerGallon).toBe('0.47000');
    expect(byJ.get('PA')?.ratePerGallon).toBe('0.74100');
    expect(byJ.get('CA')?.ratePerGallon).toBe('0.97900');
  });

  it('keeps the surcharge apart from the base rate', () => {
    const byJ = new Map(r.rates.map((x) => [x.jurisdiction, x]));
    expect(byJ.get('IN')).toMatchObject({ ratePerGallon: '0.63000', surchargePerGallon: '0.63000' });
    expect(byJ.get('KY')).toMatchObject({ ratePerGallon: '0.22000', surchargePerGallon: '0.10500' });
    expect(byJ.get('VA')).toMatchObject({ ratePerGallon: '0.33600', surchargePerGallon: '0.14300' });
    // And a jurisdiction without one gets zero, not the base rate.
    expect(byJ.get('OH')?.surchargePerGallon).toBe('0.00000');
  });

  it('stores Oregon as a real zero, not as a missing rate', () => {
    // Oregon is weight-mile: there genuinely is no IFTA fuel tax, so its
    // line belongs on the return reading $0.00. A missing rate would make
    // the engine withhold it and call the total incomplete, which is a
    // different and wrong claim.
    const or = r.rates.find((x) => x.jurisdiction === 'OR');
    expect(or).toMatchObject({ ratePerGallon: '0.00000', noFuelTax: true });
  });
});

describe('the wrong column', () => {
  const r = parseIftaRateMatrix(WRONG_COLUMN);

  it('stores nothing at all from it', () => {
    // This is the real reading that nearly got entered.
    expect(r.rates).toHaveLength(0);
  });

  it('is caught by the shape of the set, not by any single rate', () => {
    // The load-bearing point: several of these values are perfectly
    // ordinary rates for SOME state. 0.2738 is an implausible
    // Pennsylvania and a completely normal Oklahoma. Only the fact that
    // NOTHING in the matrix clears $0.50 gives it away.
    expect(r.problems.some((p) => /the highest rate in this matrix is CA at 0\.36180/.test(p))).toBe(true);
    expect(r.problems.some((p) => /the wrong column/.test(p))).toBe(true);
  });

  it('rejects each jurisdiction with a reason, so the error is diagnosable', () => {
    const ohio = r.rejected.find((x) => x.jurisdiction === 'OH')!;
    expect(ohio.raw).toBe('0.17370');
    expect(ohio.reason).toMatch(/rejected whole/);
  });

  it('would not have been caught by the per-rate band alone', () => {
    // Documents why the set-level check had to exist. Fed only the few
    // rates that sit inside the band, and too few to claim completeness,
    // the parser accepts them — exactly the hole the first guard left.
    const few = parseIftaRateMatrix('OH|0.1737|0\nPA|0.2738|0\n');
    expect(few.rates).toHaveLength(2);
  });
});

describe('what else it refuses', () => {
  it('skips Canadian provinces rather than converting them', () => {
    // Converting a currency AND a unit inside a rate importer is exactly
    // the silent transformation that produces a confident wrong filing.
    const r = parseIftaRateMatrix('| ON | 0.0900 | — |\n| OH | 0.4700 | — |\n');
    expect(r.rates.map((x) => x.jurisdiction)).toEqual(['OH']);
    const on = r.rejected.find((x) => x.jurisdiction === 'ON')!;
    expect(on.reason).toMatch(/Canadian dollars per litre/);
  });

  it('does not store a blank rate for a jurisdiction that should have one', () => {
    const r = parseIftaRateMatrix('| OH | — | — |\n| PA | 0.7410 | — |\n');
    expect(r.rates.map((x) => x.jurisdiction)).toEqual(['PA']);
    expect(r.rejected.find((x) => x.jurisdiction === 'OH')?.reason).toMatch(/withholds its line/);
  });

  it('warns when the paste is obviously partial', () => {
    // Every jurisdiction missing here is a line the engine withholds.
    const r = parseIftaRateMatrix('| OH | 0.4700 | — |\n| PA | 0.7410 | — |\n');
    expect(r.problems.some((p) => /Only 2 US jurisdictions parsed/.test(p))).toBe(true);
  });

  it('reads the shapes a matrix copies out as', () => {
    for (const text of ['OH,0.4700,0', 'OH\t0.4700\t0', '| OH | 0.4700 | 0 |']) {
      const r = parseIftaRateMatrix(text);
      expect(r.rates[0], text).toMatchObject({ jurisdiction: 'OH', ratePerGallon: '0.47000' });
    }
  });

  it('ignores page furniture rather than choking on it', () => {
    const r = parseIftaRateMatrix(
      'IFTA, Inc. 3rd Quarter 2026\nJurisdiction | Rate | Surcharge\n| OH | 0.4700 | — |\nUpdated 9/11/26\n',
    );
    expect(r.rates.map((x) => x.jurisdiction)).toEqual(['OH']);
  });
});
