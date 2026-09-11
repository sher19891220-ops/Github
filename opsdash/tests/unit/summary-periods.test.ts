import { describe, expect, it } from 'vitest';
import { centsFromDecimal, sumCents } from '@/engines/registration';
import { periodsCovering, summarizeTruck, summarizeTruckSeries } from '@/engines/summary';
import type { SummaryLedgerEntry } from '@/engines/summary';

function revenueEntry(entryId: string, accrualDate: string, amount: string): SummaryLedgerEntry {
  return {
    entryId,
    entityId: 'entity-zone',
    truckId: 'truck-1',
    accrualDate,
    categoryId: 'revenue.dispatch',
    categoryGroup: 'revenue',
    amount,
    chargedTo: 'company',
    allocationBasis: 'actual',
    unitType: 'truck',
    unitNumber: '1001',
    paidByEntityId: null,
    counterpartyEntityId: null,
  };
}

describe('periodsCovering', () => {
  it('partitions a year into exactly 12 non-overlapping, gapless months', () => {
    const periods = periodsCovering('month', '2026-01-01', '2026-12-31');
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ periodStart: '2026-01-01', periodEnd: '2026-01-31' });
    expect(periods[11]).toEqual({ periodStart: '2026-12-01', periodEnd: '2026-12-31' });
    // Gapless: every period start is exactly one day after the previous end.
    for (let i = 1; i < periods.length; i++) {
      const prevEnd = new Date(`${periods[i - 1]!.periodEnd}T00:00:00Z`);
      const thisStart = new Date(`${periods[i]!.periodStart}T00:00:00Z`);
      expect(thisStart.getTime() - prevEnd.getTime()).toBe(24 * 60 * 60 * 1000);
    }
  });

  it('handles a leap-year February correctly (2028)', () => {
    const periods = periodsCovering('month', '2028-02-01', '2028-02-29');
    expect(periods).toEqual([{ periodStart: '2028-02-01', periodEnd: '2028-02-29' }]);
  });

  it('a quarter is exactly 3 months, and 4 quarters cover the year with no gap', () => {
    const quarters = periodsCovering('quarter', '2026-01-01', '2026-12-31');
    expect(quarters).toEqual([
      { periodStart: '2026-01-01', periodEnd: '2026-03-31' },
      { periodStart: '2026-04-01', periodEnd: '2026-06-30' },
      { periodStart: '2026-07-01', periodEnd: '2026-09-30' },
      { periodStart: '2026-10-01', periodEnd: '2026-12-31' },
    ]);
  });
});

describe('readiness criterion 5: period roll-ups nest exactly', () => {
  // Twelve distinct, non-round monthly revenue figures — deliberately
  // irregular so a rounding bug in a single month would not cancel out
  // against another month by coincidence.
  const MONTHLY_REVENUE = [
    '10432.17', '9876.54', '11203.09', '8765.43', '12345.67', '9999.99',
    '10101.01', '11550.30', '8888.88', '12000.00', '9432.10', '10765.43',
  ];

  const entries: SummaryLedgerEntry[] = MONTHLY_REVENUE.map((amount, i) => {
    const month = String(i + 1).padStart(2, '0');
    return revenueEntry(`rev-2026-${month}`, `2026-${month}-15`, amount);
  });

  it('summing 12 monthly results reproduces the single year-period result, to the cent', () => {
    const monthly = summarizeTruckSeries(entries, 'truck-1', 'month', '2026-01-01', '2026-12-31');
    expect(monthly).toHaveLength(12);

    const yearResult = summarizeTruck(entries, 'truck-1', { periodStart: '2026-01-01', periodEnd: '2026-12-31' });

    const summedRevenueCents = sumCents(monthly.map((m) => centsFromDecimal(m.revenue)));
    const summedMarginCents = sumCents(monthly.map((m) => centsFromDecimal(m.margin)));

    expect(summedRevenueCents).toBe(centsFromDecimal(yearResult.revenue));
    expect(summedMarginCents).toBe(centsFromDecimal(yearResult.margin));

    // And against the real hand-summed total, independently computed.
    const expectedTotalCents = sumCents(MONTHLY_REVENUE.map(centsFromDecimal));
    expect(summedRevenueCents).toBe(expectedTotalCents);
    expect(yearResult.revenue).toBe('125360.61');
  });

  it('4 quarterly results reproduce the same year total as 12 monthly results', () => {
    const quarterly = summarizeTruckSeries(entries, 'truck-1', 'quarter', '2026-01-01', '2026-12-31');
    expect(quarterly).toHaveLength(4);
    const monthly = summarizeTruckSeries(entries, 'truck-1', 'month', '2026-01-01', '2026-12-31');

    const quarterlyCents = sumCents(quarterly.map((q) => centsFromDecimal(q.revenue)));
    const monthlyCents = sumCents(monthly.map((m) => centsFromDecimal(m.revenue)));
    expect(quarterlyCents).toBe(monthlyCents);
  });
});
