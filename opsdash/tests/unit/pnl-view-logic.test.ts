/**
 * The P&L screen's presentation logic.
 *
 * Every function under test is a place where a P&L can read as more
 * certain than it is: a percentage where there is no denominator, a
 * clamped period sitting beside full ones, a caveat quietly omitted
 * because it happened to be zero.
 */
import { describe, expect, it } from 'vitest';
import type { PnlBucket } from '@/engines/summary';
import {
  barShare,
  byLargestCost,
  categoryGroupLabel,
  caveatsFor,
  isPartialPeriod,
  marginPercent,
  periodLabel,
} from '@/components/pnl/logic';

function bucket(over: Partial<PnlBucket> = {}): PnlBucket {
  return {
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    days: 31,
    revenue: '0.00',
    companyCostByCategoryGroup: [],
    companyCostTotal: '0.00',
    driverBorneCostByCategoryGroup: [],
    driverBorneCostTotal: '0.00',
    margin: '0.00',
    costPerDay: '0.00',
    allocatedAmounts: [],
    excludedBalanceSheetTotal: '0.00',
    excludedBalanceSheetCount: 0,
    entryCount: 0,
    ...over,
  };
}

describe('marginPercent', () => {
  it('computes a percentage to one decimal place, exactly', () => {
    expect(marginPercent('4000.00', '2749.25')).toBe('68.7%');
    expect(marginPercent('1000.00', '250.00')).toBe('25.0%');
    expect(marginPercent('3.00', '1.00')).toBe('33.3%');
  });

  it('keeps the sign on a loss', () => {
    expect(marginPercent('1000.00', '-250.00')).toBe('-25.0%');
  });

  it('returns null when there is no revenue, rather than 0.0%', () => {
    // A period with costs and no revenue has an UNDEFINED margin
    // percentage, not a zero one. Rendering 0.0% invites someone to read a
    // truck that earned nothing as merely breaking even.
    expect(marginPercent('0.00', '-500.00')).toBeNull();
    expect(marginPercent('0.00', '0.00')).toBeNull();
  });

  it('does not go through a float', () => {
    // 0.1 + 0.2 territory: a float route would drift on repeated thirds.
    expect(marginPercent('99999999.99', '33333333.33')).toBe('33.3%');
  });
});

describe('barShare', () => {
  it('is proportional to the largest bar, not to the total', () => {
    expect(barShare('-500.00', '-1000.00')).toBe(0.5);
    expect(barShare('-1000.00', '-1000.00')).toBe(1);
  });

  it('ignores sign — a cost bar is drawn by magnitude', () => {
    expect(barShare('250.00', '-1000.00')).toBe(0.25);
  });

  it('never divides by zero and never exceeds full width', () => {
    expect(barShare('-500.00', '0.00')).toBe(0);
    expect(barShare('-2000.00', '-1000.00')).toBe(1);
  });
});

describe('byLargestCost', () => {
  it('orders by magnitude, largest first, regardless of sign', () => {
    const ordered = byLargestCost([
      { categoryGroup: 'toll', amount: '-100.00', entryCount: 1 },
      { categoryGroup: 'fuel', amount: '-9000.00', entryCount: 40 },
      { categoryGroup: 'other_cost', amount: '250.00', entryCount: 2 },
    ]);
    expect(ordered.map((g) => g.categoryGroup)).toEqual(['fuel', 'other_cost', 'toll']);
  });

  it('does not mutate its input', () => {
    const input = [
      { categoryGroup: 'toll' as const, amount: '-100.00', entryCount: 1 },
      { categoryGroup: 'fuel' as const, amount: '-9000.00', entryCount: 2 },
    ];
    byLargestCost(input);
    expect(input[0]!.categoryGroup).toBe('toll');
  });
});

