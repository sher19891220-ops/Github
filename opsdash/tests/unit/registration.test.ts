import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDecimal, isIsoDate } from '@/contract/types';
import {
  buildRegistrationPosting,
  parseIrpVehicleStatusReport,
  parseUnitStatusCsv,
} from '@/engines/registration';
import type {
  AmortizationScheduleRowDraft,
  IrpFeeLine,
  RegistrationPostingInput,
} from '@/engines/registration';
import { decimalFromCents, centsFromDecimal, evenSplitCents, sumCents } from '@/engines/registration/money';

// Real, live documents — never synthetic. See CLAUDE.md §2 and
// docs/SOURCE-DISCOVERY.md §11b/§11c, which quote this exact transaction.
const ROSTER_PATH = '/home/user/opsdash-fixtures/irp_invoice_units.txt';
const STATUS_PATH = '/home/user/opsdash-fixtures/irp_unit_status.csv';
const haveFixtures = existsSync(ROSTER_PATH) && existsSync(STATUS_PATH);

// The dollar figures below are quoted verbatim from the real paid invoice
// (SOURCE-DISCOVERY §11c) and the task's worked example. The roster text file
// carries unit identity (UNIT/USDOT/VIN/WEIGHT GROUP/...) but not dollars —
// real BMV "Vehicle Status" exports don't itemize fees per unit, which is
// exactly why this engine has to allocate rather than read a per-unit figure.
const REAL_FEE_LINES: IrpFeeLine[] = [
  { description: 'Registration Fee', categoryId: 'permit.irp', amount: '4067.28' },
  { description: 'Foreign Jurisdiction Fees', categoryId: 'permit.irp_foreign', amount: '74554.18' },
  { description: 'BMV Fee', categoryId: 'permit.bmv', amount: '336.00' },
  { description: 'Postage Fee', categoryId: 'permit.bmv', amount: '1.75' },
];
const REAL_INVOICE_TOTAL = '78959.21';
const REAL_HVUT_RATE = '550.00';

