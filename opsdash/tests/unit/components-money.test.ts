import { describe, expect, it } from 'vitest';
import {
  absMoney,
  addMoney,
  centsToMoney,
  compareMoney,
  moneyEquals,
  moneyToCents,
  subtractMoney,
  sumMoney,
} from '@/components/format/decimal';

describe('money arithmetic — exact, BigInt-backed, never Number()/parseFloat', () => {
  it('adds and subtracts exactly, no float drift', () => {
    expect(addMoney('1879.98', '0.02')).toBe('1880.00');
    expect(subtractMoney('1880.00', '0.02')).toBe('1879.98');
    // The classic float trap: 0.1 + 0.2 !== 0.3 in IEEE754.
    expect(addMoney('0.10', '0.20')).toBe('0.30');
  });

  it('sums a list exactly', () => {
    expect(sumMoney(['1.10', '2.20', '3.30'])).toBe('6.60');
    expect(sumMoney([])).toBe('0.00');
  });

  it('handles signed values and negative results', () => {
    expect(subtractMoney('10.00', '14.10')).toBe('-4.10');
    expect(addMoney('-5.00', '-5.00')).toBe('-10.00');
  });

  it('round-trips through cents', () => {
    expect(moneyToCents('1879.98')).toBe(187998n);
    expect(centsToMoney(187998n)).toBe('1879.98');
    expect(centsToMoney(-410n)).toBe('-4.10');
    expect(centsToMoney(0n)).toBe('0.00');
  });

  it('absMoney strips the sign', () => {
    expect(absMoney('-4.10')).toBe('4.10');
    expect(absMoney('4.10')).toBe('4.10');
  });

  it('compareMoney is exact, not a float subtraction', () => {
    expect(compareMoney('4.10', '4.10')).toBe(0);
    expect(compareMoney('4.09', '4.10')).toBe(-1);
    expect(compareMoney('4.11', '4.10')).toBe(1);
  });

  it('moneyEquals treats differently-padded equal values as equal', () => {
    expect(moneyEquals('5', '5.00')).toBe(true);
    expect(moneyEquals('5.01', '5.00')).toBe(false);
  });

  it('rejects a malformed money string rather than silently truncating', () => {
    expect(() => moneyToCents('4.10.5')).toThrow();
    expect(() => moneyToCents('abc')).toThrow();
  });
});