describe('periodLabel', () => {
  it('labels each grain the way someone reading that grain expects', () => {
    const p = { periodStart: '2026-03-09', periodEnd: '2026-03-15' };
    expect(periodLabel(p, 'day')).toBe('9 Mar 2026');
    expect(periodLabel(p, 'week')).toBe('w/c 9 Mar');
    expect(periodLabel({ periodStart: '2026-03-01', periodEnd: '2026-03-31' }, 'month')).toBe('Mar 2026');
    expect(periodLabel({ periodStart: '2026-07-01', periodEnd: '2026-09-30' }, 'quarter')).toBe('Q3 2026');
    expect(periodLabel({ periodStart: '2026-01-01', periodEnd: '2026-12-31' }, 'year')).toBe('2026');
  });

  it('falls back to the literal span when there is no grain', () => {
    expect(periodLabel({ periodStart: '2026-01-15', periodEnd: '2026-11-20' }, null)).toBe(
      '2026-01-15 → 2026-11-20',
    );
  });
});

describe('isPartialPeriod', () => {
  it('is false for a bucket covering its whole period', () => {
    expect(isPartialPeriod(bucket({ periodStart: '2026-01-01', periodEnd: '2026-01-31', days: 31 }), 'month')).toBe(
      false,
    );
  });

  it('is true for a bucket the range clamped', () => {
    // The cost of clamping a series to its range: a 17-day January would
    // otherwise sit beside twelve full months and read as a terrible month
    // rather than a short one.
    expect(isPartialPeriod(bucket({ periodStart: '2026-01-15', periodEnd: '2026-01-31', days: 17 }), 'month')).toBe(
      true,
    );
  });

  it('handles a leap-year February without calling it partial', () => {
    expect(isPartialPeriod(bucket({ periodStart: '2028-02-01', periodEnd: '2028-02-29', days: 29 }), 'month')).toBe(
      false,
    );
  });

  it('is never true when no grain was requested', () => {
    // With no grain there is one bucket covering exactly the range, so
    // "partial" has nothing to be partial against.
    expect(isPartialPeriod(bucket({ periodStart: '2026-01-15', periodEnd: '2026-11-20', days: 310 }), null)).toBe(
      false,
    );
  });
});

describe('caveatsFor', () => {
  const workQueue = { unresolvedChargebackCount: 713, unresolvedChargebackAmount: '-12345.67' };

  it('reports every caveat even when it is zero', () => {
    const caveats = caveatsFor(bucket(), {
      unresolvedChargebackCount: 0,
      unresolvedChargebackAmount: '0.00',
    });
    // "Nothing unresolved" is information an accountant wants confirmed,
    // not inferred from a row that quietly did not render.
    expect(caveats.map((c) => c.id)).toEqual([
      'unresolved-chargeback',
      'balance-sheet',
      'driver-receivable',
    ]);
    expect(caveats.every((c) => c.amount !== null)).toBe(true);
  });

  it('carries the unresolved chargeback figure straight through', () => {
    const caveats = caveatsFor(bucket(), workQueue);
    const unresolved = caveats.find((c) => c.id === 'unresolved-chargeback')!;
    expect(unresolved.amount).toBe('-12345.67');
    expect(unresolved.count).toBe(713);
  });

  it('shows the driver receivable as a caveat, not as a cost', () => {
    const caveats = caveatsFor(bucket({ driverBorneCostTotal: '3850.00' }), workQueue);
    const receivable = caveats.find((c) => c.id === 'driver-receivable')!;
    expect(receivable.amount).toBe('3850.00');
    expect(receivable.detail).toMatch(/not subtracted from margin/i);
  });

  it('surfaces the stripped balance-sheet total rather than letting it vanish', () => {
    const caveats = caveatsFor(
      bucket({ excludedBalanceSheetTotal: '78959.21', excludedBalanceSheetCount: 42 }),
      workQueue,
    );
    const stripped = caveats.find((c) => c.id === 'balance-sheet')!;
    expect(stripped.amount).toBe('78959.21');
    expect(stripped.count).toBe(42);
  });
});

describe('categoryGroupLabel', () => {
  it('reads as English, and passes an unknown group through unchanged', () => {
    expect(categoryGroupLabel('driver_pay')).toBe('Driver pay');
    expect(categoryGroupLabel('permit')).toBe('Permits & registration');
    expect(categoryGroupLabel('something_new')).toBe('something_new');
  });
});
