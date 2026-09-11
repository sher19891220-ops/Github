import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AccountNature, CategoryGroup } from '@/contract/types';
import {
  buildRegistrationPosting,
  centsFromDecimal,
  decimalFromCents,
  parseIrpVehicleStatusReport,
  parseUnitOperatorCsv,
  parseUnitStatusCsv,
  sumCents,
} from '@/engines/registration';
import type { IrpFeeLine, LedgerEntryDraft, RegistrationPostingInput } from '@/engines/registration';
import { summarizeGroup } from '@/engines/summary';
import type { SummaryLedgerEntry } from '@/engines/summary';

/**
 * Real, live documents — never synthetic (CLAUDE.md §2). Same fixtures and
 * scenario as `tests/unit/registration-recharge.test.ts`: a real 42-unit IRP
 * renewal billed to Zone, 24 of those units actually operated by Xtrack or
 * AFG per the settlement sheet (SOURCE-DISCOVERY §11d/§11e). This is the
 * exact intercompany-recharge shape readiness criterion 3 asks for — proven
 * here against the real invoice total ($78,959.21) and real HVUT split, not
 * a fabricated pair of numbers.
 */
const ROSTER_PATH = '/home/user/opsdash-fixtures/irp_invoice_units.txt';
const STATUS_PATH = '/home/user/opsdash-fixtures/irp_unit_status.csv';
const OPERATOR_PATH = '/home/user/opsdash-fixtures/irp_unit_operator.csv';
const haveFixtures = existsSync(ROSTER_PATH) && existsSync(STATUS_PATH) && existsSync(OPERATOR_PATH);

const REAL_FEE_LINES: IrpFeeLine[] = [
  { description: 'Registration Fee', categoryId: 'permit.irp', amount: '4067.28' },
  { description: 'Foreign Jurisdiction Fees', categoryId: 'permit.irp_foreign', amount: '74554.18' },
  { description: 'BMV Fee', categoryId: 'permit.bmv', amount: '336.00' },
  { description: 'Postage Fee', categoryId: 'permit.bmv', amount: '1.75' },
];
const REAL_INVOICE_TOTAL = '78959.21';
const REAL_HVUT_RATE = '550.00';

const ZONE_ENTITY_ID = 'entity-zone-oh';
const XTRACK_ENTITY_ID = 'entity-xtrack';
const AFG_ENTITY_ID = 'entity-afg';
const ALL_ENTITY_IDS = [ZONE_ENTITY_ID, XTRACK_ENTITY_ID, AFG_ENTITY_ID];

const OPERATOR_ENTITY_BY_KEY: Record<string, string> = {
  zone: ZONE_ENTITY_ID,
  xtrack: XTRACK_ENTITY_ID,
  afg: AFG_ENTITY_ID,
};

/** Test-only adapter: the registration engine's pre-insert draft shape ->
 *  this engine's input shape. `categoryGroup` is resolved here exactly the
 *  way a real caller would join `accounting.category` — migration 003/004
 *  seed these three category groups verbatim. */
const CATEGORY_GROUP_BY_ID: Record<string, CategoryGroup> = {
  'permit.irp': 'permit',
  'permit.irp_foreign': 'permit',
  'permit.bmv': 'permit',
  'tax.hvut': 'permit',
  'prepaid.registration': 'other_cost',
  'receivable.intercompany': 'other_cost',
  'payable.intercompany': 'other_cost',
};

/** Mirrors migration 009's `account_nature` seed, the same way
 *  `CATEGORY_GROUP_BY_ID` above mirrors the 003/004 category seed. A real
 *  caller reads both off the same `accounting.category` join. */
const ACCOUNT_NATURE_BY_ID: Record<string, AccountNature> = {
  'prepaid.registration': 'balance_sheet',
  'receivable.driver': 'balance_sheet',
  'receivable.intercompany': 'intercompany',
  'payable.intercompany': 'intercompany',
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
    accountNature: ACCOUNT_NATURE_BY_ID[draft.categoryId] ?? 'pnl',
    amount: draft.amount,
    chargedTo: draft.chargedTo,
    allocationBasis: draft.allocationBasis,
    unitType: draft.unitType,
    unitNumber: draft.unitNumber,
    paidByEntityId: draft.paidByEntityId,
    counterpartyEntityId: draft.counterpartyEntityId,
  };
}

