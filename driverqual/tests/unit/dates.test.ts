import { describe, expect, it } from 'vitest';
import {
  addMonths,
  compareIsoDates,
  completedMonths,
  completedYears,
  daysBetween,
  isValidIsoDate,
  isWithinWindow,
  lookbackWindow,
} from '@/domain/dates';

describe('completedMonths', () => {
  it('counts whole calendar months and never rounds up', () => {
    expect(completedMonths('2024-06-15', '2026-08-14')).toBe(25);
    expect(completedMonths('2024-06-15', '2026-08-15')).toBe(26);
    expect(completedMonths('2024-06-15', '2026-08-19')).toBe(26);
  });

  it('returns 0 for same-day and reversed ranges', () => {
    expect(completedMonths('2026-08-19', '2026-08-19')).toBe(0);
    expect(completedMonths('2026-08-19', '2024-01-01')).toBe(0);
  });

  it('clamps the anniversary day to the last day of a short month', () => {
    // Issued on the 31st; February completes the month on the 28th/29th.
    expect(completedMonths('2024-01-31', '2024-02-29')).toBe(1);
    expect(completedMonths('2024-01-31', '2024-02-28')).toBe(0);
    expect(completedMonths('2025-01-31', '2025-02-28')).toBe(1);
  });

  it('handles leap-day origins', () => {
    expect(completedMonths('2024-02-29', '2025-02-28')).toBe(12);
    expect(completedMonths('2024-02-29', '2025-03-01')).toBe(12);
  });

  it('24 completed months satisfies a two-year minimum', () => {
    const months = completedMonths('2024-08-19', '2026-08-19');
    expect(months).toBe(24);
    expect(months >= 24).toBe(true);
    expect(completedYears('2024-08-19', '2026-08-19')).toBe(2);
  });

  it('28 completed months is more than two years, never less', () => {
    const months = completedMonths('2024-04-19', '2026-08-19');
    expect(months).toBe(28);
    expect(months).toBeGreaterThan(24);
    expect(months < 24).toBe(false);
    expect(completedYears('2024-04-19', '2026-08-19')).toBe(2);
  });
});

describe('addMonths', () => {
  it('clamps to the end of a shorter target month', () => {
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('crosses year boundaries in both directions', () => {
    expect(addMonths('2026-07-31', -36)).toBe('2023-07-31');
    expect(addMonths('2023-01-15', -1)).toBe('2022-12-15');
    expect(addMonths('2022-12-15', 1)).toBe('2023-01-15');
  });
});

describe('lookbackWindow', () => {
  it('anchors on the supplied date and includes both endpoints', () => {
    const w = lookbackWindow('2026-07-31', 36);
    expect(w.start).toBe('2023-07-31');
    expect(w.end).toBe('2026-07-31');
    expect(isWithinWindow('2023-07-31', w)).toBe(true);
    expect(isWithinWindow('2026-07-31', w)).toBe(true);
    expect(isWithinWindow('2023-07-30', w)).toBe(false);
    expect(isWithinWindow('2026-08-01', w)).toBe(false);
  });

  it('rejects a non-positive lookback', () => {
    expect(() => lookbackWindow('2026-07-31', 0)).toThrow(RangeError);
    expect(() => lookbackWindow('2026-07-31', -12)).toThrow(RangeError);
  });
});

describe('date validation and comparison', () => {
  it('rejects impossible calendar dates', () => {
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('2026-00-10')).toBe(false);
    expect(isValidIsoDate('07/31/2026')).toBe(false);
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
  });

  it('orders dates without timezone drift', () => {
    expect(compareIsoDates('2026-01-01', '2025-12-31')).toBeGreaterThan(0);
    expect(compareIsoDates('2026-01-01', '2026-01-01')).toBe(0);
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2); // leap year
  });
});
