/**
 * The IFTA engine.
 *
 * These are worked arithmetic examples with hand-checked figures, plus the
 * four refusals that matter more than the arithmetic. IFTA is filed with a
 * state; a return that is confidently wrong costs money and credibility,
 * and every one of the mistakes below is one a hand-built spreadsheet
 * makes routinely.
 */
import { describe, expect, it } from 'vitest';
import { IftaInputError, calculateIfta, classifyPeriod } from '@/engines/ifta';
import type { IftaInput } from '@/engines/ifta';

/**
 * A deliberately simple worked example, checkable by hand:
 *   10,000 miles total, 2,000 gallons bought  ->  fleet MPG 5.00
 *   OH: 6,000 mi -> 1,200 gal taxable, 1,500 bought  -> net -300 gal
 *   PA: 4,000 mi ->   800 gal taxable,   500 bought  -> net +300 gal
 */
function base(over: Partial<IftaInput> = {}): IftaInput {
  return {
    periodStart: '2026-04-01',
    periodEnd: '2026-06-30',
    milesByJurisdiction: [
      { jurisdiction: 'OH', miles: '6000.00' },
      { jurisdiction: 'PA', miles: '4000.00' },
    ],
    fuelByJurisdiction: [
      { jurisdiction: 'OH', gallons: '1500.0000' },
      { jurisdiction: 'PA', gallons: '500.0000' },
    ],
    rates: [
      { jurisdiction: 'OH', ratePerGallon: '0.47000' },
      { jurisdiction: 'PA', ratePerGallon: '0.74100' },
    ],
    ...over,
  };
}

describe('fleet MPG', () => {
  it('is fleet-wide, not per jurisdiction', () => {
    const r = calculateIfta(base());
    // 10,000 miles / 2,000 gallons = 5.00, everywhere.
    expect(r.fleetMpg).toBe('5.00');

    // Per-jurisdiction MPG would be OH 6000/1500 = 4.00 and PA 4000/500 =
    // 8.00, giving 1,500 and 500 taxable gallons — a different return in
    // every line, and the wrong one. Both lines use 5.00.
    expect(r.lines.find((l) => l.jurisdiction === 'OH')!.taxableGallons).toBe('1200.0000');
    expect(r.lines.find((l) => l.jurisdiction === 'PA')!.taxableGallons).toBe('800.0000');
  });

  it('carries the stated number of decimal places, and says which', () => {
    const odd = base({
      milesByJurisdiction: [{ jurisdiction: 'OH', miles: '10000.00' }],
      fuelByJurisdiction: [{ jurisdiction: 'OH', gallons: '1533.0000' }],
    });
    expect(calculateIfta(odd).fleetMpg).toBe('6.52');
    expect(calculateIfta({ ...odd, mpgDecimalPlaces: 4 }).fleetMpg).toBe('6.5232');
  });
});

describe('the return', () => {
  it('nets tax-paid gallons against taxable gallons, per jurisdiction', () => {
    const r = calculateIfta(base());

    const oh = r.lines.find((l) => l.jurisdiction === 'OH')!;
    expect(oh.netTaxableGallons).toBe('-300.0000');
    // A credit: 300 gallons over-bought × $0.47 = -$141.00
    expect(oh.taxDue).toBe('-141.00');

    const pa = r.lines.find((l) => l.jurisdiction === 'PA')!;
    expect(pa.netTaxableGallons).toBe('300.0000');
    // Owed: 300 × $0.741 = $222.30
    expect(pa.taxDue).toBe('222.30');

    // Net: -141.00 + 222.30
    expect(r.netDue).toBe('81.30');
    expect(r.problems).toEqual([]);
  });

  it('subtracts exempt miles before computing gallons', () => {
    const r = calculateIfta(
      base({
        milesByJurisdiction: [
          { jurisdiction: 'OH', miles: '6000.00', exemptMiles: '1000.00' },
          { jurisdiction: 'PA', miles: '4000.00' },
        ],
      }),
    );
    const oh = r.lines.find((l) => l.jurisdiction === 'OH')!;
    expect(oh.totalMiles).toBe('6000.00');
    expect(oh.taxableMiles).toBe('5000.00');
    // 5,000 / 5.00 MPG = 1,000 taxable gallons, not 1,200.
    expect(oh.taxableGallons).toBe('1000.0000');
    // But MPG itself still uses TOTAL miles — exempt miles burned fuel.
    expect(r.fleetMpg).toBe('5.00');
  });

  it('flags an exemption larger than the miles driven', () => {
    const r = calculateIfta(
      base({
        milesByJurisdiction: [
          { jurisdiction: 'OH', miles: '6000.00', exemptMiles: '7000.00' },
          { jurisdiction: 'PA', miles: '4000.00' },
        ],
      }),
    );
    expect(r.problems.some((p) => /more miles are claimed exempt/i.test(p))).toBe(true);
  });

  it('gives a jurisdiction where fuel was bought but no miles run its credit', () => {
    const r = calculateIfta(
      base({
        fuelByJurisdiction: [
          { jurisdiction: 'OH', gallons: '1500.0000' },
          { jurisdiction: 'PA', gallons: '400.0000' },
          { jurisdiction: 'IN', gallons: '100.0000' },
        ],
        rates: [
          { jurisdiction: 'OH', ratePerGallon: '0.47000' },
          { jurisdiction: 'PA', ratePerGallon: '0.74100' },
          { jurisdiction: 'IN', ratePerGallon: '0.34000' },
        ],
      }),
    );
    const inLine = r.lines.find((l) => l.jurisdiction === 'IN')!;
    // Bought there, never drove there: a pure credit that must not be dropped.
    expect(inLine.taxableMiles).toBe('0.00');
    expect(inLine.taxPaidGallons).toBe('100.0000');
    expect(inLine.taxDue).toBe('-34.00');
  });
});

