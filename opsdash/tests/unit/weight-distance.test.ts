/**
 * The weight-distance tax engine — the tax IFTA does not cover.
 *
 * New York, Kentucky, New Mexico and Oregon each levy a distance tax on
 * top of IFTA, filed separately. A carrier filing only IFTA is short by
 * the whole amount, quarter after quarter, and nothing about the IFTA
 * return looks wrong — it is complete and correct on its own terms.
 *
 * Oregon is the sharpest case and the first test below: it charges no
 * IFTA fuel tax at all, so a carrier reading only the IFTA return sees
 * Oregon costing nothing while the weight-mile tax accrues.
 */
import { describe, expect, it } from 'vitest';
import { calculateWeightDistance, WeightDistanceInputError } from '@/engines/weightDistance';
import type { WeightDistanceRate } from '@/engines/weightDistance';

const NY: WeightDistanceRate = {
  jurisdiction: 'NY',
  ratePerMile: '0.05850',
  weightThresholdLb: 80001,
  upperBoundReason:
    'New York exempts Thruway miles and charges unladen miles less. The mileage report gives one total per state, so this is the most it can be.',
  sourceNote: 'NY HUT schedule',
};
const OR_RATE: WeightDistanceRate = {
  jurisdiction: 'OR',
  ratePerMile: '0.25600',
  weightThresholdLb: 26001,
  sourceNote: 'ODOT weight-mile table',
};

const PERIOD = { periodStart: '2026-07-01', periodEnd: '2026-09-30' };

