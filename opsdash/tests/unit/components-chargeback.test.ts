import { describe, expect, it } from 'vitest';
import type { ChargebackDecision, ChargebackRow } from '@/components/data/types';
import {
  applyBulkDecision,
  densestFirst,
  driverOwedFromRow,
  driverShareCents,
  invalidDecisionReason,
  isValidDecision,
  needsDecision,
  runningDriverTotals,
} from '@/components/chargeback/logic';

function makeRow(overrides: Partial<ChargebackRow> = {}): ChargebackRow {
  return {
    costRowId: 'cost-1',
    sourceRef: { kind: 'sheet', label: 'Truck and trailer expenses ZONE', rowRef: 'row-12' },
    truckId: 'trk-50174',
    driverId: 'drv-1',
    driverClass: 'lease_to_own',
    vendor: 'M&Y',
    description: 'brake job',
    accrualDate: '2026-01-06',
    amount: '-693.44',
    categoryId: 'maintenance.repair',
    chargedTo: 'unknown',
    decision: null,
    ...overrides,
  };
}

describe('a split decision needs an amount or a percentage, not just a label', () => {
  it('rejects split with no ratio at all', () => {
    const decision = { chargedTo: 'split' as const, splitRatio: null };
    expect(isValidDecision(decision)).toBe(false);
    expect(invalidDecisionReason(decision)).toMatch(/needs an amount or a percentage/);
  });

  it('accepts a valid percentage split', () => {
    const decision = { chargedTo: 'split' as const, splitRatio: { kind: 'percentage' as const, driverShare: '60.00' } };
    expect(isValidDecision(decision)).toBe(true);
  });

  it('rejects a percentage split over 100', () => {
    const decision = { chargedTo: 'split' as const, splitRatio: { kind: 'percentage' as const, driverShare: '150.00' } };
    expect(isValidDecision(decision)).toBe(false);
  });

  it('accepts a valid amount split', () => {
    const decision = { chargedTo: 'split' as const, splitRatio: { kind: 'amount' as const, driverShare: '200.00' } };
    expect(isValidDecision(decision)).toBe(true);
  });

  it('rejects a non-split decision that carries a stray ratio', () => {
    const decision = { chargedTo: 'company' as const, splitRatio: { kind: 'amount' as const, driverShare: '10.00' } };
    expect(isValidDecision(decision)).toBe(false);
  });

  it('company/driver/unknown with no ratio are valid', () => {
    expect(isValidDecision({ chargedTo: 'company', splitRatio: null })).toBe(true);
    expect(isValidDecision({ chargedTo: 'driver', splitRatio: null })).toBe(true);
    expect(isValidDecision({ chargedTo: 'unknown', splitRatio: null })).toBe(true);
  });
});

describe('driverShareCents — exact split arithmetic, never a float', () => {
  it('computes an exact percentage share, rounded half-up', () => {
    // 60% of $693.44 = $416.064 -> rounds to $416.06
    expect(driverShareCents('-693.44', { kind: 'percentage', driverShare: '60.00' })).toBe(41606n);
  });

  it('an amount split is capped at the row total, never negative or over', () => {
    expect(driverShareCents('-100.00', { kind: 'amount', driverShare: '40.00' })).toBe(4000n);
    expect(driverShareCents('-100.00', { kind: 'amount', driverShare: '500.00' })).toBe(10000n); // capped
  });
});

describe('driverOwedFromRow', () => {
  it('a company-charged row contributes nothing', () => {
    const row = makeRow({ chargedTo: 'company', decision: { chargedTo: 'company', splitRatio: null, note: null, decidedBy: 'a', decidedAt: 'now' } });
    expect(driverOwedFromRow(row)).toBe('0.00');
  });

  it('a driver-charged row contributes the full amount', () => {
    const row = makeRow({
      amount: '-693.44',
      chargedTo: 'driver',
      decision: { chargedTo: 'driver', splitRatio: null, note: null, decidedBy: 'a', decidedAt: 'now' },
    });
    expect(driverOwedFromRow(row)).toBe('693.44');
  });

  it('a split row contributes exactly the computed share', () => {
    const row = makeRow({
      amount: '-693.44',
      chargedTo: 'split',
      decision: {
        chargedTo: 'split',
        splitRatio: { kind: 'percentage', driverShare: '60.00' },
        note: null,
        decidedBy: 'a',
        decidedAt: 'now',
      },
    });
    expect(driverOwedFromRow(row)).toBe('416.06');
  });

  it('an undecided row contributes nothing', () => {
    expect(driverOwedFromRow(makeRow())).toBe('0.00');
  });
});

