import { describe, expect, it } from 'vitest';
import { isDecimal } from '@/contract/types';
import { checkTotalsSum, extractMoney, sumDecimals } from '@/ingest/extract/money';

describe('extractMoney', () => {
  // Shapes SOURCE-DISCOVERY.md §2 documents from the real Dispatch sheet.
  it.each([
    ['$2,400.00', '2400.00'],
    ['3000', '3000'],
    ['$ 2,346', '2346'],
    ['3.56$', '3.56'], // fuel sheet's suffix dollar sign
    ['($40.00)', '-40.00'], // accounting-style negative
    ['-812.44', '-812.44'],
  ])('parses %s as %s', (raw, expected) => {
    const field = extractMoney(raw);
    expect(field.value).toBe(expected);
    expect(field.needsReview).toBe(false);
    expect(isDecimal(field.value!)).toBe(true);
    expect(typeof field.value).toBe('string'); // never a JS number
  });

  it('never returns a number type, only a decimal string', () => {
    const field = extractMoney('$1,234.56');
    expect(typeof field.value).toBe('string');
  });

  it('treats an empty cell as null, never zero', () => {
    const field = extractMoney('   ');
    expect(field.value).toBeNull();
    expect(field.needsReview).toBe(true);
  });

  it('flags unparseable free text (a lane-text cell, not an amount) rather than fabricating a value', () => {
    for (const bad of ['transit', 'OFF', 'TOWING', 'Truck is not ready', '#DIV/0!']) {
      const field = extractMoney(bad);
      expect(field.value).toBeNull();
      expect(field.needsReview).toBe(true);
    }
  });
});

describe('sumDecimals / checkTotalsSum — never a float', () => {
  it('sums exactly, including values that are not float-safe when added naively', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE754; this must still come out exact.
    expect(sumDecimals(['0.10', '0.20'])).toBe('0.3');
  });

  it('reconciles the real IRP invoice fee lines to the cent (SOURCE-DISCOVERY.md §11c)', () => {
    const lines = ['4067.28', '74554.18', '336.00', '1.75'];
    const result = checkTotalsSum(lines, '78959.21');
    expect(result.ok).toBe(true);
    expect(result.computedSum).toBe('78959.21');
    expect(result.difference).toBe('0');
  });

  it('flags — does not silently trust either side — when lines do not sum to the stated total', () => {
    const lines = ['100.00', '50.00'];
    const result = checkTotalsSum(lines, '200.00');
    expect(result.ok).toBe(false);
    expect(result.computedSum).toBe('150'); // exact value; trailing zeros are not significant in a decimal string
    expect(result.difference).toBe('-50');
  });
});
