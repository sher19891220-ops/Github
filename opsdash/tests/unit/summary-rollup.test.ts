import { describe, expect, it } from 'vitest';
import { centsFromDecimal, sumCents } from '@/engines/registration';
import {
  buildPnlBucket,
  resolveBearing,
  summarizeEntity,
  summarizeTruck,
} from '@/engines/summary';
import type { SummaryLedgerEntry } from '@/engines/summary';

/**
 * These fixtures are hand-built, round-number arithmetic exercises — they
 * verify the engine's math and reconciliation identities, not any real
 * business fact about the fleet. (Real, fixture-backed proofs against the
 * live IRP/HVUT transaction are in summary-intercompany.test.ts,
 * summary-chargeback.test.ts and summary-closed-months.test.ts.)
 */
function entry(overrides: Partial<SummaryLedgerEntry> & Pick<SummaryLedgerEntry, 'entryId' | 'amount'>): SummaryLedgerEntry {
  return {
    entityId: 'entity-zone',
    truckId: 'truck-1',
    accrualDate: '2026-06-15',
    categoryId: 'fuel.diesel',
    categoryGroup: 'fuel',
    chargedTo: 'company',
    allocationBasis: 'actual',
    unitType: 'truck',
    unitNumber: '1001',
    paidByEntityId: null,
    counterpartyEntityId: null,
    ...overrides,
  };
}

const JUNE = { periodStart: '2026-06-01', periodEnd: '2026-06-30' };

describe('resolveBearing', () => {
  it('a company-charged cost lands entirely on company, unchanged sign', () => {
    const b = resolveBearing({ amount: '-500.00', chargedTo: 'company' });
    expect(b).toEqual({ companyCents: -50000, driverCents: 0, needsHuman: false });
  });

  it('rule 1: a driver-charged cost is a positive receivable, not a company cost', () => {
    const b = resolveBearing({ amount: '-500.00', chargedTo: 'driver' });
    expect(b.companyCents).toBe(0);
    expect(b.driverCents).toBe(50000);
    expect(b.needsHuman).toBe(false);
  });

  it('an unknown chargeback lands nowhere and is flagged for a human', () => {
    const b = resolveBearing({ amount: '-500.00', chargedTo: 'unknown' });
    expect(b).toEqual({ companyCents: 0, driverCents: 0, needsHuman: true });
  });

  it('a split with no resolved share is treated exactly like unknown, never guessed', () => {
    const b = resolveBearing({ amount: '-500.00', chargedTo: 'split', splitDriverShare: null });
    expect(b).toEqual({ companyCents: 0, driverCents: 0, needsHuman: true });
  });

  it('a resolved split divides the cost exactly, company keeping its sign', () => {
    const b = resolveBearing({ amount: '-500.00', chargedTo: 'split', splitDriverShare: '200.00' });
    expect(b.driverCents).toBe(20000);
    expect(b.companyCents).toBe(-30000);
    expect(b.companyCents + -b.driverCents).toBe(-50000); // company + driver share reconstructs the row
  });

  it('a bad split share larger than the row clamps rather than inverting the company side', () => {
    const b = resolveBearing({ amount: '-500.00', chargedTo: 'split', splitDriverShare: '9999.00' });
    expect(b.driverCents).toBe(50000);
    expect(b.companyCents).toBe(0);
  });
});

