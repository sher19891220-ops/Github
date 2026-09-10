import { describe, expect, it } from 'vitest';
import { checkDateInPeriod, flagLinesIfTotalMismatch, isDateWithinPeriod } from '@/ingest/extract/validators';
import { cleanField } from '@/ingest/extract/types';

describe('checkDateInPeriod', () => {
  it('accepts a date inside the document period', () => {
    const f = checkDateInPeriod('2026-03-15', '2026-01-01', '2026-12-31');
    expect(f.needsReview).toBe(false);
    expect(f.value).toBe('2026-03-15');
  });

  it('flags a date outside the document period rather than trusting it', () => {
    const f = checkDateInPeriod('2019-03-15', '2026-01-01', '2026-12-31');
    expect(f.needsReview).toBe(true);
    expect(f.value).toBe('2019-03-15'); // kept, not dropped — a human decides
    expect(f.reason).toMatch(/outside/);
  });

  it('flags a missing date as null, never a fabricated one', () => {
    const f = checkDateInPeriod(null, '2026-01-01', '2026-12-31');
    expect(f.value).toBeNull();
    expect(f.needsReview).toBe(true);
  });

  it('flags a malformed date string', () => {
    const f = checkDateInPeriod('03/15/2026', '2026-01-01', '2026-12-31');
    expect(f.needsReview).toBe(true);
  });

  it('boundary dates are inclusive', () => {
    expect(isDateWithinPeriod('2026-01-01', '2026-01-01', '2026-12-31')).toBe(true);
    expect(isDateWithinPeriod('2026-12-31', '2026-01-01', '2026-12-31')).toBe(true);
    expect(isDateWithinPeriod('2027-01-01', '2026-01-01', '2026-12-31')).toBe(false);
  });
});

describe('flagLinesIfTotalMismatch', () => {
  it('leaves every line untouched when the real IRP fee lines sum exactly (SOURCE-DISCOVERY.md §11c)', () => {
    const lines = [
      cleanField('4067.28', 0.9),
      cleanField('74554.18', 0.9),
      cleanField('336.00', 0.9),
      cleanField('1.75', 0.9),
    ];
    const result = flagLinesIfTotalMismatch(lines, '78959.21');
    expect(result.every((l) => l.needsReview === false)).toBe(true);
  });

  it('flags EVERY line — not just one, not just the total — when the lines do not sum', () => {
    const lines = [cleanField('100.00', 0.9), cleanField('50.00', 0.9), cleanField('25.00', 0.9)];
    const result = flagLinesIfTotalMismatch(lines, '999.99'); // does not match 175.00
    expect(result).toHaveLength(3);
    expect(result.every((l) => l.needsReview === true)).toBe(true);
    expect(result.every((l) => l.reason && l.reason.length > 0)).toBe(true);
    // Values are preserved — flagged, not dropped.
    expect(result.map((l) => l.value)).toEqual(['100.00', '50.00', '25.00']);
  });

  it('flags every line when one line failed to parse at all, since the total cannot be verified either', () => {
    const lines = [cleanField('100.00', 0.9), { value: null, confidence: 0, needsReview: true, reason: 'unparseable' }];
    const result = flagLinesIfTotalMismatch(lines, '100.00');
    expect(result.every((l) => l.needsReview === true)).toBe(true);
  });
});