describe('runningDriverTotals — what a driver now owes, so the decider sees the consequence', () => {
  it('accumulates across multiple decided rows for the same driver', () => {
    const rows: ChargebackRow[] = [
      makeRow({
        costRowId: 'c1',
        driverId: 'drv-1',
        amount: '-100.00',
        chargedTo: 'driver',
        decision: { chargedTo: 'driver', splitRatio: null, note: null, decidedBy: 'a', decidedAt: 'now' },
      }),
      makeRow({
        costRowId: 'c2',
        driverId: 'drv-1',
        amount: '-50.00',
        chargedTo: 'driver',
        decision: { chargedTo: 'driver', splitRatio: null, note: null, decidedBy: 'a', decidedAt: 'now' },
      }),
      makeRow({ costRowId: 'c3', driverId: 'drv-2', amount: '-999.00' }), // undecided, different driver
    ];
    const totals = runningDriverTotals(rows);
    expect(totals.get('drv-1')).toBe('150.00');
    expect(totals.has('drv-2')).toBe(false);
  });
});

describe('densestFirst — the biggest cluster of decidable rows sorts first', () => {
  it('groups by driver+vendor and sorts largest group first', () => {
    const rows: ChargebackRow[] = [
      makeRow({ costRowId: 'a1', driverId: 'drv-1', vendor: 'EFS' }),
      makeRow({ costRowId: 'a2', driverId: 'drv-1', vendor: 'EFS' }),
      makeRow({ costRowId: 'a3', driverId: 'drv-1', vendor: 'EFS' }),
      makeRow({ costRowId: 'b1', driverId: 'drv-2', vendor: 'M&Y' }),
    ];
    const ordered = densestFirst(rows);
    expect(ordered.slice(0, 3).map((r) => r.costRowId).sort()).toEqual(['a1', 'a2', 'a3']);
    expect(ordered[3]?.costRowId).toBe('b1');
  });
});

describe('applyBulkDecision — sets every selected row and nothing else', () => {
  it('applies the decision only to the selected ids', () => {
    const rows: ChargebackRow[] = [
      makeRow({ costRowId: 'r1' }),
      makeRow({ costRowId: 'r2' }),
      makeRow({ costRowId: 'r3' }),
    ];
    const decision: ChargebackDecision = { chargedTo: 'company', splitRatio: null, note: null, decidedBy: 'ops@example.com', decidedAt: 'now' };
    const updated = applyBulkDecision(rows, new Set(['r1', 'r3']), decision);

    expect(updated.find((r) => r.costRowId === 'r1')?.chargedTo).toBe('company');
    expect(updated.find((r) => r.costRowId === 'r3')?.chargedTo).toBe('company');
    expect(updated.find((r) => r.costRowId === 'r2')?.chargedTo).toBe('unknown');
    expect(updated.find((r) => r.costRowId === 'r2')?.decision).toBeNull();
    // Untouched rows come back as the same reference — bulk apply must not
    // rebuild rows it didn't touch.
    expect(updated.find((r) => r.costRowId === 'r2')).toBe(rows[1]);
  });

  it('refuses to apply an invalid split decision to anything', () => {
    const rows = [makeRow({ costRowId: 'r1' })];
    const badDecision: ChargebackDecision = { chargedTo: 'split', splitRatio: null, note: null, decidedBy: 'ops', decidedAt: 'now' };
    expect(() => applyBulkDecision(rows, new Set(['r1']), badDecision)).toThrow();
  });
});

describe('needsDecision', () => {
  it('is true only for rows still at the default unknown/no-decision state', () => {
    expect(needsDecision(makeRow())).toBe(true);
    expect(
      needsDecision(makeRow({ chargedTo: 'company', decision: { chargedTo: 'company', splitRatio: null, note: null, decidedBy: 'a', decidedAt: 'now' } })),
    ).toBe(false);
  });
});