describe.skipIf(!haveFixtures)('registration engine — real IRP/HVUT transaction', () => {
  const rosterText = haveFixtures ? readFileSync(ROSTER_PATH, 'utf8') : '';
  const statusText = haveFixtures ? readFileSync(STATUS_PATH, 'utf8') : '';

  describe('parseIrpVehicleStatusReport', () => {
    it('parses the header by column position, not hardcoded index', () => {
      const roster = parseIrpVehicleStatusReport(rosterText);
      expect(roster.header).toEqual({
        runDate: '2026-09-09',
        accountNo: '98142',
        legalName: 'ZONE-OH LLC',
        fleetNo: '001',
        fleetExpirationYear: 2027,
        fleetExpirationMonth: 9,
        totalUnits: 42,
      });
    });

    it('parses exactly 42 units, one per VIN, spanning both report pages', () => {
      const roster = parseIrpVehicleStatusReport(rosterText);
      expect(roster.units).toHaveLength(42);
      const vins = new Set(roster.units.map((u) => u.vin));
      expect(vins.size).toBe(42);
      // Confirms the parser followed the header past the page break rather
      // than stopping at page 1's "Page 1 of 2" footer.
      expect(roster.units.some((u) => u.unitNumber === '8671')).toBe(true);
    });

    it('every unit is weight group 80 — the fact the even-split allocation depends on', () => {
      const roster = parseIrpVehicleStatusReport(rosterText);
      expect(roster.units.every((u) => u.weightGroup === 80)).toBe(true);
    });

    it('throws rather than silently allocating evenly across mixed weight groups', () => {
      const roster = parseIrpVehicleStatusReport(rosterText);
      const mixed = {
        header: roster.header,
        units: roster.units.map((u, i) => (i === 0 ? { ...u, weightGroup: 100 } : u)),
      };
      const input = makeRegInput(mixed, []);
      expect(() => buildRegistrationPosting(input)).toThrow(/weight group/i);
    });
  });

  describe('parseUnitStatusCsv', () => {
    it('parses 42 rows and resolves the exact real split: 7 driver, 29 company, 6 unresolved', () => {
      const rows = parseUnitStatusCsv(statusText);
      expect(rows).toHaveLength(42);
      const counts = { company: 0, driver: 0, unknown: 0 };
      for (const r of rows) counts[r.hvutPayer as 'company' | 'driver' | 'unknown']++;
      expect(counts).toEqual({ company: 29, driver: 7, unknown: 6 });
    });

    it('never defaults an unresolved payer to company', () => {
      const rows = parseUnitStatusCsv(statusText);
      const unresolved = rows.filter((r) => r.status === 'UNKNOWN' || r.status === 'NO STATUS ROW');
      expect(unresolved.length).toBeGreaterThan(0);
      for (const r of unresolved) expect(r.hvutPayer).toBe('unknown');
    });
  });

  describe('buildRegistrationPosting — full posting', () => {
    const roster = haveFixtures ? parseIrpVehicleStatusReport(rosterText) : null;
    const statuses = haveFixtures ? parseUnitStatusCsv(statusText) : [];

    function makeInput(overrides: Partial<RegistrationPostingInput> = {}): RegistrationPostingInput {
      return makeRegInput(roster!, statuses, overrides);
    }

    it('guard: fee lines sum to the stated invoice total (78,959.21)', () => {
      const total = sumCents(REAL_FEE_LINES.map((f) => centsFromDecimal(f.amount)));
      expect(decimalFromCents(total)).toBe(REAL_INVOICE_TOTAL);
    });

    it('rejects an invoice whose fee lines do not reconcile to the stated total', () => {
      const input = makeInput({ invoiceTotal: '78959.20' });
      expect(() => buildRegistrationPosting(input)).toThrow(/reconcile/i);
    });

    it('reconciliation proof 1: IRP per-unit allocations sum to exactly 78,959.21', () => {
      const result = buildRegistrationPosting(makeInput());
      expect(result.reconciliation.irpAllocatedTotal).toBe('78959.21');
      const sum = sumCents(result.reconciliation.irpPerUnit.map((u) => centsFromDecimal(u.amount)));
      expect(decimalFromCents(sum)).toBe('78959.21');
    });

    it('distributes the $0.05 remainder as 5 units at $1,879.99 and 37 at $1,879.98', () => {
      const result = buildRegistrationPosting(makeInput());
      const at99 = result.reconciliation.irpPerUnit.filter((u) => u.amount === '1879.99');
      const at98 = result.reconciliation.irpPerUnit.filter((u) => u.amount === '1879.98');
      expect(at99).toHaveLength(5);
      expect(at98).toHaveLength(37);
      expect(at99.length + at98.length).toBe(42);
    });

    it('reconciliation proof 2: HVUT per-unit amounts sum to exactly 23,100.00', () => {
      const result = buildRegistrationPosting(makeInput());
      expect(result.reconciliation.hvutTotal).toBe('23100.00');
    });

    it('HVUT split matches the real driver/company/unknown totals exactly', () => {
      const result = buildRegistrationPosting(makeInput());
      expect(result.reconciliation.hvutByChargedTo).toEqual({
        company: '15950.00',
        driver: '3850.00',
        unknown: '3300.00',
      });
      expect(result.reconciliation.hvutUnitCountByChargedTo).toEqual({
        company: 29,
        driver: 7,
        unknown: 6,
      });
      const sumOfParts =
        centsFromDecimal(result.reconciliation.hvutByChargedTo.company) +
        centsFromDecimal(result.reconciliation.hvutByChargedTo.driver) +
        centsFromDecimal(result.reconciliation.hvutByChargedTo.unknown);
      expect(decimalFromCents(sumOfParts)).toBe('23100.00');
    });

    it('reconciliation proof 3: every unit\'s 12 monthly IRP rows sum to its own allocated total', () => {
      const result = buildRegistrationPosting(makeInput());
      const byUnitIrp = groupRows(result.scheduleRows, 'permit.irp');
      for (const perUnit of result.reconciliation.irpPerUnit) {
        const rows = byUnitIrp.get(perUnit.unitNumber) ?? [];
        expect(rows).toHaveLength(12);
        const sum = sumCents(rows.map((r) => -centsFromDecimal(r.amount))); // rows are negative outflows
        expect(decimalFromCents(sum)).toBe(perUnit.amount);
      }
    });

    it('every unit\'s 12 monthly HVUT rows sum to exactly 550.00', () => {
      const result = buildRegistrationPosting(makeInput());
      const byUnitHvut = groupRows(result.scheduleRows, 'tax.hvut');
      for (const [, rows] of byUnitHvut) {
        expect(rows).toHaveLength(12);
        const sum = sumCents(rows.map((r) => -centsFromDecimal(r.amount)));
        expect(decimalFromCents(sum)).toBe('550.00');
      }
    });

    it('covers exactly 2026-09 through 2027-08, the registration year', () => {
      const result = buildRegistrationPosting(makeInput());
      const months = new Set(result.scheduleRows.map((r) => r.periodMonth));
      expect([...months].sort()).toEqual([
        '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01',
        '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01',
        '2027-05-01', '2027-06-01', '2027-07-01', '2027-08-01',
      ]);
    });

    it('as of 2026-09-10 (today), no month has closed: nothing posts as an actual', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2026-09-10' }));
      expect(result.postedEntries).toHaveLength(0);
      expect(result.scheduleRows.every((r) => r.closed === false)).toBe(true);
      expect(result.scheduleRows.every((r) => r.postedEntryKey === null)).toBe(true);
    });

    it('once months have actually closed, exactly those months post as actuals', () => {
      // As of 2027-01-01: Sep, Oct, Nov, Dec 2026 have fully elapsed; Jan 2027
      // has not (asOf sits on its first day, not past its end).
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const closedMonths = new Set(
        result.scheduleRows.filter((r) => r.closed).map((r) => r.periodMonth),
      );
      expect([...closedMonths].sort()).toEqual(['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01']);
      // 42 units x 2 categories (IRP, HVUT) x 4 closed months.
      expect(result.postedEntries).toHaveLength(42 * 2 * 4);
      for (const row of result.scheduleRows) {
        expect(row.postedEntryKey === null).toBe(!row.closed);
      }
    });

    it('driver-borne HVUT is charged_to driver on both the schedule and the posted entry, never reducing company margin', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      // Unit 1564 is 'rented' / hvut_payer_CONFIRM=driver in the real crosswalk.
      const driverUnitHvutRows = result.scheduleRows.filter(
        (r) => r.unitNumber === '1564' && r.categoryId === 'tax.hvut',
      );
      expect(driverUnitHvutRows).toHaveLength(12);
      expect(driverUnitHvutRows.every((r) => r.chargedTo === 'driver')).toBe(true);

      const posted = result.postedEntries.filter((e) => e.unitNumber === '1564' && e.categoryId === 'tax.hvut');
      expect(posted.length).toBeGreaterThan(0);
      expect(posted.every((e) => e.chargedTo === 'driver')).toBe(true);
    });

    it('the 6 unresolved units are still booked in full, charged_to unknown, never defaulted to company', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      // Unit 1365 is UNRESOLVED in the real crosswalk.
      const rows = result.scheduleRows.filter((r) => r.unitNumber === '1365' && r.categoryId === 'tax.hvut');
      expect(rows).toHaveLength(12);
      expect(rows.every((r) => r.chargedTo === 'unknown')).toBe(true);
      const sum = sumCents(rows.map((r) => -centsFromDecimal(r.amount)));
      expect(decimalFromCents(sum)).toBe('550.00'); // the money is real and booked, not zeroed out
    });

    it('IRP is always charged_to company, regardless of HVUT driver/unknown attribution', () => {
      const result = buildRegistrationPosting(makeInput());
      expect(result.scheduleRows.filter((r) => r.categoryId === 'permit.irp').every((r) => r.chargedTo === 'company')).toBe(true);
      expect(result.prepaidEntries.every((e) => e.chargedTo === 'company')).toBe(true);
    });

    it('the payment posts once as prepaid (allocation_basis actual), not as an immediate expense', () => {
      const result = buildRegistrationPosting(makeInput());
      expect(result.prepaidEntries).toHaveLength(2);
      for (const entry of result.prepaidEntries) {
        expect(entry.categoryId).toBe('prepaid.registration');
        expect(entry.allocationBasis).toBe('actual');
        expect(entry.unitType).toBe('unknown'); // fleet-level, not attributable to one truck
        expect(entry.unitNumber).toBeNull();
      }
      const irpPrepaid = result.prepaidEntries.find((e) => e.key === 'irp-prepaid')!;
      const hvutPrepaid = result.prepaidEntries.find((e) => e.key === 'hvut-prepaid')!;
      expect(irpPrepaid.amount).toBe('-78959.21');
      expect(hvutPrepaid.amount).toBe('-23100.00');
    });

    it('every posted/schedule row that names a truck-type unit satisfies the DB unit_type constraint locally', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      for (const entry of result.postedEntries) {
        if (entry.unitType === 'truck') {
          expect(entry.truckId !== null || entry.unitNumber !== null).toBe(true);
        }
      }
    });

    it('resolves truckId from the VIN crosswalk when provided, and leaves it null otherwise', () => {
      const someVin = roster!.units[0]!.vin;
      const result = buildRegistrationPosting(
        makeInput({ truckByVin: { [someVin]: { truckId: 'truck-uuid-1' } }, asOf: '2027-01-01' }),
      );
      const resolvedRows = result.scheduleRows.filter((r) => r.vin === someVin);
      expect(resolvedRows.every((r) => r.truckId === 'truck-uuid-1')).toBe(true);
      const unresolvedRows = result.scheduleRows.filter((r) => r.vin !== someVin);
      expect(unresolvedRows.every((r) => r.truckId === null)).toBe(true);
    });

    it('throws if a unit has no row in the VIN crosswalk, rather than silently defaulting its HVUT payer', () => {
      const filteredStatuses = statuses.filter((s) => s.irpUnit !== '1365');
      const input = makeInput();
      const badInput: RegistrationPostingInput = { ...input, unitStatuses: filteredStatuses };
      expect(() => buildRegistrationPosting(badInput)).toThrow(/crosswalk/i);
    });

    it('every money field on every output is a wire-legal decimal string, never a float', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      for (const e of [...result.prepaidEntries, ...result.postedEntries]) {
        expect(isDecimal(e.amount)).toBe(true);
        expect(isIsoDate(e.accrualDate)).toBe(true);
      }
      for (const r of result.scheduleRows) {
        expect(isDecimal(r.amount)).toBe(true);
        expect(isIsoDate(r.periodMonth)).toBe(true);
      }
      expect(isDecimal(result.reconciliation.irpAllocatedTotal)).toBe(true);
      expect(isDecimal(result.reconciliation.hvutTotal)).toBe(true);
    });
  });
});

