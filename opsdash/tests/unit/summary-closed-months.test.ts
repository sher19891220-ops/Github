import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CategoryGroup } from '@/contract/types';
import {
  buildRegistrationPosting,
  centsFromDecimal,
  parseIrpVehicleStatusReport,
  parseUnitStatusCsv,
  sumCents,
} from '@/engines/registration';
import type { IrpFeeLine, LedgerEntryDraft, RegistrationPostingInput } from '@/engines/registration';
import { summarizeTruck } from '@/engines/summary';
import type { SummaryLedgerEntry } from '@/engines/summary';

/**
 * Real, live document (CLAUDE.md §2): readiness criterion 4 — "an unposted
 * future month is proven absent from an actual" — proven end-to-end against
 * the real IRP registration year (2026-09..2027-08).
 *
 * The registration engine (`@/engines/registration`, not this engine's
 * file) is the thing that actually enforces "only closed months count as
 * actual": `buildRegistrationPosting`'s `postedEntries` contains a real
 * `ledger_entry`-shaped row ONLY for a month that has closed as of `asOf`;
 * every other month lives solely in `scheduleRows` with `postedEntryKey:
 * null`, and never becomes a row this engine could even accept (this
 * engine's input type has no field for a schedule row's `closed`/
 * `postedEntryKey` — an unposted commitment cannot be expressed as a
 * `SummaryLedgerEntry` at all, by construction). What THIS file proves is
 * the consequence for a P&L total: feeding only what actually posted
 * produces a total strictly smaller than the annual figure, and exactly
 * equal to the closed months' real sum — not a coincidence, not an
 * approximation.
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

function buildInput(asOf: string): RegistrationPostingInput {
  const roster = parseIrpVehicleStatusReport(readFileSync(ROSTER_PATH, 'utf8'));
  const statuses = parseUnitStatusCsv(readFileSync(STATUS_PATH, 'utf8'));
  return {
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
    asOf,
  };
}

const FULL_YEAR = { periodStart: '2026-01-01', periodEnd: '2027-12-31' };
const UNIT_NUMBER = '8671'; // present on the real roster (registration.test.ts asserts this)
const TRUCK_ID = `truck-${UNIT_NUMBER}`;

function summarizeUnitAsOf(asOf: string) {
  const result = buildRegistrationPosting(buildInput(asOf));
  const drafts: LedgerEntryDraft[] = result.postedEntries
    .filter((e) => e.unitNumber === UNIT_NUMBER)
    .map((e) => ({ ...e, truckId: TRUCK_ID }));
  const entries = drafts.map(toSummaryEntry);
  return { result, truckResult: summarizeTruck(entries, TRUCK_ID, FULL_YEAR) };
}

describe.skipIf(!haveFixtures)('summary engine — closed vs. unposted months (readiness criterion 4)', () => {
  it('with only 4 of 12 months closed, the schedule confirms 8 months are still commitments (not posted)', () => {
    const { result } = summarizeUnitAsOf('2027-01-01');
    const rowsForUnit = result.scheduleRows.filter((r) => r.unitNumber === UNIT_NUMBER);
    expect(rowsForUnit).toHaveLength(24); // 12 months x 2 streams (IRP, HVUT)
    const closed = rowsForUnit.filter((r) => r.closed);
    const open = rowsForUnit.filter((r) => !r.closed);
    expect(closed).toHaveLength(8); // 4 months x 2 streams
    expect(open).toHaveLength(16); // 8 months x 2 streams
    expect(open.every((r) => r.postedEntryKey === null)).toBe(true);
    expect(closed.every((r) => r.postedEntryKey !== null)).toBe(true);
  });

  it('a partial year of postings sums to strictly less than the full annual cost, by exactly the unposted commitments', () => {
    const partial = summarizeUnitAsOf('2027-01-01'); // 4 of 12 months closed
    const full = summarizeUnitAsOf('2027-09-01'); // all 12 months closed

    const partialCents = centsFromDecimal(partial.truckResult.companyCostTotal);
    const fullCents = centsFromDecimal(full.truckResult.companyCostTotal);
    expect(partialCents).not.toBe(fullCents);
    // company cost is negative; "strictly less annual cost" means strictly
    // smaller in magnitude, i.e. closer to zero.
    expect(Math.abs(partialCents)).toBeLessThan(Math.abs(fullCents));

    // And the gap is EXACTLY the amount still sitting in the unposted
    // schedule rows for this unit — no more, no less.
    const rowsForUnit = partial.result.scheduleRows.filter((r) => r.unitNumber === UNIT_NUMBER);
    const openCompanyCents = sumCents(
      rowsForUnit.filter((r) => !r.closed && r.chargedTo === 'company').map((r) => centsFromDecimal(r.amount)),
    );
    expect(fullCents - partialCents).toBe(openCompanyCents);
  });

  it('a fully unposted month contributes exactly zero to the actual — not a small residue, not an estimate', () => {
    // asOf right at the payment date: nothing has closed yet at all.
    const { result, truckResult } = summarizeUnitAsOf('2026-09-09');
    const rowsForUnit = result.scheduleRows.filter((r) => r.unitNumber === UNIT_NUMBER);
    expect(rowsForUnit.every((r) => !r.closed && r.postedEntryKey === null)).toBe(true);
    expect(result.postedEntries.filter((e) => e.unitNumber === UNIT_NUMBER)).toHaveLength(0);
    expect(truckResult.companyCostTotal).toBe('0.00');
    expect(truckResult.entryCount).toBe(0);
  });
});