describe('the surcharge', () => {
  it('is charged on taxable gallons and is never netted or credited', () => {
    // Indiana: base rate plus a surcharge you cannot pre-pay at the pump.
    const r = calculateIfta(
      base({
        milesByJurisdiction: [
          { jurisdiction: 'IN', miles: '5000.00' },
          { jurisdiction: 'PA', miles: '5000.00' },
        ],
        fuelByJurisdiction: [
          { jurisdiction: 'IN', gallons: '1500.0000' },
          { jurisdiction: 'PA', gallons: '500.0000' },
        ],
        rates: [
          { jurisdiction: 'IN', ratePerGallon: '0.34000', surchargePerGallon: '0.55000' },
          { jurisdiction: 'PA', ratePerGallon: '0.74100' },
        ],
      }),
    );

    const inLine = r.lines.find((l) => l.jurisdiction === 'IN')!;
    // 5,000 mi / 5.00 MPG = 1,000 taxable gallons; 1,500 bought.
    expect(inLine.taxableGallons).toBe('1000.0000');
    expect(inLine.netTaxableGallons).toBe('-500.0000');
    // Base tax is a credit: -500 × 0.34
    expect(inLine.taxDue).toBe('-170.00');
    // The surcharge is on the 1,000 TAXABLE gallons — not the -500 net.
    // Netting it would give -275.00 and under-report by $825.
    expect(inLine.surchargeDue).toBe('550.00');
    expect(inLine.totalDue).toBe('380.00');
  });

  it('is never a credit, even when the base tax is', () => {
    // Two jurisdictions on purpose. In a single-jurisdiction period where
    // all the fuel is bought in that same jurisdiction, fleet MPG is
    // miles/gallons by construction and the net is always exactly zero —
    // so a one-state fixture cannot express "the base tax is a credit".
    const r = calculateIfta(
      base({
        milesByJurisdiction: [
          { jurisdiction: 'KY', miles: '1000.00' },
          { jurisdiction: 'PA', miles: '1000.00' },
        ],
        fuelByJurisdiction: [
          { jurisdiction: 'KY', gallons: '1500.0000' },
          { jurisdiction: 'PA', gallons: '500.0000' },
        ],
        rates: [
          { jurisdiction: 'KY', ratePerGallon: '0.28000', surchargePerGallon: '0.04400' },
          { jurisdiction: 'PA', ratePerGallon: '0.74100' },
        ],
      }),
    );
    const ky = r.lines.find((l) => l.jurisdiction === 'KY')!;
    // 2,000 mi / 2,000 gal = 1.00 MPG; KY burns 1,000 and bought 1,500.
    expect(ky.netTaxableGallons).toBe('-500.0000');
    expect(ky.taxDue).toBe('-140.00');
    // The surcharge still runs on the 1,000 taxable gallons.
    expect(ky.surchargeDue).toBe('44.00');
  });
});

