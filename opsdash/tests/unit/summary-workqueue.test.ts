import { describe, expect, it } from 'vitest';
import { buildWorkQueueSummary } from '@/engines/summary';
import type { SummaryLedgerEntry } from '@/engines/summary';

function entry(overrides: Partial<SummaryLedgerEntry> & Pick<SummaryLedgerEntry, 'entryId' | 'amount'>): SummaryLedgerEntry {
  return {
    entityId: 'entity-zone',
    truckId: null,
    accrualDate: '2026-06-15',
    categoryId: 'maintenance.repair',
    categoryGroup: 'maintenance',
    chargedTo: 'company',
    allocationBasis: 'actual',
    unitType: 'unknown',
    unitNumber: null,
    paidByEntityId: null,
    counterpartyEntityId: null,
    ...overrides,
  };
}

describe('buildWorkQueueSummary', () => {
  it('counts an unknown chargeback and its dollar amount', () => {
    const summary = buildWorkQueueSummary([
      entry({ entryId: 'a', amount: '-412.50', chargedTo: 'unknown' }),
      entry({ entryId: 'b', amount: '-88.00', chargedTo: 'company' }),
    ]);
    expect(summary.unresolvedChargebackCount).toBe(1);
    expect(summary.unresolvedChargebackAmount).toBe('412.50');
  });

  it('counts an unresolved split alongside unknown, in the same bucket', () => {
    const summary = buildWorkQueueSummary([
      entry({ entryId: 'a', amount: '-100.00', chargedTo: 'split', splitDriverShare: null }),
      entry({ entryId: 'b', amount: '-50.00', chargedTo: 'split', splitDriverShare: '20.00' }), // resolved, doesn't count
    ]);
    expect(summary.unresolvedChargebackCount).toBe(1);
    expect(summary.unresolvedChargebackAmount).toBe('100.00');
  });

  it('flags a cost row with no unit at all, only for unit-attributable category groups', () => {
    const summary = buildWorkQueueSummary([
      entry({ entryId: 'a', amount: '-300.00', categoryGroup: 'maintenance', unitType: 'unknown', truckId: null, unitNumber: null }),
      // driver_pay legitimately has no unit — not flagged.
      entry({ entryId: 'b', amount: '-900.00', categoryGroup: 'driver_pay', unitType: 'unknown', truckId: null, unitNumber: null }),
      // a maintenance row that does name a unit — not flagged.
      entry({ entryId: 'c', amount: '-150.00', categoryGroup: 'maintenance', unitType: 'trailer', unitNumber: 'trl-9001' }),
    ]);
    expect(summary.unresolvedUnitTypeCount).toBe(1);
    expect(summary.unresolvedUnitTypeAmount).toBe('300.00');
  });

  it('counts a caller-flagged validation failure', () => {
    const summary = buildWorkQueueSummary([
      entry({ entryId: 'a', amount: '-75.25', failsValidation: true }),
      entry({ entryId: 'b', amount: '-10.00' }),
    ]);
    expect(summary.failingValidationCount).toBe(1);
    expect(summary.failingValidationAmount).toBe('75.25');
  });

  it('surfaces a stripped principal-pattern row as its own diagnostic, never silent', () => {
    const summary = buildWorkQueueSummary([
      entry({ entryId: 'a', amount: '-2413.69', categoryId: 'lease.principal', categoryGroup: 'lease' }),
    ]);
    expect(summary.excludedPrincipalCount).toBe(1);
    expect(summary.excludedPrincipalAmount).toBe('2413.69');
  });

  it('an all-clean set of rows produces an all-zero summary', () => {
    const summary = buildWorkQueueSummary([
      entry({ entryId: 'a', amount: '-100.00', chargedTo: 'company', unitType: 'truck', truckId: 't1' }),
    ]);
    expect(summary).toEqual({
      unresolvedChargebackCount: 0,
      unresolvedChargebackAmount: '0.00',
      unresolvedUnitTypeCount: 0,
      unresolvedUnitTypeAmount: '0.00',
      failingValidationCount: 0,
      failingValidationAmount: '0.00',
      excludedPrincipalCount: 0,
      excludedPrincipalAmount: '0.00',
    });
  });
});
