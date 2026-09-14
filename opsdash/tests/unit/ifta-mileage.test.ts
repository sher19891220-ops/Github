/**
 * The IFTA mileage report parser.
 *
 * Built against the operator's real telematics export and verified against
 * it before these tests were written: 5 of 5 vehicle blocks, both internal
 * checksums satisfied, zero problems reported. The fixtures below are
 * synthetic — this repository is public and real VINs and unit numbers are
 * fleet data — but they are the real document's shape, cell for cell.
 *
 * What is being tested is mostly the parser's willingness to say it is
 * wrong. Cost per mile is linear in miles, so an error here moves every
 * downstream per-mile figure by the same proportion; a mileage parser that
 * returns a confident wrong number is worse than one that returns nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  hundredthsFromMiles,
  milesFromHundredths,
  parseIftaMileage,
} from '@/ingest/ifta/parseMileage';

/** The real document's shape: carrier line, count, period, one block per
 *  vehicle, then the report's own totals by state. */
const SINGLE_STATE = `
DEMO CARRIER LLC 100 Example Road Springfield IL 60000

IFTA by Vehicles: 2

2026-04-01 - 2026-06-30

Vehicle: 1001 (1AAAAAAAAAAAAAAA1)

Seq State Miles

1 NY 3,758.04

Total 3,758.04

Vehicle: 1002 (1BBBBBBBBBBBBBBB2)

Seq State Miles

1 NY 1,241.96

Total 1,241.96

Total Distance by State

Seq State Miles

1 NY 5,000.00

Total 5,000.00
`;

/** The multi-jurisdiction case. Every real report seen so far carries one
 *  state, but the format is plainly built for several and a quarter that
 *  only ever reports one is not a complete IFTA return. */
const MULTI_STATE = `
DEMO CARRIER LLC

IFTA by Vehicles: 1

2026-01-01 - 2026-03-31

Vehicle: 2001 (1CCCCCCCCCCCCCCC3)

Seq State Miles

1 OH 1,200.50

2 IN 800.25

3 IL 499.25

Total 2,500.00

Total Distance by State

Seq State Miles

1 OH 1,200.50

2 IN 800.25

3 IL 499.25

Total 2,500.00
`;

describe('hundredthsFromMiles', () => {
  it('reads the thousands separator the report prints', () => {
    expect(hundredthsFromMiles('3,758.04')).toBe(375804);
    expect(hundredthsFromMiles('118,145.67')).toBe(11814567);
    expect(hundredthsFromMiles('457.95')).toBe(45795);
  });

  it('round-trips exactly', () => {
    for (const v of ['0.00', '1.05', '2,888.75', '118,145.67']) {
      expect(milesFromHundredths(hundredthsFromMiles(v))).toBe(v.replace(/,/g, ''));
    }
  });

  it('refuses anything it would have to guess at', () => {
    // Never silently zero: a mileage figure that cannot be read must stop
    // the parse, not quietly contribute nothing to a state total.
    expect(() => hundredthsFromMiles('')).toThrow();
    expect(() => hundredthsFromMiles('n/a')).toThrow();
    expect(() => hundredthsFromMiles('1.234')).toThrow();
  });
});

describe('parseIftaMileage', () => {
  it('reads the report and finds no problem with a consistent one', () => {
    const r = parseIftaMileage(SINGLE_STATE);

    expect(r.periodStart).toBe('2026-04-01');
    expect(r.periodEnd).toBe('2026-06-30');
    expect(r.statedVehicleCount).toBe(2);
    expect(r.vehicles).toHaveLength(2);
    expect(r.problems).toEqual([]);

    expect(r.vehicles[0]).toMatchObject({
      unitNumber: '1001',
      vin: '1AAAAAAAAAAAAAAA1',
      statedTotal: '3758.04',
      totalMismatch: null,
    });
    expect(r.vehicles[0]!.states).toEqual([{ jurisdiction: 'NY', miles: '3758.04' }]);
  });

  it('reports a single-jurisdiction extract as such', () => {
    // Not an error — but a quarter with one state is not a complete
    // return, and a caller has to be able to tell.
    expect(parseIftaMileage(SINGLE_STATE).jurisdictions).toEqual(['NY']);
  });

  it('handles several states on one vehicle', () => {
    const r = parseIftaMileage(MULTI_STATE);
    expect(r.problems).toEqual([]);
    expect(r.jurisdictions).toEqual(['IL', 'IN', 'OH']);
    expect(r.vehicles[0]!.states).toHaveLength(3);
    expect(r.vehicles[0]!.statedTotal).toBe('2500.00');
  });

  it('catches a vehicle whose rows do not add up to its own total', () => {
    const tampered = MULTI_STATE.replace('3 IL 499.25', '3 IL 499.26');
    const r = parseIftaMileage(tampered);

    expect(r.vehicles[0]!.totalMismatch).toMatch(/add to 2500\.01 but the block states 2500\.00/);
    // Flagged, never corrected: the document disagreeing with itself is a
    // fact about the document.
    expect(r.vehicles[0]!.states[2]!.miles).toBe('499.26');
  });

  it('catches a dropped vehicle block, which the per-vehicle check cannot', () => {
    // Each surviving block is still internally consistent. Only the
    // report's own state total knows somebody is missing.
    const dropped = SINGLE_STATE.replace(
      `Vehicle: 1002 (1BBBBBBBBBBBBBBB2)

Seq State Miles

1 NY 1,241.96

Total 1,241.96

`,
      '',
    );
    const r = parseIftaMileage(dropped);

    expect(r.vehicles).toHaveLength(1);
    expect(r.vehicles[0]!.totalMismatch).toBeNull();
    expect(r.problems.some((p) => /vehicles add to 3758\.04.*total for that state is 5000\.00/.test(p))).toBe(
      true,
    );
    expect(r.problems.some((p) => /says 2 vehicles; 1 were found/.test(p))).toBe(true);
  });

  it('catches a state the vehicles report that the totals do not mention', () => {
    const extra = SINGLE_STATE.replace('1 NY 1,241.96', '1 PA 1,241.96');
    const r = parseIftaMileage(extra);
    expect(r.problems.some((p) => /PA: vehicles report 1241\.96 but the report has no total/.test(p))).toBe(
      true,
    );
  });

  it('keeps a unit number that is not a number', () => {
    // Some real units carry a letter prefix. A parser that assumed digits
    // would drop them.
    const lettered = SINGLE_STATE.replace('Vehicle: 1001', 'Vehicle: XY0000');
    expect(parseIftaMileage(lettered).vehicles[0]!.unitNumber).toBe('XY0000');
  });

  it('does not depend on blank lines between sections', () => {
    // Different PDF extractors in this project space these differently.
    const collapsed = SINGLE_STATE.split('\n').filter((l) => l.trim() !== '').join('\n');
    const r = parseIftaMileage(collapsed);
    expect(r.vehicles).toHaveLength(2);
    expect(r.problems).toEqual([]);
  });

  it('says so when there is no period, rather than filing miles nowhere', () => {
    const undated = SINGLE_STATE.replace('2026-04-01 - 2026-06-30', '');
    const r = parseIftaMileage(undated);
    expect(r.problems.some((p) => /no reporting period/i.test(p))).toBe(true);
  });

  it('returns an empty report rather than throwing on unrelated text', () => {
    const r = parseIftaMileage('This is not an IFTA report at all.');
    expect(r.vehicles).toEqual([]);
    expect(r.problems.length).toBeGreaterThan(0);
  });
});
