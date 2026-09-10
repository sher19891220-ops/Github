import { describe, expect, it } from 'vitest';
import { formatMoney, formatQuantity, formatRate } from '@/components/format/decimal';

describe('formatMoney — renders the decimal string, never a parsed number', () => {
  it('renders the exact readiness-criterion example', () => {
    expect(formatMoney('1879.98')).toBe('1,879.98');
  });

  it('never reproduces float error from an intermediate Number() conversion', () => {
    // If this ever went through `Number('1879.98').toFixed(10)` or similar,
    // this is exactly the failure mode: "1879.9800000001".
    expect(formatMoney('1879.98')).not.toContain('98000000');
    expect(formatMoney('1879.98')).toBe('1,879.98');
  });

  it('groups thousands and preserves sign', () => {
    expect(formatMoney('-81244.4')).toBe('-81,244.40');
    expect(formatMoney('2400.00')).toBe('2,400.00');
    expect(formatMoney('0')).toBe('0.00');
  });

  it('pads to two decimals without rounding', () => {
    expect(formatMoney('500')).toBe('500.00');
  });

  it('renders a placeholder for null/undefined, never "0" or "NaN"', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
  });

  it('never crashes or silently guesses on a malformed value — returns it verbatim', () => {
    expect(formatMoney('not-a-number' as unknown as string)).toBe('not-a-number');
  });
});

describe('formatQuantity', () => {
  it('preserves up to four fractional digits as given', () => {
    expect(formatQuantity('80.0000')).toBe('80.0000');
    expect(formatQuantity('223.8')).toBe('223.8');
  });

  it('renders a placeholder when the parser never captured a gallon amount', () => {
    // SOURCE-DISCOVERY §3: ~97.5% of fuel rows read "full tank" instead of a
    // number, and the ingest layer must emit null, never 0 or a guess.
    expect(formatQuantity(null)).toBe('—');
  });
});

describe('formatRate — the registration engine\'s 6-decimal analysis rates', () => {
  it('renders full precision without rounding to money-grade 2dp', () => {
    expect(formatRate('257.534247')).toBe('257.534247');
  });
});
