/**
 * The nesting invariant, as a property rather than a worked example.
 *
 * "The parts sum to the whole" is the single property a period roll-up has
 * to satisfy, because the alternative is two screens showing two different
 * totals for the same fleet and the same dates — and both look plausible.
 *
 * `summary-periods.test.ts` checks it for twelve clean calendar months.
 * These check the cases that broke it: a range that does not start on a
 * period boundary, and a grain that does not respect the range's boundary
 * at all. An ISO week belongs to whichever year its Monday falls in, so a
 * weekly series for calendar 2026 used to reach from 2025-12-29 to
 * 2027-01-03. Measured on that bug: $5,000 booked on 30 Dec 2025 plus
 * $1,000 in June 2026 plus $7,000 on 2 Jan 2027 summed to $13,000 across
 * the weeks while the year period reported $1,000. Both were labelled 2026.
 */
import { describe, expect, it } from 'vitest';
import type { Grain } from '@/contract/types';
import { centsFromDecimal, sumCents } from '@/engines/registration';
import {
  periodsCovering,
  summarizeTruck,
  summarizeTruckSeries,
  type SummaryLedgerEntry,
} from '@/engines/summary';

function revenue(entryId: string, accrualDate: string, amount: string): SummaryLedgerEntry {
  return {
    entryId,
    entityId: 'entity-zone',
    truckId: 'truck-1',
    accrualDate,
    categoryId: 'revenue.dispatch',
    categoryGroup: 'revenue',
    accountNature: 'pnl',
    amount,
    chargedTo: 'company',
    allocationBasis: 'actual',
    unitType: 'truck',
    unitNumber: '1001',
    paidByEntityId: null,
    counterpartyEntityId: null,
  };
}

const GRAINS: Grain[] = ['day', 'week', 'month', 'quarter', 'year'];

describe('periodsCovering never leaves the range it was asked for', () => {
  it.each(GRAINS)('a %s series over a calendar year starts and ends on that year', (grain) => {
    const periods = periodsCovering(grain, '2026-01-01', '2026-12-31');
    expect(periods[0]!.periodStart).toBe('2026-01-01');
    expect(periods[periods.length - 1]!.periodEnd).toBe('2026-12-31');
    expect(periods.every((p) => p.periodStart >= '2026-01-01' && p.periodEnd <= '2026-12-31')).toBe(true);
  });

  it.each(GRAINS)('a %s series over a ragged range is clamped to that range', (grain) => {
    const periods = periodsCovering(grain, '2026-01-15', '2026-11-20');
    expect(periods[0]!.periodStart).toBe('2026-01-15');
    expect(periods[periods.length - 1]!.periodEnd).toBe('2026-11-20');
  });

  it.each(GRAINS)('a %s series is gapless and non-overlapping after clamping', (grain) => {
    const periods = periodsCovering(grain, '2026-01-15', '2026-11-20');
    for (let i = 1; i < periods.length; i++) {
      const prevEnd = periods[i - 1]!.periodEnd;
      const thisStart = periods[i]!.periodStart;
      // Chronological, adjacent, and the previous period ends strictly
      // before this one begins: no day is in two buckets or in none.
      expect(thisStart > prevEnd).toBe(true);
      const prev = new Date(`${prevEnd}T00:00:00Z`).getTime();
      const next = new Date(`${thisStart}T00:00:00Z`).getTime();
      expect(next - prev).toBe(24 * 60 * 60 * 1000);
    }
  });

  it('keeps a whole-month bucket whole when the range already aligns', () => {
    const months = periodsCovering('month', '2026-01-01', '2026-12-31');
    expect(months).toHaveLength(12);
    expect(months[1]).toEqual({ periodStart: '2026-02-01', periodEnd: '2026-02-28' });
  });
});

describe('the parts sum to the whole, at every grain', () => {
  // Deliberately placed at the edges an unclamped series used to swallow:
  // the last days of the prior year and the first days of the next one.
  const entries = [
    revenue('prior-year', '2025-12-30', '5000.00'),
    revenue('mid-year', '2026-06-15', '1000.00'),
    revenue('next-year', '2027-01-02', '7000.00'),
  ];

  it.each(GRAINS)(
    'a %s series over 2026 equals the 2026 period, and excludes the neighbouring years',
    (grain) => {
      const series = summarizeTruckSeries(entries, 'truck-1', grain, '2026-01-01', '2026-12-31');
      const whole = summarizeTruck(entries, 'truck-1', {
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
      });

      const seriesCents = sumCents(series.map((s) => centsFromDecimal(s.revenue)));
      expect(seriesCents).toBe(centsFromDecimal(whole.revenue));
      // And the figure itself is the one booked inside 2026, not $13,000.
      expect(seriesCents).toBe(100000);
    },
  );

  it.each(GRAINS)('a %s series over a ragged range equals that exact range', (grain) => {
    const ragged = [
      revenue('before', '2026-01-14', '400.00'),
      revenue('inside-a', '2026-01-20', '250.00'),
      revenue('inside-b', '2026-07-04', '175.50'),
      revenue('inside-c', '2026-11-20', '99.99'),
      revenue('after', '2026-11-21', '800.00'),
    ];
    const series = summarizeTruckSeries(ragged, 'truck-1', grain, '2026-01-15', '2026-11-20');
    const whole = summarizeTruck(ragged, 'truck-1', {
      periodStart: '2026-01-15',
      periodEnd: '2026-11-20',
    });

    const seriesCents = sumCents(series.map((s) => centsFromDecimal(s.revenue)));
    expect(seriesCents).toBe(centsFromDecimal(whole.revenue));
    // 250.00 + 175.50 + 99.99 — the day before and the day after are out.
    expect(seriesCents).toBe(52549);
  });

  it('margin nests as exactly as revenue does', () => {
    const withCost = [
      revenue('r', '2026-03-10', '4000.00'),
      {
        ...revenue('c', '2026-03-11', '-1250.75'),
        categoryId: 'fuel.diesel',
        categoryGroup: 'fuel' as const,
      },
      {
        ...revenue('c2', '2026-09-02', '-333.33'),
        categoryId: 'maintenance.repair',
        categoryGroup: 'maintenance' as const,
      },
    ];
    for (const grain of GRAINS) {
      const series = summarizeTruckSeries(withCost, 'truck-1', grain, '2026-01-01', '2026-12-31');
      const whole = summarizeTruck(withCost, 'truck-1', {
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
      });
      expect(sumCents(series.map((s) => centsFromDecimal(s.margin)))).toBe(
        centsFromDecimal(whole.margin),
      );
    }
  });

  it('a single-day range is one bucket at every grain', () => {
    const oneDay = [revenue('only', '2026-05-05', '123.45')];
    for (const grain of GRAINS) {
      const series = summarizeTruckSeries(oneDay, 'truck-1', grain, '2026-05-05', '2026-05-05');
      expect(series).toHaveLength(1);
      expect(series[0]!.revenue).toBe('123.45');
    }
  });
});
