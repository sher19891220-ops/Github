/**
 * What a fuel-card line actually bought.
 *
 * This is the highest-value rule in the fuel-card parser and the one a
 * plausible implementation gets wrong, because DEF, reefer diesel and
 * gasoline all arrive on the same invoice priced per gallon. Only one of
 * the four is IFTA diesel.
 */
import { describe, expect, it } from 'vitest';
import { classifyProduct, productLabel } from '@/ingest/fuelcard/product';

describe('classifyProduct', () => {
  it('recognises on-road diesel in the spellings vendors actually print', () => {
    for (const s of [
      'DIESEL',
      'ULSD',
      'ULSD #2',
      'DSL',
      '#2 DIESEL',
      'Biodiesel B20',
      'ON-ROAD DIESEL',
      'TRACTOR FUEL',
    ]) {
      const r = classifyProduct(s);
      expect(r.kind, s).toBe('diesel');
      expect(r.countsAsIftaDiesel, s).toBe(true);
    }
  });

  it('never counts DEF as diesel, however it is written', () => {
    // DEF is sold by the gallon at a gallon price on the same receipt.
    // Counted as diesel it inflates tax-paid gallons, claiming a credit
    // that was never earned — which understates tax owed.
    for (const s of ['DEF', 'DEF BULK', 'Diesel Exhaust Fluid', 'DEF/DIESEL EXHAUST FLUID', 'AdBlue']) {
      const r = classifyProduct(s);
      expect(r.kind, s).toBe('def');
      expect(r.countsAsIftaDiesel, s).toBe(false);
    }
  });

  it('checks DEF before diesel, because the description contains both', () => {
    // A diesel-first matcher classifies this as taxable fuel.
    expect(classifyProduct('DEF - DIESEL EXHAUST FLUID').kind).toBe('def');
  });

  it('does not mistake ordinary words containing "def" for DEF', () => {
    expect(classifyProduct('DEFAULT PRODUCT CODE').kind).not.toBe('def');
  });

  it('keeps reefer and dyed fuel out of the taxable gallons', () => {
    for (const s of ['REEFER', 'REEFER DIESEL', 'DIESEL - REEFER', 'DYED DIESEL', 'OFF-ROAD DIESEL', 'RFR']) {
      const r = classifyProduct(s);
      expect(r.kind, s).toBe('reefer');
      expect(r.countsAsIftaDiesel, s).toBe(false);
    }
  });

  it('keeps gasoline apart from diesel, since it is a different fuel type', () => {
    // Gasoline IS IFTA taxable — under its own rate. Added to diesel it
    // computes one fleet MPG across two fuels and prices the result at the
    // diesel rate.
    for (const s of ['UNLEADED', 'GASOLINE', 'UNL REGULAR', 'PREMIUM UNL']) {
      const r = classifyProduct(s);
      expect(r.kind, s).toBe('gasoline');
      expect(r.countsAsIftaDiesel, s).toBe(false);
    }
  });

  it('does not call a fuel additive diesel', () => {
    // Found by running the classifier over the operator's real expense
    // sheet: "diesel anti gel" and "Anti gel diesel" both appear
    // verbatim, and a diesel-first matcher put their quantity into an
    // IFTA return. Anti-gel is poured into the tank; it is not fuel.
    for (const s of ['diesel anti gel', 'Anti gel diesel', 'FUEL TREATMENT', 'Howes', 'cetane booster']) {
      const r = classifyProduct(s);
      expect(r.kind, s).toBe('non_fuel');
      expect(r.countsAsIftaDiesel, s).toBe(false);
    }
  });

  it('recognises the non-fuel lines a card statement is full of', () => {
    for (const s of ['CASH ADVANCE', 'SCALE', 'SHOWER', 'PARKING', 'TIRE REPAIR', 'OIL', 'TRANSACTION FEE']) {
      const r = classifyProduct(s);
      expect(r.kind, s).toBe('non_fuel');
      expect(r.countsAsIftaDiesel, s).toBe(false);
    }
  });

  it('classifies anything it cannot name as unknown, never as diesel', () => {
    // The default must be the safe one. A line nobody can name does not
    // get to put gallons into a tax filing on the strength of having a
    // number in the quantity column.
    const r = classifyProduct('PRD-4471');
    expect(r.kind).toBe('unknown');
    expect(r.countsAsIftaDiesel).toBe(false);
    expect(r.reason).toMatch(/rather than assumed to be diesel/);
  });

  it('treats an empty product cell as unclassifiable, not as diesel', () => {
    expect(classifyProduct('   ').kind).toBe('unknown');
    expect(classifyProduct('').countsAsIftaDiesel).toBe(false);
  });

  it('labels every kind for the review screen', () => {
    for (const k of ['diesel', 'def', 'reefer', 'gasoline', 'non_fuel', 'unknown'] as const) {
      expect(productLabel(k).length).toBeGreaterThan(0);
    }
  });
});
