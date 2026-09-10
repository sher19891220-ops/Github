/**
 * Pure posting logic for a real IRP renewal + HVUT filing. No I/O: takes the
 * parsed invoice, the parsed VIN crosswalk, and everything identity-resolved
 * externally, and returns the ledger/amortization rows to persist. See
 * docs/SOURCE-DISCOVERY.md §11b/§11c for the transaction this was built
 * against.
 */

import type { Decimal, IsoDate } from '@/contract/types';
import { centsFromDecimal, decimalFromCents, evenSplitCents, sumCents } from './money';
import { addMonths, isMonthClosed, monthRange, periodMonthOf } from './dates';
import type {
  AmortizationScheduleRowDraft,
  ChargedTo,
  HvutChargedToCounts,
  HvutChargedToTotals,
  IrpInvoiceUnit,
  LedgerEntryDraft,
  RegistrationPostingInput,
  RegistrationPostingResult,
  UnitStatusRow,
} from './types';

const COVERAGE_MONTHS = 12;
const IRP_CATEGORY = 'permit.irp';
const HVUT_CATEGORY = 'tax.hvut';
const PREPAID_CATEGORY = 'prepaid.registration';
const CURRENCY = 'USD';

/**
 * Every unit on this invoice must share one weight group, because an even
 * split across the fleet is only defensible for a uniform fleet (see
 * SOURCE-DISCOVERY §11c). A future invoice mixing weight groups must fail
 * loudly here rather than silently averaging away a real cost difference.
 */
function assertUniformWeightGroup(units: readonly IrpInvoiceUnit[]): number {
  const distinct = new Set(units.map((u) => u.weightGroup));
  if (distinct.size !== 1) {
    throw new Error(
      `Cannot allocate this invoice with an even split: units span ${distinct.size} weight groups ` +
        `(${[...distinct].sort((a, b) => a - b).join(', ')}). An even split is only defensible for a ` +
        `uniform fleet — allocate by weight class instead.`,
    );
  }
  return [...distinct][0] as number;
}

function assertFeeLinesReconcile(feeLines: readonly { amount: Decimal }[], invoiceTotal: Decimal): number {
  const feeLineTotalCents = sumCents(feeLines.map((f) => centsFromDecimal(f.amount)));
  const invoiceTotalCents = centsFromDecimal(invoiceTotal);
  if (feeLineTotalCents !== invoiceTotalCents) {
    throw new Error(
      `IRP fee lines sum to ${decimalFromCents(feeLineTotalCents)} but the invoice states ` +
        `${decimalFromCents(invoiceTotalCents)} — refusing to post an invoice that doesn't reconcile ` +
        `to the cent.`,
    );
  }
  return invoiceTotalCents;
}

function resolveHvutPayer(unit: IrpInvoiceUnit, statusByVin: Map<string, UnitStatusRow>): ChargedTo {
  const row = statusByVin.get(unit.vin);
  if (!row) {
    throw new Error(
      `Unit ${unit.unitNumber} (VIN ${unit.vin}) has no row in the unit-status crosswalk — cannot determine ` +
        `who bears its HVUT. Add a row (even an explicit UNRESOLVED one) rather than defaulting silently.`,
    );
  }
  return row.hvutPayer;
}

/** Deterministic ordering for the largest-remainder split: VIN ascending.
 *  Stable, unique per unit, and independent of which report page a unit
 *  happened to print on. */
function byVinAscending(a: IrpInvoiceUnit, b: IrpInvoiceUnit): number {
  return a.vin < b.vin ? -1 : a.vin > b.vin ? 1 : 0;
}

function sumHvutByChargedTo(
  perUnitHvutCents: { unit: IrpInvoiceUnit; chargedTo: ChargedTo; cents: number }[],
): { totals: HvutChargedToTotals; counts: HvutChargedToCounts } {
  const bucket: Record<ChargedTo, number> = { company: 0, driver: 0, split: 0, unknown: 0 };
  const count: Record<ChargedTo, number> = { company: 0, driver: 0, split: 0, unknown: 0 };
  for (const { chargedTo, cents } of perUnitHvutCents) {
    bucket[chargedTo] += cents;
    count[chargedTo] += 1;
  }
  return {
    totals: {
      company: decimalFromCents(bucket.company),
      driver: decimalFromCents(bucket.driver),
      unknown: decimalFromCents(bucket.unknown),
    },
    counts: { company: count.company, driver: count.driver, unknown: count.unknown },
  };
}