describe('calculateWeightDistance', () => {
  it('charges Oregon miles that IFTA charges nothing for', () => {
    // Oregon's IFTA fuel rate is a real zero — it is a weight-mile state.
    // Read only through IFTA, these 10,000 miles cost nothing. They do
    // not: 10,000 x $0.256 = $2,560.
    const r = calculateWeightDistance({
      ...PERIOD,
      milesByJurisdiction: [{ jurisdiction: 'OR', miles: '10000.00' }],
      rates: [OR_RATE],
      grossWeightLb: 80000,
    });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ jurisdiction: 'OR', taxDue: '2560.00', isUpperBound: false });
    expect(r.totalDue).toBe('2560.00');
  });

  it('labels a figure the mileage source cannot compute exactly as an upper bound', () => {
    // New York's real rate depends on Thruway vs non-Thruway and laden vs
    // unladen. The report carries one total per state, so the honest
    // output is "at most this", not a precise-looking number.
    const r = calculateWeightDistance({
      ...PERIOD,
      milesByJurisdiction: [{ jurisdiction: 'NY', miles: '4000.00' }],
      rates: [NY],
      grossWeightLb: 80001,
    });
    expect(r.lines[0]!.taxDue).toBe('234.00');
    expect(r.lines[0]!.isUpperBound).toBe(true);
    expect(r.anyUpperBound).toBe(true);
    expect(r.problems.some((p) => /Thruway/.test(p))).toBe(true);
  });

  it('puts a fleet one pound below a band into the band below it', () => {
    // Not a contrived edge. This operator's units are all IRP weight
    // group 80 — exactly 80,000 lb — and New York's top HUT band starts
    // at 80,001. Applying the 80,001+ rate to an 80,000 lb fleet
    // overstates the tax on every New York mile, and the difference is
    // invisible in the output because the arithmetic is fine either way.
    const atEightyThousand = calculateWeightDistance({
      ...PERIOD,
      milesByJurisdiction: [{ jurisdiction: 'NY', miles: '4000.00' }],
      rates: [NY],
      grossWeightLb: 80000,
    });
    expect(atEightyThousand.lines[0]!.taxDue).toBe('0.00');
    expect(atEightyThousand.lines[0]!.note).toMatch(/80,000 lb and NY taxes from 80,001 lb/);

    // One pound more and the band applies.
    const atEightyThousandAndOne = calculateWeightDistance({
      ...PERIOD,
      milesByJurisdiction: [{ jurisdiction: 'NY', miles: '4000.00' }],
      rates: [NY],
      grossWeightLb: 80001,
    });
    expect(atEightyThousandAndOne.lines[0]!.taxDue).toBe('234.00');
  });

  it('reports a below-threshold jurisdiction as a real zero, with its miles', () => {
    // "We do not owe this" and "we did not go there" are different facts,
    // and dropping the line collapses them.
    const r = calculateWeightDistance({
      ...PERIOD,
      milesByJurisdiction: [{ jurisdiction: 'NY', miles: '4000.00' }],
      rates: [NY],
      grossWeightLb: 26000,
    });
    expect(r.lines[0]).toMatchObject({ jurisdiction: 'NY', miles: '4000.00', taxDue: '0.00' });
    expect(r.lines[0]!.note).toMatch(/Not owed/);
    expect(r.totalDue).toBe('0.00');
  });

  it('never taxes a jurisdiction with no rate at zero', () => {
    // Zero claims nothing is owed. No rate means nobody has said what is.
    const r = calculateWeightDistance({
      ...PERIOD,
      milesByJurisdiction: [
        { jurisdiction: 'OR', miles: '10000.00' },
        { jurisdiction: 'KY', miles: '8000.00' },
      ],
      rates: [OR_RATE],
      grossWeightLb: 80000,
    });
    expect(r.lines.map((l) => l.jurisdiction)).toEqual(['OR']);
    expect(r.totalDue).toBe('2560.00');
    expect(r.problems.some((p) => /No weight-distance rate is on file for KY/.test(p))).toBe(true);
    expect(r.problems.some((p) => /New York, Kentucky, New Mexico and Oregon/.test(p))).toBe(true);
  });

  it('does not emit a line for a rated jurisdiction with no miles', () => {
    // A $0.00 line for every weight-distance state would bury the ones
    // that matter.
    const r = calculateWeightDistance({
      ...PERIOD,
      milesByJurisdiction: [{ jurisdiction: 'OR', miles: '10000.00' }],
      rates: [OR_RATE, NY],
      grossWeightLb: 80000,
    });
    expect(r.lines.map((l) => l.jurisdiction)).toEqual(['OR']);
  });

  it('refuses to produce a figure with no mileage at all', () => {
    expect(() =>
      calculateWeightDistance({
        ...PERIOD,
        milesByJurisdiction: [],
        rates: [OR_RATE],
        grossWeightLb: 80000,
      }),
    ).toThrow(WeightDistanceInputError);
  });

  it('says so when nothing could be priced', () => {
    const r = calculateWeightDistance({
      ...PERIOD,
      milesByJurisdiction: [{ jurisdiction: 'OH', miles: '9000.00' }],
      rates: [],
      grossWeightLb: 80000,
    });
    expect(r.lines).toHaveLength(0);
    expect(r.totalDue).toBe('0.00');
    expect(r.problems.some((p) => /No weight-distance rates are on file/.test(p))).toBe(true);
  });

  it('sums several jurisdictions exactly, in cents', () => {
    const r = calculateWeightDistance({
      ...PERIOD,
      milesByJurisdiction: [
        { jurisdiction: 'OR', miles: '10000.00' },
        { jurisdiction: 'NY', miles: '4000.00' },
      ],
      rates: [OR_RATE, NY],
      grossWeightLb: 80001,
    });
    // 2560.00 + 234.00, and the total is an upper bound because one line is.
    expect(r.totalDue).toBe('2794.00');
    expect(r.anyUpperBound).toBe(true);
  });

  it('keeps a rate quoted in mills exactly', () => {
    // New Mexico publishes in mills per mile; a rate carried to five
    // places must not be rounded to four on the way through.
    const r = calculateWeightDistance({
      ...PERIOD,
      milesByJurisdiction: [{ jurisdiction: 'NM', miles: '1000.00' }],
      rates: [
        { jurisdiction: 'NM', ratePerMile: '0.04378', weightThresholdLb: 26001, sourceNote: 'NM WDT schedule' },
      ],
      grossWeightLb: 80000,
    });
    expect(r.lines[0]!.ratePerMile).toBe('0.04378');
    expect(r.lines[0]!.taxDue).toBe('43.78');
  });

  it('refuses a mileage figure carrying more precision than it can hold', () => {
    expect(() =>
      calculateWeightDistance({
        ...PERIOD,
        milesByJurisdiction: [{ jurisdiction: 'OR', miles: '1000.123' }],
        rates: [OR_RATE],
        grossWeightLb: 80000,
      }),
    ).toThrow(/more than 2 decimal places/);
  });
});
