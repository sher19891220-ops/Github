import { describe, expect, it } from 'vitest';
import { pickMcNumber } from '@/server/fmcsa';

/**
 * Pins the shape FMCSA actually returns.
 *
 * The carrier record has no `mcNumber` field at all — docket numbers are a
 * separate resource. Reading it off the carrier returns undefined for every
 * carrier without throwing, so the MC field just appears empty and looks like
 * missing FMCSA data rather than a defect. These cases are taken from live
 * responses for USDOT 3456789 and 80806.
 */
describe('pickMcNumber', () => {
  it('extracts the MC docket from a live-shaped response', () => {
    expect(
      pickMcNumber([
        { docketNumber: 1127064, docketNumberId: 1129285, dotNumber: 3456789, prefix: 'MC' },
      ]),
    ).toBe('MC1127064');
  });

  it('picks MC when other docket prefixes are present', () => {
    expect(
      pickMcNumber([
        { docketNumber: 900001, prefix: 'FF' },
        { docketNumber: 135797, prefix: 'MC' },
        { docketNumber: 700002, prefix: 'MX' },
      ]),
    ).toBe('MC135797');
  });

  it('returns null when the carrier holds no MC docket', () => {
    expect(pickMcNumber([{ docketNumber: 900001, prefix: 'FF' }])).toBeNull();
    expect(pickMcNumber([])).toBeNull();
  });

  it('tolerates the shapes a flaky upstream can return', () => {
    expect(pickMcNumber(null)).toBeNull();
    expect(pickMcNumber(undefined)).toBeNull();
    expect(pickMcNumber({})).toBeNull();
    expect(pickMcNumber([{ prefix: 'MC' }])).toBeNull(); // prefix, no number
    expect(pickMcNumber([{ docketNumber: 123 }])).toBeNull(); // number, no prefix
  });

  it('accepts a string docket number', () => {
    expect(pickMcNumber([{ docketNumber: '135797', prefix: 'mc' }])).toBe('MC135797');
  });
});