export function buildRegistrationPosting(input: RegistrationPostingInput): RegistrationPostingResult {
  const { roster, feeLines, invoiceTotal, hvutRatePerUnit, unitStatuses, entityId, truckByVin } = input;
  const { header, units } = roster;

  if (units.length !== header.totalUnits) {
    throw new Error(`Roster header says ${header.totalUnits} units but ${units.length} were provided`);
  }
  const weightGroup = assertUniformWeightGroup(units);
  const irpInvoiceTotalCents = assertFeeLinesReconcile(feeLines, invoiceTotal);

  const statusByVin = new Map(unitStatuses.map((r) => [r.vin, r] as const));

  const orderedUnits = [...units].sort(byVinAscending);
  const n = orderedUnits.length;

  // ---- IRP: one combined even-split figure per unit -------------------
  // The invoice itemizes registration / foreign-jurisdiction / BMV fees at
  // the FLEET level only; nothing on it breaks any of those out per unit.
  // Reconciliation (readiness criterion 1) is against the invoice's single
  // grand total, so the allocation is done on that total directly, not
  // fee-line-by-fee-line — splitting each fee line independently and
  // summing would still total correctly but would scatter the $0.05 across
  // units unevenly across categories, which the worked example ($1,879.98 /
  // $1,879.99 only, nothing else) shows is not how this is meant to land.
  const irpPerUnitCents = evenSplitCents(irpInvoiceTotalCents, n);
  const irpAllocationNote =
    `Fleet invoice total ${invoiceTotal} split evenly across ${n} units (all weight group ${weightGroup}); ` +
    `the invoice carries no per-unit breakdown. Remainder pennies assigned one-per-unit, ordered by VIN ` +
    `ascending, to the first ${irpInvoiceTotalCents - Math.floor(irpInvoiceTotalCents / n) * n} unit(s).`;

  // ---- HVUT: a known flat statutory rate per unit, not a split ---------
  const hvutPerUnitCents = centsFromDecimal(hvutRatePerUnit);
  const hvutTotalCents = hvutPerUnitCents * n;

  const perUnitHvut = orderedUnits.map((unit) => ({
    unit,
    chargedTo: resolveHvutPayer(unit, statusByVin),
    cents: hvutPerUnitCents,
  }));
  const { totals: hvutByChargedTo, counts: hvutUnitCountByChargedTo } = sumHvutByChargedTo(perUnitHvut);

  // ---- Prepaid postings (fleet-level; the invoice was paid once) -------
  const prepaidEntries: LedgerEntryDraft[] = [
    {
      key: 'irp-prepaid',
      entityId,
      truckId: null,
      unitType: 'unknown', // fleet-level; not attributable to one truck
      unitNumber: null,
      categoryId: PREPAID_CATEGORY,
      amount: `-${decimalFromCents(irpInvoiceTotalCents)}`,
      currency: CURRENCY,
      accrualDate: input.irpPaymentDate,
      chargedTo: 'company',
      allocationBasis: 'actual',
      allocationNote: `Full IRP invoice total for fleet ${header.fleetNo} (${header.legalName}), ${n} units.`,
      sourceKind: 'document',
      sourceDocumentId: input.irpSourceDocumentId,
      memo: `IRP renewal ${header.accountNo}/${header.fleetNo}, run ${header.runDate}: prepaid registration asset.`,
      postedBy: input.postedBy,
    },
    {
      key: 'hvut-prepaid',
      entityId,
      truckId: null,
      unitType: 'unknown',
      unitNumber: null,
      categoryId: PREPAID_CATEGORY,
      amount: `-${decimalFromCents(hvutTotalCents)}`,
      currency: CURRENCY,
      accrualDate: input.hvutPaymentDate,
      chargedTo: 'company',
      allocationBasis: 'actual',
      allocationNote: `HVUT (Form 2290) at flat ${hvutRatePerUnit}/unit x ${n} units. Paid in full by the ` +
        `company; per-unit driver/company/unknown attribution is resolved at monthly recognition, not here.`,
      sourceKind: 'document',
      sourceDocumentId: input.hvutSourceDocumentId,
      memo: `HVUT (Form 2290) for fleet ${header.fleetNo}: prepaid road-tax asset.`,
      postedBy: input.postedBy,
    },
  ];

  // ---- Amortization schedule: 12 months x 2 cost streams x n units -----
  // The registration year runs UP TO the fleet expiration month, so its
  // first covered month is 12 months before expiration (fleet expires
  // 09/2027 -> coverage starts 2026-09, matching SOURCE-DISCOVERY §11c).
  // HVUT amortizes over the same window per this task's explicit instruction
  // ("Same for HVUT"), not the separate federal HVUT tax year.
  const fleetExpirationMonth = periodMonthOf(header.fleetExpirationYear, header.fleetExpirationMonth);
  const registrationYearStart = addMonths(fleetExpirationMonth, -COVERAGE_MONTHS);
  const months = monthRange(registrationYearStart, COVERAGE_MONTHS);

  const scheduleRows: AmortizationScheduleRowDraft[] = [];
  const postedEntries: LedgerEntryDraft[] = [];

  for (let i = 0; i < n; i++) {
    const unit = orderedUnits[i] as IrpInvoiceUnit;
    const truckId = truckByVin[unit.vin]?.truckId ?? null;
    const irpUnitCents = irpPerUnitCents[i] as number;
    const irpMonthlyCents = evenSplitCents(irpUnitCents, COVERAGE_MONTHS);

    const hvut = perUnitHvut[i] as { unit: IrpInvoiceUnit; chargedTo: ChargedTo; cents: number };
    const hvutMonthlyCents = evenSplitCents(hvut.cents, COVERAGE_MONTHS);

    const streams = [
      { categoryId: IRP_CATEGORY, prepaidKey: 'irp-prepaid', monthly: irpMonthlyCents, chargedTo: 'company' as ChargedTo, basis: 'even_split' as const, sourceDocumentId: input.irpSourceDocumentId },
      { categoryId: HVUT_CATEGORY, prepaidKey: 'hvut-prepaid', monthly: hvutMonthlyCents, chargedTo: hvut.chargedTo, basis: 'actual' as const, sourceDocumentId: input.hvutSourceDocumentId },
    ];
    for (const stream of streams) {
      for (let m = 0; m < COVERAGE_MONTHS; m++) {
        const periodMonth = months[m] as IsoDate;
        const cents = stream.monthly[m] as number;
        const closed = isMonthClosed(periodMonth, input.asOf);

        let postedEntryKey: string | null = null;
        if (closed) {
          const key = `${stream.categoryId}:${unit.unitNumber}:${periodMonth}`;
          postedEntries.push({
            key,
            entityId,
            truckId,
            unitType: 'truck', // HVUT applies only to power units; all 42 units here are trucks, never trailers
            unitNumber: unit.unitNumber,
            categoryId: stream.categoryId,
            amount: `-${decimalFromCents(cents)}`,
            currency: CURRENCY,
            accrualDate: periodMonth,
            chargedTo: stream.chargedTo,
            allocationBasis: stream.basis,
            allocationNote:
              stream.categoryId === IRP_CATEGORY
                ? irpAllocationNote
                : `Flat HVUT rate ${hvutRatePerUnit}, amortized 1/12 per month.`,
            sourceKind: 'document',
            sourceDocumentId: stream.sourceDocumentId,
            memo: `${stream.categoryId} recognition for unit ${unit.unitNumber} (VIN ${unit.vin}), ${periodMonth}.`,
            postedBy: input.postedBy,
          });
          postedEntryKey = key;
        }

        scheduleRows.push({
          sourceDocumentId: stream.sourceDocumentId,
          prepaidEntryKey: stream.prepaidKey,
          entityId,
          truckId,
          unitNumber: unit.unitNumber,
          vin: unit.vin,
          categoryId: stream.categoryId,
          periodMonth,
          amount: `-${decimalFromCents(cents)}`,
          chargedTo: stream.chargedTo,
          allocationBasis: stream.basis,
          closed,
          postedEntryKey,
        });
      }
    }
  }

  return {
    prepaidEntries,
    scheduleRows,
    postedEntries,
    reconciliation: {
      irpFeeLineTotal: decimalFromCents(irpInvoiceTotalCents),
      irpInvoiceTotal: invoiceTotal,
      irpAllocatedTotal: decimalFromCents(sumCents(irpPerUnitCents)),
      irpPerUnit: orderedUnits.map((u, i) => ({
        unitNumber: u.unitNumber,
        vin: u.vin,
        amount: decimalFromCents(irpPerUnitCents[i] as number),
      })),
      hvutRatePerUnit,
      hvutTotal: decimalFromCents(hvutTotalCents),
      hvutByChargedTo,
      hvutUnitCountByChargedTo,
      weightGroup,
      unitCount: n,
    },
  };
}