describe.skipIf(!haveFixtures)('summary engine — real intercompany recharge (readiness criteria 1 & 3)', () => {
  const roster = parseIrpVehicleStatusReport(readFileSync(ROSTER_PATH, 'utf8'));
  const statuses = parseUnitStatusCsv(readFileSync(STATUS_PATH, 'utf8'));
  const operatorAssignments = parseUnitOperatorCsv(readFileSync(OPERATOR_PATH, 'utf8'));

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
    // Registration year is 2026-09..2027-08; this asOf closes exactly the
    // first 4 months (Sep-Dec 2026), leaving 8 months as open commitments —
    // reused for the closed-month proof in summary-closed-months.test.ts,
    // and it does not matter for THIS file's proof, which only needs
    // whatever actually posted.
    asOf: '2027-01-01',
    operatorAssignments,
    operatorEntityByKey: OPERATOR_ENTITY_BY_KEY,
  };

  const result = buildRegistrationPosting(input);
  // Real cost rows only — prepaid entries are a balance-sheet asset
  // (stripped by the engine itself) and are deliberately included here too,
  // to prove they really are excluded rather than merely absent from this
  // fixture.
  const allDrafts = [...result.postedEntries, ...result.intercompanyEntries, ...result.prepaidEntries];
  const entries = allDrafts.map(toSummaryEntry);

  it('sanity: the recharge actually produced intercompany receivables (24 of 42 units cross an entity)', () => {
    expect(result.intercompanyEntries.length).toBeGreaterThan(0);
    expect(result.reconciliation.intercompanyReceivableTotal).not.toBe('0.00');
  });

  it('readiness 3: group roll-up does not double-count the recharge — Zone\'s receivable never appears in the consolidated total', () => {
    const group = summarizeGroup(entries, ALL_ENTITY_IDS, { periodStart: '2026-01-01', periodEnd: '2027-12-31' });

    // The consolidated group's COMPANY cost equals the real registration
    // cost that actually posted AND is company-borne (postedEntries whose
    // chargedTo is 'company' — driver-borne and unresolved HVUT rows are
    // real posted entries too, but rule 1 keeps them out of company cost
    // regardless of which entity they landed on).
    const realCompanyPostedCostCents = sumCents(
      result.postedEntries.filter((e) => e.chargedTo === 'company').map((e) => centsFromDecimal(e.amount)),
    );
    expect(centsFromDecimal(group.companyCostTotal)).toBe(realCompanyPostedCostCents);

    // And the receivable leg is genuinely gone from the consolidated view,
    // not merely netted to a coincidental zero: the group's `other_cost`
    // bucket (where receivable.intercompany would land) is empty, because
    // the only 'other_cost' rows here (prepaid, receivable) are either
    // balance-sheet-stripped or intercompany-stripped.
    expect(group.companyCostByCategoryGroup.find((c) => c.categoryGroup === 'other_cost')).toBeUndefined();
  });

  it('readiness 1: sum(per-entity results) === group result + eliminated intercompany, to the cent', () => {
    const period = { periodStart: '2026-01-01', periodEnd: '2027-12-31' };
    const group = summarizeGroup(entries, ALL_ENTITY_IDS, period);

    const sumOfEntitiesMarginCents = sumCents(group.entities.map((e) => centsFromDecimal(e.margin)));
    const groupMarginCents = centsFromDecimal(group.margin);
    const eliminatedCents = centsFromDecimal(group.eliminatedIntercompany);

    expect(sumOfEntitiesMarginCents).toBe(groupMarginCents + eliminatedCents);

    // Concretely: Zone's own (base-row) view holds the receivable and
    // therefore shows a margin inflated by exactly that receivable amount
    // relative to its "real" operating picture.
    const zone = group.entities.find((e) => e.entityId === ZONE_ENTITY_ID)!;
    expect(centsFromDecimal(zone.intercompanyNet)).toBe(centsFromDecimal(result.reconciliation.intercompanyReceivableTotal));
    expect(eliminatedCents).toBe(centsFromDecimal(result.reconciliation.intercompanyReceivableTotal));
  });

  it('the prepaid invoice payment (a balance-sheet asset) is excluded from every entity and the group, not just netted away', () => {
    const period = { periodStart: '2026-01-01', periodEnd: '2027-12-31' };
    const group = summarizeGroup(entries, ALL_ENTITY_IDS, period);
    const prepaidTotalCents = sumCents(result.prepaidEntries.map((e) => centsFromDecimal(e.amount)));

    expect(decimalFromCents(-prepaidTotalCents)).not.toBe('0.00'); // sanity: it's a real, large payment
    expect(centsFromDecimal(group.excludedBalanceSheetTotal)).toBe(-prepaidTotalCents);

    // Both prepaid rows (IRP + HVUT) were booked to Zone, the payer, with no
    // truck — so Zone's own base-row view carries the exact same exclusion.
    const zone = group.entities.find((e) => e.entityId === ZONE_ENTITY_ID)!;
    expect(centsFromDecimal(zone.excludedBalanceSheetTotal)).toBe(-prepaidTotalCents);
  });
});
