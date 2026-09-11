import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CategoryGroup } from '@/contract/types';
import {
  buildRegistrationPosting,
  centsFromDecimal,
  decimalFromCents,
  parseIrpVehicleStatusReport,
  parseUnitStatusCsv,
  sumCents,
} from '@/engines/registration';
import type { IrpFeeLine, LedgerEntryDraft, RegistrationPostingInput } from '@/engines/registration';
import { summarizeTruck } from '@/engines/summary';
import type { SummaryLedgerEntry } from '@/engines/summary';

/**
 * Real, live document (CLAUDE.md §2): the same IRP/HVUT transaction as
 * registration.test.ts, but this file's whole point is readiness criterion
 * 2 — "a driver-borne cost is proven absent from company margin and present
 * as a receivable" — proven against a real unit whose HVUT the real
 * unit-status crosswalk resolves to `chargedTo: 'driver'`.
 */
const ROSTER_PATH = '/home/user/opsdash-fixtures/irp_invoice_units.txt';
const STATUS_PATH = '/home/user/opsdash-fixtures/irp_unit_status.csv';
const haveFixtures = existsSync(ROSTER_PATH) && existsSync(STATUS_PATH);

const REAL_FEE_LINES: IrpFeeLine[] = [
  { description: 'Registration Fee', categoryId: 'permit.irp', amount: '4067.28' },
  { description: 'Foreign Jurisdiction Fees', categoryId: 'permit.irp_foreign', amount: '74554.18' },
  { description: 'BMV Fee', categoryId: 'permit.bmv', amount: '336.00' },
  { description: 'Postage Fee', categoryId: 'permit.bmv', amount: '1.75' },
];
const REAL_INVOICE_TOTAL = '78959.21';
const REAL_HVUT_RATE = '550.00';
const ZONE_ENTITY_ID = 'entity-zone-oh';

const CATEGORY_GROUP_BY_ID: Record<string, CategoryGroup> = {
  'permit.irp': 'permit',
  'permit.irp_foreign': 'permit',
  'permit.bmv': 'permit',
  'tax.hvut': 'permit',
  'prepaid.registration': 'other_cost',
  'receivable.intercompany': 'other_cost',
};

function toSummaryEntry(draft: LedgerEntryDraft): SummaryLedgerEntry {
  const categoryGroup = CATEGORY_GROUP_BY_ID[draft.categoryId];
  if (!categoryGroup) throw new Error(`test adapter has no categoryGroup mapping for ${draft.categoryId}`);
  return {
    entryId: draft.key,
    entityId: draft.entityId,
    truckId: draft.truckId,
    accrualDate: draft.accrualDate,
    categoryId: draft.categoryId,
    categoryGroup,
    amount: draft.amount,
    chargedTo: draft.chargedTo,
    allocationBasis: draft.allocationBasis,
    unitType: draft.unitType,
    unitNumber: draft.unitNumber,
    paidByEntityId: draft.paidByEntityId,
    counterpartyEntityId: draft.counterpartyEntityId,
  };
}

describe.skipIf(!haveFixtures)('summary engine — real driver-borne HVUT (readiness criterion 2)', () => {
  const roster = parseIrpVehicleStatusReport(readFileSync(ROSTER_PATH, 'utf8'));
  const statuses = parseUnitStatusCsv(readFileSync(STATUS_PATH, 'utf8'));

  const input: RegistrationPostingInput = {
    roster,
    feeLines: REAL_FEE_LINES,
    invoiceTotal: REAL_INVOICE_TOTAL,
    hvutRatePerUnit: REAL_HVUT_RATE,
    unitStatuses: statuses,
    entityId: ZONE_ENTITY_ID,
    truckByVin: {},
    irpSourceDocumentId: 'doc-irp-invoice-1',
    hvutSourceDocumentId: 'doc-hvut-2290-1',
    irpPaymentDate: '2026-09-09',
    hvutPaymentDate: '2026-09-09',
    postedBy: 'test-harness',
    // Every month of the registration year (2026-09..2027-08) is closed by
    // this date, so all 12 months' worth of HVUT for every unit posted.
    asOf: '2027-09-01',
  };

  const result = buildRegistrationPosting(input);

  it('sanity: at least one real unit\'s HVUT is driver-borne per the real crosswalk', () => {
    expect(result.reconciliation.hvutUnitCountByChargedTo.driver).toBeGreaterThan(0);
    expect(result.reconciliation.hvutByChargedTo.driver).toBe('3850.00'); // 7 units x $550
  });

  it("a driver-borne unit's HVUT never reduces that truck's company margin, and shows up as a receivable instead", () => {
    // Any unit whose HVUT is driver-borne: pick the first one the real
    // crosswalk resolves that way.
    const driverBorneUnit = roster.units.find((u) => {
      const row = statuses.find((s) => s.vin === u.vin);
      return row?.hvutPayer === 'driver';
    });
    expect(driverBorneUnit).toBeDefined();
    const unitNumber = driverBorneUnit!.unitNumber;
    const truckId = `truck-${unitNumber}`;

    // Attach a truckId to this unit's own postedEntries only, mirroring
    // what a real VIN->truck resolution (source_key_map) would do; every
    // other unit stays truckId: null so it never pollutes this one truck's
    // per-truck result.
    const drafts: LedgerEntryDraft[] = result.postedEntries.map((e) =>
      e.unitNumber === unitNumber ? { ...e, truckId } : e,
    );
    const entries = drafts.map(toSummaryEntry);

    const truckResult = summarizeTruck(entries, truckId, { periodStart: '2026-01-01', periodEnd: '2027-12-31' });

    // The truck's own HVUT rows, split by who bears them.
    const thisUnitHvut = result.postedEntries.filter((e) => e.unitNumber === unitNumber && e.categoryId === 'tax.hvut');
    expect(thisUnitHvut.length).toBeGreaterThan(0);
    expect(thisUnitHvut.every((e) => e.chargedTo === 'driver')).toBe(true);
    const hvutTotalCents = sumCents(thisUnitHvut.map((e) => centsFromDecimal(e.amount)));

    // The IRP rows for the same unit ARE company-borne (rule from
    // postRegistration.ts: IRP never recharges to a driver).
    const thisUnitIrp = result.postedEntries.filter((e) => e.unitNumber === unitNumber && e.categoryId === 'permit.irp');
    const irpTotalCents = sumCents(thisUnitIrp.map((e) => centsFromDecimal(e.amount)));

    // Company cost is ONLY the IRP portion — the driver-borne HVUT is
    // completely absent from it, not merely reduced.
    expect(centsFromDecimal(truckResult.companyCostTotal)).toBe(irpTotalCents);
    // And it shows up, in full, as a receivable from the driver — the
    // exact positive mirror of the (negative) HVUT cost rows.
    expect(centsFromDecimal(truckResult.driverBorneCostTotal)).toBe(-hvutTotalCents);
    expect(decimalFromCents(-hvutTotalCents)).toBe(truckResult.driverBorneCostTotal);
  });
});