describe('buildPnlBucket', () => {
  it('revenue minus company cost is margin; driver-borne cost is excluded from both', () => {
    const entries: SummaryLedgerEntry[] = [
      entry({ entryId: 'rev-1', categoryId: 'revenue.dispatch', categoryGroup: 'revenue', amount: '3000.00' }),
      entry({ entryId: 'fuel-1', categoryId: 'fuel.diesel', categoryGroup: 'fuel', amount: '-800.00', chargedTo: 'company' }),
      entry({ entryId: 'maint-1', categoryId: 'maintenance.repair', categoryGroup: 'maintenance', amount: '-400.00', chargedTo: 'driver' }),
    ];
    const bucket = buildPnlBucket(entries, JUNE);
    expect(bucket.revenue).toBe('3000.00');
    expect(bucket.companyCostTotal).toBe('-800.00'); // the driver-charged repair never touches this
    expect(bucket.driverBorneCostTotal).toBe('400.00'); // a receivable, positive
    expect(bucket.margin).toBe('2200.00'); // 3000 - 800, NOT 3000 - 800 - 400
    expect(bucket.entryCount).toBe(3);
  });

  it('cost-per-day is the company cost magnitude divided by the period length', () => {
    const entries: SummaryLedgerEntry[] = [
      entry({ entryId: 'fuel-1', amount: '-300.00', accrualDate: '2026-06-10' }),
    ];
    const bucket = buildPnlBucket(entries, JUNE); // 30 days
    expect(bucket.days).toBe(30);
    expect(bucket.costPerDay).toBe('10.00');
  });

  it('an allocated figure is carried through with its basis, never presented as measured', () => {
    const entries: SummaryLedgerEntry[] = [
      entry({ entryId: 'irp-1', categoryId: 'permit.irp', categoryGroup: 'permit', amount: '-1879.98', allocationBasis: 'even_split' }),
      entry({ entryId: 'irp-2', categoryId: 'tax.hvut', categoryGroup: 'permit', amount: '-45.83', allocationBasis: 'actual' }),
    ];
    const bucket = buildPnlBucket(entries, JUNE);
    expect(bucket.allocatedAmounts).toEqual([
      { categoryGroup: 'permit', allocationBasis: 'even_split', bearer: 'company', amount: '-1879.98', entryCount: 1 },
    ]);
    // The actual-basis HVUT row does not appear in allocatedAmounts at all.
    expect(bucket.allocatedAmounts.some((a) => a.amount === '-45.83')).toBe(false);
  });

  it('a balance-sheet category (prepaid asset) is excluded from every total and reported separately', () => {
    const entries: SummaryLedgerEntry[] = [
      entry({ entryId: 'prepaid-1', categoryId: 'prepaid.registration', categoryGroup: 'other_cost', amount: '-78959.21' }),
      entry({ entryId: 'irp-month-1', categoryId: 'permit.irp', categoryGroup: 'permit', amount: '-156.67' }),
    ];
    const bucket = buildPnlBucket(entries, JUNE);
    expect(bucket.companyCostTotal).toBe('-156.67'); // the prepaid payment never lands here
    expect(bucket.excludedBalanceSheetTotal).toBe('78959.21');
    expect(bucket.excludedBalanceSheetCount).toBe(1);
    expect(bucket.entryCount).toBe(1); // the prepaid row is not counted as a P&L entry
  });

  it('rule 3: a category matching "principal" is stripped from every total, not just discounted', () => {
    // No loan/lease-financing category exists in accounting.category yet
    // (SOURCE-DISCOVERY §15 calls this explicitly open) — this is the
    // defensive net for whenever one lands, e.g. "lease.principal".
    const entries: SummaryLedgerEntry[] = [
      entry({ entryId: 'loan-1', categoryId: 'lease.principal', categoryGroup: 'lease', amount: '-2413.69' }),
      entry({ entryId: 'loan-2', categoryId: 'lease.interest', categoryGroup: 'lease', amount: '-159.08' }),
    ];
    const bucket = buildPnlBucket(entries, JUNE);
    expect(bucket.companyCostTotal).toBe('-159.08'); // only interest is a cost
    expect(bucket.excludedBalanceSheetTotal).toBe('2413.69');
  });
});

describe('reconciliation: per-truck sums to per-entity, to the cent', () => {
  it('sum(trucks) + unattributed === the entity total, exactly', () => {
    const entries: SummaryLedgerEntry[] = [
      entry({ entryId: 'rev-t1', truckId: 'truck-1', categoryId: 'revenue.dispatch', categoryGroup: 'revenue', amount: '2500.37' }),
      entry({ entryId: 'fuel-t1', truckId: 'truck-1', amount: '-611.19', chargedTo: 'company' }),
      entry({ entryId: 'maint-t1', truckId: 'truck-1', categoryId: 'maintenance.repair', categoryGroup: 'maintenance', amount: '-233.41', chargedTo: 'driver' }),
      entry({ entryId: 'rev-t2', truckId: 'truck-2', unitNumber: '1002', categoryId: 'revenue.dispatch', categoryGroup: 'revenue', amount: '1899.00' }),
      entry({ entryId: 'fuel-t2', truckId: 'truck-2', unitNumber: '1002', amount: '-402.87', chargedTo: 'company' }),
      // Office/fleet-level cost with no truck at all.
      entry({ entryId: 'office-1', truckId: null, unitNumber: null, unitType: 'unknown', categoryId: 'other_cost.office', categoryGroup: 'other_cost', amount: '-88.13' }),
    ];
    const entityResult = summarizeEntity(entries, 'entity-zone', JUNE);
    const truck1 = summarizeTruck(entries, 'truck-1', JUNE);
    const truck2 = summarizeTruck(entries, 'truck-2', JUNE);

    expect(entityResult.trucks).toHaveLength(2);
    expect(entityResult.trucks.map((t) => t.truckId).sort()).toEqual(['truck-1', 'truck-2']);

    const partsSum = (vals: string[]) => sumCents(vals.map(centsFromDecimal));

    // margin
    expect(partsSum([truck1.margin, truck2.margin, entityResult.unattributed.margin])).toBe(
      centsFromDecimal(entityResult.margin),
    );
    // revenue
    expect(partsSum([truck1.revenue, truck2.revenue, entityResult.unattributed.revenue])).toBe(
      centsFromDecimal(entityResult.revenue),
    );
    // company cost
    expect(
      partsSum([truck1.companyCostTotal, truck2.companyCostTotal, entityResult.unattributed.companyCostTotal]),
    ).toBe(centsFromDecimal(entityResult.companyCostTotal));
    // driver-borne cost
    expect(
      partsSum([truck1.driverBorneCostTotal, truck2.driverBorneCostTotal, entityResult.unattributed.driverBorneCostTotal]),
    ).toBe(centsFromDecimal(entityResult.driverBorneCostTotal));

    // And the concrete figures, computed independently, agree to the cent.
    expect(entityResult.revenue).toBe('4399.37');
    expect(entityResult.companyCostTotal).toBe('-1102.19');
    expect(entityResult.driverBorneCostTotal).toBe('233.41');
    expect(entityResult.margin).toBe('3297.18');
  });
});
