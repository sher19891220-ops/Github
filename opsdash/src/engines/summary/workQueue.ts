/**
 * The work-queue summary: counts (and dollar totals) of rows a human needs
 * to look at before the P&L that depends on them can be trusted at face
 * value. Every count here corresponds to a dollar amount excluded from
 * `companyCostTotal`/`driverBorneCostTotal` somewhere in `rollup.ts` — this
 * module exists so that exclusion is visible as a number, not just an
 * absence.
 */
import type { CategoryGroup } from '@/contract/types';
import { centsFromDecimal, decimalFromCents } from '@/engines/registration';
import { resolveBearing } from './bearing';
import { isPrincipalCategory } from './categoryRules';
import type { SummaryLedgerEntry, WorkQueueSummary } from './types';

/** Category groups where a cost row ordinarily names a specific unit —
 *  used only to decide whether a missing unit is worth flagging.
 *  `driver_pay`/`insurance`/`lease`/`other_cost` rows legitimately have no
 *  unit at all (a payroll run, a fleet insurance premium, an office
 *  expense), so `unitType: 'unknown'` there is not a defect. */
const UNIT_ATTRIBUTABLE_GROUPS: ReadonlySet<CategoryGroup> = new Set(['fuel', 'toll', 'maintenance', 'permit']);

function absCents(cents: number): number {
  return cents < 0 ? -cents : cents;
}

export function buildWorkQueueSummary(entries: readonly SummaryLedgerEntry[]): WorkQueueSummary {
  let chargebackCount = 0;
  let chargebackCents = 0;
  let unitCount = 0;
  let unitCents = 0;
  let validationCount = 0;
  let validationCents = 0;
  let principalCount = 0;
  let principalCents = 0;

  for (const e of entries) {
    const cents = centsFromDecimal(e.amount);

    if (isPrincipalCategory(e.categoryId)) {
      principalCount += 1;
      principalCents += absCents(cents);
    }

    const bearing = resolveBearing(e);
    if (bearing.needsHuman) {
      chargebackCount += 1;
      chargebackCents += absCents(cents);
    }

    if (
      e.unitType === 'unknown' &&
      e.truckId === null &&
      e.unitNumber === null &&
      UNIT_ATTRIBUTABLE_GROUPS.has(e.categoryGroup)
    ) {
      unitCount += 1;
      unitCents += absCents(cents);
    }

    if (e.failsValidation) {
      validationCount += 1;
      validationCents += absCents(cents);
    }
  }

  return {
    unresolvedChargebackCount: chargebackCount,
    unresolvedChargebackAmount: decimalFromCents(chargebackCents),
    unresolvedUnitTypeCount: unitCount,
    unresolvedUnitTypeAmount: decimalFromCents(unitCents),
    failingValidationCount: validationCount,
    failingValidationAmount: decimalFromCents(validationCents),
    excludedPrincipalCount: principalCount,
    excludedPrincipalAmount: decimalFromCents(principalCents),
  };
}
