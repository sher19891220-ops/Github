import { describe, expect, it } from 'vitest';
import { startOfDay, todayWindow, yesterdayWindow, ymd } from '../src/time';

const CHICAGO = 'America/Chicago';

describe('startOfDay', () => {
  it('returns local midnight during daylight saving time', () => {
    // 2026-08-17 09:30 UTC is 04:30 in Chicago (UTC-5 in summer).
    const start = startOfDay(new Date('2026-08-17T09:30:00Z'), CHICAGO);
    expect(start.toISOString()).toBe('2026-08-17T05:00:00.000Z');
  });

  it('returns local midnight during standard time', () => {
    // Chicago is UTC-6 in January.
    const start = startOfDay(new Date('2026-01-15T09:30:00Z'), CHICAGO);
    expect(start.toISOString()).toBe('2026-01-15T06:00:00.000Z');
  });

  it('uses the local calendar day, not the UTC one', () => {
    // 03:00 UTC on the 18th is still the evening of the 17th in Chicago.
    const start = startOfDay(new Date('2026-08-18T03:00:00Z'), CHICAGO);
    expect(start.toISOString()).toBe('2026-08-17T05:00:00.000Z');
  });

  it('works for a positive UTC offset', () => {
    const start = startOfDay(new Date('2026-08-17T09:30:00Z'), 'Asia/Tashkent');
    expect(start.toISOString()).toBe('2026-08-16T19:00:00.000Z');
  });
});

describe('ymd', () => {
  it('formats the local calendar date', () => {
    expect(ymd(new Date('2026-08-18T03:00:00Z'), CHICAGO)).toBe('2026-08-17');
    expect(ymd(new Date('2026-08-18T03:00:00Z'), 'UTC')).toBe('2026-08-18');
  });
});

describe('todayWindow', () => {
  it('runs from local midnight to now', () => {
    const now = new Date('2026-08-17T18:00:00Z');
    const window = todayWindow(now, CHICAGO);
    expect(window.start.toISOString()).toBe('2026-08-17T05:00:00.000Z');
    expect(window.end).toBe(now);
    expect(window.key).toBe('2026-08-17');
  });
});

describe('yesterdayWindow', () => {
  it('covers the full previous local day', () => {
    const window = yesterdayWindow(new Date('2026-08-17T18:00:00Z'), CHICAGO);
    expect(window.start.toISOString()).toBe('2026-08-16T05:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-08-17T05:00:00.000Z');
    expect(window.key).toBe('2026-08-16');
  });

  it('handles the spring-forward boundary', () => {
    // US DST began 2026-03-08; the previous day is 24h long, the day itself 23h.
    const window = yesterdayWindow(new Date('2026-03-09T12:00:00Z'), CHICAGO);
    expect(window.start.toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-03-09T05:00:00.000Z');
  });

  it('handles the fall-back boundary', () => {
    // US DST ended 2026-11-01, making that day 25 hours long.
    const window = yesterdayWindow(new Date('2026-11-02T12:00:00Z'), CHICAGO);
    expect(window.start.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-11-02T06:00:00.000Z');
    expect(window.key).toBe('2026-11-01');
  });
});
