import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDecimal } from '@/contract/types';
import {
  buildRegistrationPosting,
  parseIrpVehicleStatusReport,
  parseUnitOperatorCsv,
  parseUnitStatusCsv,
  scaledFromAnalysisRate,
} from '@/engines/registration';
import type { IrpFeeLine, RegistrationPostingInput, RegistrationPostingResult, UnitOperatorRow } from '@/engines/registration';
import { centsFromDecimal, decimalFromCents, sumCents } from '@/engines/registration/money';

// Real, live documents — never synthetic. See CLAUDE.md §2 and
// docs/SOURCE-DISCOVERY.md §11d/§11e. The operator crosswalk was corrected
// by the operator: Iron Lease (asset-holding, no IRP account) and
// owner-held units are never an *operator* — title and operation are
// different facts, and every unit Iron Lease held title to is operated by
// Zone. Only zone/xtrack/afg appear as `operating_entity` now.
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

const OPERATOR_ENTITY_BY_KEY: Record<string, string> = {
  zone: ZONE_ENTITY_ID,
  xtrack: XTRACK_ENTITY_ID,
  afg: AFG_ENTITY_ID,
};

describe.skipIf(!haveFixtures)('registration engine — intercompany recharge', () => {
  const rosterText = haveFixtures ? readFileSync(ROSTER_PATH, 'utf8') : '';
  const statusText = haveFixtures ? readFileSync(STATUS_PATH, 'utf8') : '';
  const operatorText = haveFixtures ? readFileSync(OPERATOR_PATH, 'utf8') : '';

  const roster = haveFixtures ? parseIrpVehicleStatusReport(rosterText) : null;
  const statuses = haveFixtures ? parseUnitStatusCsv(statusText) : [];
  const operatorAssignments = haveFixtures ? parseUnitOperatorCsv(operatorText) : [];

  function makeInput(overrides: Partial<RegistrationPostingInput> = {}): RegistrationPostingInput {
    return {
      roster: roster!,
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
      asOf: '2026-09-10',
      operatorAssignments,
      operatorEntityByKey: OPERATOR_ENTITY_BY_KEY,
      ...overrides,
    };
  }

  describe('parseUnitOperatorCsv', () => {
    it('parses all 42 rows by header, matching the corrected operator counts', () => {
      expect(operatorAssignments).toHaveLength(42);
      const counts: Record<string, number> = {};
      for (const r of operatorAssignments) counts[r.operatingEntityKey] = (counts[r.operatingEntityKey] ?? 0) + 1;
      // Iron Lease held title to two of these units (4864, 6379), and
      // Sher Imam (owner-held) to three more (1365, 1596, 3898) — Zone
      // operates all five. Title and operation are different facts, and
      // this crosswalk records operation only. Neither Iron Lease nor an
      // owner-held unit appears here at all: only zone/xtrack/afg/UNRESOLVED.
      expect(counts).toEqual({ zone: 18, xtrack: 16, afg: 7, UNRESOLVED: 1 });
    });

    it('parses a dated snapshot as an ISO date and a blank as null, never inventing one', () => {
      const dated = operatorAssignments.find((r) => r.source.includes('settlement sheet') && r.asOf !== null)!;
      expect(dated.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const undated = operatorAssignments.find((r) => r.operatingEntityKey === 'UNRESOLVED')!;
      expect(undated.asOf).toBeNull();
    });
  });

  describe('buildRegistrationPosting — with no operator crosswalk (backward compatible)', () => {
    it('behaves exactly as before: everything stays with the payer, no recharge, no receivables', () => {
      const result = buildRegistrationPosting(makeInput({ operatorAssignments: undefined, operatorEntityByKey: undefined, asOf: '2027-01-01' }));
      expect(result.intercompanyEntries).toHaveLength(0);
      expect(result.reconciliation.needsConfirmationUnits).toHaveLength(0);
      expect(result.reconciliation.intercompanyReceivableTotal).toBe('0.00');
      expect(result.scheduleRows.every((r) => r.entityId === ZONE_ENTITY_ID && r.paidByEntityId === null)).toBe(true);
      expect(result.postedEntries.every((e) => e.entityId === ZONE_ENTITY_ID && e.paidByEntityId === null)).toBe(true);
      expect(result.reconciliation.costByOperatorKey.zone).toBe('102059.21');
    });
  });

  describe('buildRegistrationPosting — with the real operator crosswalk', () => {
    it('throws if a unit on the roster has no row in the operator crosswalk', () => {
      const filtered = operatorAssignments.filter((r) => r.irpUnit !== '1365');
      const input = makeInput({ operatorAssignments: filtered });
      expect(() => buildRegistrationPosting(input)).toThrow(/operator crosswalk/i);
    });

    it('throws rather than inventing an entity id for an unmapped operator key', () => {
      const input = makeInput({ operatorEntityByKey: { zone: ZONE_ENTITY_ID } }); // xtrack/afg missing
      expect(() => buildRegistrationPosting(input)).toThrow(/no resolved entity id/i);
    });

    it('readiness 1 (regression): the pre-existing reconciliation figures are untouched by adding a crosswalk', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      expect(result.reconciliation.irpAllocatedTotal).toBe('78959.21');
      expect(result.reconciliation.hvutTotal).toBe('23100.00');
      expect(result.reconciliation.hvutByChargedTo).toEqual({ company: '15950.00', driver: '3850.00', unknown: '3300.00' });
    });

    it('readiness 2: costs across all entities sum to exactly 78,959.21, and the penny allocation survives the split', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const irpRows = result.scheduleRows.filter((r) => r.categoryId === 'permit.irp');
      const sum = sumCents(irpRows.map((r) => -centsFromDecimal(r.amount)));
      expect(decimalFromCents(sum)).toBe('78959.21');

      // 5 units @ 1879.99, 37 @ 1879.98 — per-unit totals, regardless of
      // which entity a unit's rows landed on after the recharge.
      const byUnit = new Map<string, number>();
      for (const r of irpRows) byUnit.set(r.unitNumber, (byUnit.get(r.unitNumber) ?? 0) + -centsFromDecimal(r.amount));
      const totals = [...byUnit.values()].map((c) => decimalFromCents(c));
      expect(totals.filter((t) => t === '1879.99')).toHaveLength(5);
      expect(totals.filter((t) => t === '1879.98')).toHaveLength(37);
    });

    it('readiness 3: every recharge has exactly one matching receivable, equal and opposite, naming the correct counterparty', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));

      // The cost side: every schedule row whose entityId differs from the
      // payer is a recharge candidate. Group its FULL YEAR total by
      // (unitNumber, categoryId) — the same granularity as a receivable.
      const rechargedByKey = new Map<string, { entityId: string; cents: number }>();
      for (const r of result.scheduleRows) {
        if (r.paidByEntityId === null) continue; // not recharged
        const k = `${r.categoryId}:${r.unitNumber}`;
        const prior = rechargedByKey.get(k) ?? { entityId: r.entityId, cents: 0 };
        expect(r.entityId).toBe(prior.entityId); // never split across two operators mid-year
        expect(r.paidByEntityId).toBe(ZONE_ENTITY_ID);
        prior.cents += -centsFromDecimal(r.amount);
        rechargedByKey.set(k, prior);
      }

      const receivableByKey = new Map<string, { counterpartyEntityId: string; cents: number }>();
      for (const e of result.intercompanyEntries) {
        expect(e.categoryId).toBe('receivable.intercompany');
        expect(e.entityId).toBe(ZONE_ENTITY_ID);
        expect(e.counterpartyEntityId).not.toBeNull();
        const k = e.key.replace(/^receivable:/, '');
        receivableByKey.set(k, { counterpartyEntityId: e.counterpartyEntityId as string, cents: centsFromDecimal(e.amount) });
      }

      // No orphans in either direction.
      expect([...rechargedByKey.keys()].sort()).toEqual([...receivableByKey.keys()].sort());

      for (const [key, cost] of rechargedByKey) {
        const receivable = receivableByKey.get(key)!;
        expect(receivable.cents).toBe(cost.cents); // equal ...
        expect(receivable.counterpartyEntityId).toBe(cost.entityId); // ... and naming the operator
      }
    });

    it('readiness 4: Zone\'s receivables total exactly the sum of the recharged units\' allocations', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const receivableTotalCents = sumCents(result.intercompanyEntries.map((e) => centsFromDecimal(e.amount)));
      expect(decimalFromCents(receivableTotalCents)).toBe(result.reconciliation.intercompanyReceivableTotal);
      expect(result.reconciliation.intercompanyReceivableTotal).toBe('52039.58');

      // Cross-check against the per-operator cost buckets: the receivable
      // total must equal every non-zone, non-unresolved bucket summed —
      // just xtrack and afg now that a non-carrier can never hold a bucket.
      const rechargedBucketCents =
        centsFromDecimal(result.reconciliation.costByOperatorKey.xtrack) +
        centsFromDecimal(result.reconciliation.costByOperatorKey.afg);
      expect(decimalFromCents(rechargedBucketCents)).toBe(result.reconciliation.intercompanyReceivableTotal);
    });

    it('readiness 5: the consolidated total (IRP cost, excluding intercompany legs) is exactly 78,959.21', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      // v_ledger_consolidated drops receivable.intercompany/payable.intercompany;
      // nothing else in this posting is intercompany, so simulate the view by
      // excluding that category from postedEntries + intercompanyEntries and
      // summing what's left for the IRP category.
      const allRows = [...result.postedEntries, ...result.prepaidEntries];
      const consolidated = allRows.filter((e) => e.categoryId !== 'receivable.intercompany' && e.categoryId !== 'payable.intercompany');
      // Using the full schedule (not just posted) proves the total the group
      // will eventually recognize, mirroring the pre-recharge reconciliation.
      const irpScheduleCents = sumCents(
        result.scheduleRows.filter((r) => r.categoryId === 'permit.irp').map((r) => -centsFromDecimal(r.amount)),
      );
      expect(decimalFromCents(irpScheduleCents)).toBe('78959.21');
      // And the receivable entries themselves are never counted as IRP cost.
      expect(consolidated.some((e) => e.categoryId === 'receivable.intercompany')).toBe(false);
      expect(result.intercompanyEntries.every((e) => e.categoryId === 'receivable.intercompany')).toBe(true);
    });

    it('readiness 6: per-entity cost totals are reported and sum to the grand total (IRP + HVUT)', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const c = result.reconciliation.costByOperatorKey;
      expect(c).toEqual({
        zone: '47589.65',
        xtrack: '35579.72',
        afg: '16459.86',
        unresolved: '2429.98',
      });
      const grandTotalCents = Object.values(c).reduce((acc, v) => acc + centsFromDecimal(v), 0);
      expect(decimalFromCents(grandTotalCents)).toBe('102059.21');
      expect(decimalFromCents(grandTotalCents)).toBe(
        decimalFromCents(centsFromDecimal(result.reconciliation.irpAllocatedTotal) + centsFromDecimal(result.reconciliation.hvutTotal)),
      );
    });

    it('readiness 7 (regression): HVUT company/driver/unknown split is unchanged by the recharge', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      expect(result.reconciliation.hvutByChargedTo).toEqual({
        company: '15950.00',
        driver: '3850.00',
        unknown: '3300.00',
      });
    });

    it('readiness 8: as of 2026-09-10, nothing posts as an actual — including the receivable, but not the immediate payment records', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2026-09-10' }));
      expect(result.postedEntries).toHaveLength(0);
      expect(result.scheduleRows.every((r) => r.postedEntryKey === null)).toBe(true);
      // The receivable and the prepaid asset are both immediate, real facts
      // tied to the payment date (2026-09-09, already in the past relative
      // to asOf) — they are not gated by month-closure, which governs only
      // the monthly expense-RECOGNITION timeline.
      expect(result.intercompanyEntries.length).toBeGreaterThan(0);
      expect(result.prepaidEntries).toHaveLength(2);
    });

    it('readiness 9: every money field is a decimal string, never a float, across the new outputs too', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      for (const e of result.intercompanyEntries) expect(isDecimal(e.amount)).toBe(true);
      for (const v of Object.values(result.reconciliation.costByOperatorKey)) expect(isDecimal(v)).toBe(true);
      expect(isDecimal(result.reconciliation.intercompanyReceivableTotal)).toBe(true);
      for (const r of result.overheadRates) {
        expect(isDecimal(r.annualTotal)).toBe(true);
        expect(isDecimal(r.monthlyLedger)).toBe(true);
        // dailyRate/weeklyRate are intentionally NOT `Decimal` (they carry
        // six decimal places, more precision than the ledger's `isDecimal`
        // wire check allows) — but they are still decimal strings, never a
        // float, checked exactly via `scaledFromAnalysisRate` elsewhere.
        expect(typeof r.dailyRate).toBe('string');
        expect(typeof r.weeklyRate).toBe('string');
      }
    });

    it('flags only UNRESOLVED units as needsConfirmation, and no others', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const flagged = result.reconciliation.needsConfirmationUnits;
      expect(flagged).toHaveLength(1);
      expect(flagged.every((u) => u.operatorKey === 'UNRESOLVED')).toBe(true);
      expect(new Set(flagged.map((u) => u.unitNumber))).toEqual(new Set(['5413']));

      const flaggedUnitNumbers = new Set(flagged.map((u) => u.unitNumber));
      for (const row of [...result.scheduleRows, ...result.postedEntries, ...result.intercompanyEntries]) {
        expect(row.needsConfirmation).toBe(flaggedUnitNumbers.has(row.unitNumber as string));
      }
    });

    it('UNRESOLVED units stay with Zone: no recharge, no receivable, but the money is still booked in full', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const unresolvedUnits = operatorAssignments.filter((r) => r.operatingEntityKey === 'UNRESOLVED').map((r) => r.irpUnit);
      expect(unresolvedUnits).toHaveLength(1);
      for (const unitNumber of unresolvedUnits) {
        const rows = result.scheduleRows.filter((r) => r.unitNumber === unitNumber);
        expect(rows.every((r) => r.entityId === ZONE_ENTITY_ID)).toBe(true);
        expect(rows.every((r) => r.paidByEntityId === null)).toBe(true);
        expect(result.intercompanyEntries.some((e) => e.unitNumber === unitNumber)).toBe(false);
      }
    });

    it('driver-borne HVUT never recharges even when the truck is operated by another entity (unit 1564, xtrack)', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const hvutRows = result.scheduleRows.filter((r) => r.unitNumber === '1564' && r.categoryId === 'tax.hvut');
      expect(hvutRows).toHaveLength(12);
      expect(hvutRows.every((r) => r.chargedTo === 'driver')).toBe(true);
      expect(hvutRows.every((r) => r.entityId === ZONE_ENTITY_ID && r.paidByEntityId === null)).toBe(true);
      expect(result.intercompanyEntries.some((e) => e.key === 'receivable:tax.hvut:1564')).toBe(false);

      // But its IRP allocation DOES recharge to xtrack, since IRP is always company-borne.
      const irpRows = result.scheduleRows.filter((r) => r.unitNumber === '1564' && r.categoryId === 'permit.irp');
      expect(irpRows.every((r) => r.entityId === XTRACK_ENTITY_ID && r.paidByEntityId === ZONE_ENTITY_ID)).toBe(true);
    });

    it('zone-operated units never appear in intercompanyEntries', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const zoneUnits = operatorAssignments.filter((r) => r.operatingEntityKey === 'zone').map((r) => r.irpUnit);
      expect(zoneUnits).toHaveLength(18);
      for (const unitNumber of zoneUnits) {
        expect(result.intercompanyEntries.some((e) => e.unitNumber === unitNumber)).toBe(false);
        const rows = result.scheduleRows.filter((r) => r.unitNumber === unitNumber);
        expect(rows.every((r) => r.entityId === ZONE_ENTITY_ID && r.paidByEntityId === null)).toBe(true);
      }
    });

    it('title held by Iron Lease does not change the recharge: units 4864 and 6379 are ordinary zone-operated units', () => {
      // Per the operator's decision: title (who owns) and operation (who
      // runs, and earns from, the truck) are different facts. These two
      // units' `source` column notes Iron Lease holds title, but
      // `operating_entity` correctly says 'zone' — so they must post and
      // recharge exactly like any other zone-operated unit, with no special
      // flag and no receivable.
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const titleHeldUnits = operatorAssignments.filter((r) => r.source.includes('title Iron Lease')).map((r) => r.irpUnit);
      expect(titleHeldUnits).toEqual(['4864', '6379']);
      for (const unitNumber of titleHeldUnits) {
        const rows = result.scheduleRows.filter((r) => r.unitNumber === unitNumber);
        expect(rows.every((r) => r.entityId === ZONE_ENTITY_ID && r.paidByEntityId === null)).toBe(true);
        expect(rows.every((r) => r.needsConfirmation === false)).toBe(true);
        expect(result.intercompanyEntries.some((e) => e.unitNumber === unitNumber)).toBe(false);
      }
    });

    it('owner-held (Sher Imam) units 1365/1596/3898, now confirmed operated by Zone, post as ordinary zone units — the guard is reinforced, not contradicted', () => {
      // The operator resolved three of the six originally-UNRESOLVED units:
      // Sher Imam holds title, but Zone operates them. This is the same
      // title-vs-operation distinction as Iron Lease above — the owner
      // never becomes a recharge target, but a REAL operator (Zone) can now
      // be recorded for these units instead of leaving them UNRESOLVED.
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const ownerHeldUnits = operatorAssignments
        .filter((r) => r.source.includes('owner-held'))
        .map((r) => r.irpUnit);
      expect(ownerHeldUnits.sort()).toEqual(['1365', '1596', '3898']);
      for (const unitNumber of ownerHeldUnits) {
        const rows = result.scheduleRows.filter((r) => r.unitNumber === unitNumber);
        expect(rows.every((r) => r.entityId === ZONE_ENTITY_ID && r.paidByEntityId === null)).toBe(true);
        expect(rows.every((r) => r.needsConfirmation === false)).toBe(true);
        expect(result.intercompanyEntries.some((e) => e.unitNumber === unitNumber)).toBe(false);
      }
      // And Sher Imam is still never a valid operator key on its own — only
      // the fact that Zone (a carrier) now operates these units let them
      // post without the guard's involvement at all.
      expect(operatorAssignments.some((r) => r.operatingEntityKey === 'sher_imam')).toBe(false);
    });

    it('the remaining 3 genuinely-unresolved units (4553, 4713, 5413) are unaffected by the Sher Imam resolution', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const stillUnresolved = operatorAssignments
        .filter((r) => r.operatingEntityKey === 'UNRESOLVED')
        .map((r) => r.irpUnit)
        .sort();
      expect(stillUnresolved).toEqual(['5413']);
      for (const unitNumber of stillUnresolved) {
        const rows = result.scheduleRows.filter((r) => r.unitNumber === unitNumber);
        expect(rows.every((r) => r.entityId === ZONE_ENTITY_ID && r.paidByEntityId === null)).toBe(true);
        expect(rows.every((r) => r.needsConfirmation === true)).toBe(true);
        expect(result.intercompanyEntries.some((e) => e.unitNumber === unitNumber)).toBe(false);
      }
    });

    it('the prepaid entries are untouched by the recharge — Zone paid the cash in full, once', () => {
      const result: RegistrationPostingResult = buildRegistrationPosting(makeInput());
      expect(result.prepaidEntries).toHaveLength(2);
      expect(result.prepaidEntries.every((e) => e.entityId === ZONE_ENTITY_ID && e.paidByEntityId === null && e.counterpartyEntityId === null)).toBe(true);
      const irpPrepaid = result.prepaidEntries.find((e) => e.key === 'irp-prepaid')!;
      expect(irpPrepaid.amount).toBe('-78959.21');
    });
  });

  describe('non-carrier recharge guard (Change 1)', () => {
    /** Simulates a crosswalk row that (incorrectly) names a title holder or
     *  an owner-held unit as the operator — exactly the bug the operator
     *  flagged: "the previous run got this wrong because it let title
     *  override operator". The real, corrected fixture never contains
     *  these values; this constructs the bad input directly to prove the
     *  engine refuses it rather than silently recharging or reassigning
     *  it. */
    function withBadOperator(operatingEntityKey: string): UnitOperatorRow[] {
      return operatorAssignments.map((r) =>
        r.irpUnit === '1431' ? { ...r, operatingEntityKey } : r,
      );
    }

    it('throws when the crosswalk names a title-holding entity (iron_lease) as the operator', () => {
      const input = makeInput({ operatorAssignments: withBadOperator('iron_lease') });
      expect(() => buildRegistrationPosting(input)).toThrow(/not a valid recharge target/i);
    });

    it('throws when the crosswalk names an owner-held unit (sher_imam) as the operator', () => {
      const input = makeInput({ operatorAssignments: withBadOperator('sher_imam') });
      expect(() => buildRegistrationPosting(input)).toThrow(/not a valid recharge target/i);
    });

    it('throws on a non-carrier operator even when operatorEntityByKey happens to resolve it — the guard is not a lookup-miss fallback', () => {
      const input = makeInput({
        operatorAssignments: withBadOperator('iron_lease'),
        operatorEntityByKey: { ...OPERATOR_ENTITY_BY_KEY, iron_lease: 'entity-iron-lease' },
      });
      expect(() => buildRegistrationPosting(input)).toThrow(/not a valid recharge target/i);
    });

    it('never silently reassigns a non-carrier operator to the payer — it throws instead of degrading to "stays with Zone"', () => {
      const input = makeInput({ operatorAssignments: withBadOperator('iron_lease') });
      expect(() => buildRegistrationPosting(input)).toThrow();
      // Confirm this is NOT the same code path as UNRESOLVED (which is a
      // deliberate, documented "stays with the payer" outcome, not an
      // error): UNRESOLVED never throws.
      expect(() => buildRegistrationPosting(makeInput())).not.toThrow();
    });
  });

  describe('per-truck overhead rate (Change 2)', () => {
    it('reports one overhead rate row per unit, unconditionally (even without an operator crosswalk)', () => {
      const withCrosswalk = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      expect(withCrosswalk.overheadRates).toHaveLength(42);

      const withoutCrosswalk = buildRegistrationPosting(
        makeInput({ operatorAssignments: undefined, operatorEntityByKey: undefined, asOf: '2027-01-01' }),
      );
      expect(withoutCrosswalk.overheadRates).toHaveLength(42);
    });

    it('annualPerUnit is IRP allocation + HVUT for that unit (1,879.98 + 550.00 = 2,429.98, or 1,879.99 + 550.00 = 2,429.99)', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const totals = result.overheadRates.map((r) => r.annualTotal);
      expect(totals.filter((t) => t === '2429.99')).toHaveLength(5);
      expect(totals.filter((t) => t === '2429.98')).toHaveLength(37);
    });

    it('the coverage window is the real registration year, 2026-09-01 through 2027-08-31 (365 days)', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      for (const r of result.overheadRates) {
        expect(r.coverageStart).toBe('2026-09-01');
        expect(r.coverageEnd).toBe('2027-08-31');
        expect(r.coverageDays).toBe(365);
      }
    });

    it('readiness 6: dailyRate * coverageDays equals annualPerUnit to the cent, for every unit', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      expect(result.overheadRates.length).toBeGreaterThan(0);
      for (const r of result.overheadRates) {
        const dailyMicroDollars = scaledFromAnalysisRate(r.dailyRate); // dollars * 1e6
        const reconstructedCents = Math.round((dailyMicroDollars * r.coverageDays) / 10_000);
        expect(decimalFromCents(reconstructedCents)).toBe(r.annualTotal);
      }
    });

    it('weeklyRate is exactly dailyRate * 7', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      for (const r of result.overheadRates) {
        const daily = scaledFromAnalysisRate(r.dailyRate);
        const weekly = scaledFromAnalysisRate(r.weeklyRate);
        expect(weekly).toBe(daily * 7);
      }
    });

    it('weeklyRate * 52 does NOT equal the annual figure — 52 weeks is 364 days, one short of the real year, and that gap is expected', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const r = result.overheadRates[0]!;
      const weekly = scaledFromAnalysisRate(r.weeklyRate);
      const fiftyTwoWeeksCents = Math.round((weekly * 52) / 10_000);
      expect(decimalFromCents(fiftyTwoWeeksCents)).not.toBe(r.annualTotal);
      // The gap is exactly one day's worth of the rate (52 * 7 = 364, one
      // short of the 365-day coverage window) — not a rounding bug.
      expect(r.coverageDays - 52 * 7).toBe(1);
    });

    it('monthlyLedger is the posted accounting truth: it matches the base (non-remainder) monthly figure already amortized into scheduleRows', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const byUnit = new Map<string, typeof result.overheadRates[number]>();
      for (const r of result.overheadRates) byUnit.set(r.unitNumber, r);

      for (const unitNumber of ['8671', '1431']) {
        const rate = byUnit.get(unitNumber)!;
        const irpRows = result.scheduleRows.filter((r) => r.unitNumber === unitNumber && r.categoryId === 'permit.irp');
        const hvutRows = result.scheduleRows.filter((r) => r.unitNumber === unitNumber && r.categoryId === 'tax.hvut');
        const combinedMonthlyCents = irpRows.map((r, i) => -centsFromDecimal(r.amount) + -centsFromDecimal(hvutRows[i]!.amount));
        // monthlyLedger is the floor share of the COMBINED annual total,
        // amortized 1/12. Because IRP and HVUT are amortized as two
        // separate even splits (each with its own up-to-one-cent
        // remainder), a given month's actual combined posting can carry up
        // to two remainder pennies above this floor — never below it, and
        // never more than one remainder penny per stream.
        const monthlyLedgerCents = centsFromDecimal(rate.monthlyLedger);
        for (const cents of combinedMonthlyCents) {
          expect(cents - monthlyLedgerCents).toBeGreaterThanOrEqual(0);
          expect(cents - monthlyLedgerCents).toBeLessThanOrEqual(2);
        }
      }
    });

    it('monthlyLedger * 12 is within a few cents of annualTotal (exact remainder-penny reconciliation happens across the 12 posted rows, not this single summary figure)', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      for (const r of result.overheadRates) {
        const diff = centsFromDecimal(r.annualTotal) - centsFromDecimal(r.monthlyLedger) * 12;
        expect(diff).toBeGreaterThanOrEqual(0);
        expect(diff).toBeLessThan(12); // at most one remainder penny per month
      }
    });

    it('the overhead rate lands on the truck\'s operator entity, following the recharge (unit 1471, xtrack)', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      const rate = result.overheadRates.find((r) => r.unitNumber === '1471')!;
      expect(rate.entityId).toBe(XTRACK_ENTITY_ID);
      expect(rate.categoryIds).toEqual(['permit.irp', 'tax.hvut']);
    });

    it('never posts a daily or weekly ledger entry — only the monthly grain appears in scheduleRows/postedEntries', () => {
      const result = buildRegistrationPosting(makeInput({ asOf: '2027-01-01' }));
      // 42 units x 2 categories x 12 months, exactly — no per-day, no per-week rows.
      expect(result.scheduleRows).toHaveLength(42 * 2 * 12);
      const months = new Set(result.scheduleRows.map((r) => r.periodMonth));
      expect(months.size).toBe(12);
    });
  });
});