describe('what it refuses to do', () => {
  it('will not compute a return with no fuel data', () => {
    // Not an edge case to handle gracefully: it means the fuel has not
    // arrived, and a figure without it is a guess dressed as a filing.
    expect(() => calculateIfta(base({ fuelByJurisdiction: [] }))).toThrow(IftaInputError);
  });

  it('will not compute a return with no miles', () => {
    expect(() => calculateIfta(base({ milesByJurisdiction: [] }))).toThrow(IftaInputError);
  });

  it('will not treat a missing rate as zero tax', () => {
    const r = calculateIfta(
      base({ rates: [{ jurisdiction: 'OH', ratePerGallon: '0.47000' }] }),
    );
    // PA has miles and fuel but no rate. Its line is withheld and the
    // shortfall is named, rather than the total quietly missing PA's tax.
    expect(r.lines.map((l) => l.jurisdiction)).toEqual(['OH']);
    expect(r.problems.some((p) => /PA: no tax rate on file/.test(p))).toBe(true);
    expect(r.problems.some((p) => /NOT in the total/.test(p))).toBe(true);
  });

  it('will not silently round away precision the source carried', () => {
    expect(() => calculateIfta(base({ rates: [{ jurisdiction: 'OH', ratePerGallon: '0.470005' }] }))).toThrow(
      /more than 5 decimal places/,
    );
  });

  it('calls a single-jurisdiction period what it is', () => {
    const r = calculateIfta(
      base({
        milesByJurisdiction: [{ jurisdiction: 'NY', miles: '118145.67' }],
        fuelByJurisdiction: [{ jurisdiction: 'NY', gallons: '18000.0000' }],
        rates: [{ jurisdiction: 'NY', ratePerGallon: '0.41300' }],
      }),
    );
    // The operator's real mileage exports are single-state. That is not a
    // complete return and the engine says so rather than filing it.
    expect(r.problems.some((p) => /single-jurisdiction figure is not a complete IFTA return/.test(p))).toBe(
      true,
    );
  });
});

describe('quarter versus accrual', () => {
  it('recognises the four filing quarters', () => {
    expect(classifyPeriod('2026-01-01', '2026-03-31')).toBe('quarter');
    expect(classifyPeriod('2026-04-01', '2026-06-30')).toBe('quarter');
    expect(classifyPeriod('2026-07-01', '2026-09-30')).toBe('quarter');
    expect(classifyPeriod('2026-10-01', '2026-12-31')).toBe('quarter');
  });

  it('calls anything else an accrual', () => {
    // A weekly figure is what is building up, not something fileable. Both
    // get quoted in the same sentence and only one can be filed.
    expect(classifyPeriod('2026-04-06', '2026-04-12')).toBe('accrual');
    expect(classifyPeriod('2026-04-01', '2026-04-30')).toBe('accrual');
    expect(classifyPeriod('2026-01-01', '2026-06-30')).toBe('accrual');
    expect(classifyPeriod('2026-10-01', '2027-12-31')).toBe('accrual');
  });

  it('labels the result and says so in the problems', () => {
    const weekly = calculateIfta(base({ periodStart: '2026-04-06', periodEnd: '2026-04-12' }));
    expect(weekly.periodKind).toBe('accrual');
    expect(weekly.problems.some((p) => /not a return that can be filed/.test(p))).toBe(true);

    // The arithmetic is identical — only the label and the caveat differ.
    expect(weekly.netDue).toBe(calculateIfta(base()).netDue);
  });
});

describe('exactness', () => {
  it('does not drift across many jurisdictions', () => {
    const many = Array.from({ length: 48 }, (_, i) => ({
      jurisdiction: `J${String(i).padStart(2, '0')}`.slice(0, 2).toUpperCase(),
      miles: '1000.33',
    }));
    // Deliberately awkward: 48 × 1000.33 miles on an inexact MPG.
    const r = calculateIfta({
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
      milesByJurisdiction: many,
      fuelByJurisdiction: [{ jurisdiction: many[0]!.jurisdiction, gallons: '7333.0000' }],
      rates: many.map((m) => ({ jurisdiction: m.jurisdiction, ratePerGallon: '0.33300' })),
    });
    // Every line's totalDue must add to netDue exactly — no float residue.
    const summed = r.lines.reduce((acc, l) => acc + Math.round(Number(l.totalDue) * 100), 0);
    expect(summed).toBe(Math.round(Number(r.netDue) * 100));
  });
});