function groupRows(
  rows: AmortizationScheduleRowDraft[],
  categoryId: string,
): Map<string, AmortizationScheduleRowDraft[]> {
  const map = new Map<string, AmortizationScheduleRowDraft[]>();
  for (const r of rows) {
    if (r.categoryId !== categoryId) continue;
    const list = map.get(r.unitNumber) ?? [];
    list.push(r);
    map.set(r.unitNumber, list);
  }
  return map;
}

function makeRegInput(
  roster: RegistrationPostingInput['roster'],
  statuses: RegistrationPostingInput['unitStatuses'],
  overrides: Partial<RegistrationPostingInput> = {},
): RegistrationPostingInput {
  return {
    roster,
    feeLines: REAL_FEE_LINES,
    invoiceTotal: REAL_INVOICE_TOTAL,
    hvutRatePerUnit: REAL_HVUT_RATE,
    unitStatuses: statuses,
    entityId: 'entity-zone-oh-test',
    truckByVin: {},
    irpSourceDocumentId: 'doc-irp-invoice-1',
    hvutSourceDocumentId: 'doc-hvut-2290-1',
    irpPaymentDate: '2026-09-09',
    hvutPaymentDate: '2026-09-09',
    postedBy: 'test-harness',
    asOf: '2026-09-10',
    ...overrides,
  };
}
