/**
 * Pure posting logic for a real IRP renewal + HVUT filing. No I/O: takes the
 * parsed invoice, the parsed VIN crosswalk, and everything identity-resolved
 * externally, and returns the ledger/amortization rows to persist. See
 * docs/SOURCE-DISCOVERY.md §11b/§11c for the transaction this was built
 * against.
 */

import type { Decimal, IsoDate } from '@/contract/types';
import { centsFromDecimal, decimalFromCents, evenSplitCents, sumCents } from './money';
import { addMonths, isMonthClosed, lastDayOfPeriodMonth, monthRange, periodMonthOf } from './dates';
import { computeOverheadRate } from './overheadRate';
import type {
  AmortizationScheduleRowDraft,
  ChargedTo,
  HvutChargedToCounts,
  HvutChargedToTotals,
  IrpInvoiceUnit,
  LedgerEntryDraft,
  NeedsConfirmationUnit,
  RegistrationPostingInput,
  RegistrationPostingResult,
  TruckOverheadRate,
  UnitOperatorRow,
  UnitStatusRow,
} from './types';

const COVERAGE_MONTHS = 12;
const IRP_CATEGORY = 'permit.irp';
const HVUT_CATEGORY = 'tax.hvut';
const PREPAID_CATEGORY = 'prepaid.registration';
const RECEIVABLE_CATEGORY = 'receivable.intercompany';
const CURRENCY = 'USD';

/** The crosswalk's sentinel for "no operator could be determined" — stays
 *  with the payer rather than inventing an operator. Not itself an operator
 *  key, so it is never looked up in `operatorEntityByKey`. */
const UNRESOLVED_OPERATOR_KEY = 'UNRESOLVED';

/** The only entities that operate trucks and can therefore ever be a
 *  recharge target. Iron Lease is an asset-holding company with no IRP
 *  account, and an owner-held unit is the same shape — title, not
 *  operation. Neither has operating revenue to absorb a cost, so neither
 *  may appear here: a title holder is a fact about who OWNS the unit, and
 *  is a wholly separate question from who OPERATES it (which Zone,
 *  Xtrack or AFG always does). If the crosswalk ever names a non-carrier
 *  as `operating_entity`, `resolveUnitOperator` throws rather than
 *  recharging it or silently reassigning it to the payer. */
const VALID_RECHARGE_OPERATOR_KEYS = new Set(['zone', 'xtrack', 'afg']);

/** Canonical labels for `reconciliation.costByOperatorKey`, independent of
 *  whatever opaque `entity_id` each key actually resolves to. */
type OperatorBucket = 'zone' | 'xtrack' | 'afg' | 'unresolved';
const OPERATOR_BUCKETS: OperatorBucket[] = ['zone', 'xtrack', 'afg', 'unresolved'];

interface UnitOperatorResolution {
  /** Raw crosswalk key ('zone', 'xtrack', ..., 'UNRESOLVED'), or null when
   *  no crosswalk was supplied at all (pre-recharge callers). */
  operatorKey: string | null;
  /** The operator's resolved `entity_id`, but ONLY when it differs from the
   *  payer — i.e. only when set does a recharge candidate exist. Null for
   *  "same as payer" (including the 'zone' key), for UNRESOLVED, and for
   *  "no crosswalk supplied". */
  operatorEntityId: string | null;
  needsConfirmation: boolean;
}

interface StreamBearer {
  entityId: string;
  paidByEntityId: string | null;
  recharged: boolean;
}

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

/**
 * Resolves which entity a unit's registration cost follows, per
 * docs/SOURCE-DISCOVERY.md §11e. Returns `operatorEntityId: null` whenever
 * there is nothing to recharge — no crosswalk supplied, the operator IS the
 * payer, or the operator is genuinely UNRESOLVED (which stays with the
 * payer rather than inventing one, per the operator's explicit decision).
 *
 * Throws if the crosswalk names an operator that is not one of
 * `VALID_RECHARGE_OPERATOR_KEYS` — title (who owns the unit, e.g. Iron
 * Lease) is a different fact from operation (who runs it, always Zone,
 * Xtrack or AFG), and a title holder has no operating revenue to absorb a
 * recharge. This is a hard guard, not a fallback: the caller gets an
 * exception, never a silent reassignment to the payer and never a silent
 * recharge to a non-carrier.
 */
function resolveUnitOperator(
  unit: IrpInvoiceUnit,
  operatorByVin: Map<string, UnitOperatorRow> | null,
  operatorEntityByKey: Record<string, string>,
  payerEntityId: string,
): UnitOperatorResolution {
  if (!operatorByVin) {
    return { operatorKey: null, operatorEntityId: null, needsConfirmation: false };
  }
  const row = operatorByVin.get(unit.vin);
  if (!row) {
    throw new Error(
      `Unit ${unit.unitNumber} (VIN ${unit.vin}) has no row in the operator crosswalk — cannot determine which ` +
        `entity its registration cost follows. Add a row (even an explicit UNRESOLVED one) rather than ` +
        `defaulting silently.`,
    );
  }
  if (row.operatingEntityKey === UNRESOLVED_OPERATOR_KEY) {
    // Zone did pay, and there is no evidence of another operator: stays
    // with Zone, but flagged for review rather than treated as an ordinary
    // zone-operated unit.
    return { operatorKey: row.operatingEntityKey, operatorEntityId: null, needsConfirmation: true };
  }
  if (!VALID_RECHARGE_OPERATOR_KEYS.has(row.operatingEntityKey)) {
    throw new Error(
      `Unit ${unit.unitNumber} (VIN ${unit.vin}): operator "${row.operatingEntityKey}" is not a valid recharge ` +
        `target. Only zone, xtrack and afg operate trucks — a title holder (e.g. Iron Lease) or an owner-held ` +
        `unit has no operating revenue to absorb a cost and can never receive a recharge. Refusing to post this.`,
    );
  }
  const resolvedEntityId = operatorEntityByKey[row.operatingEntityKey];
  if (!resolvedEntityId) {
    throw new Error(
      `Unit ${unit.unitNumber} (VIN ${unit.vin}): operator key "${row.operatingEntityKey}" has no resolved ` +
        `entity id in operatorEntityByKey — refusing to invent one.`,
    );
  }
  if (resolvedEntityId === payerEntityId) {
    return { operatorKey: row.operatingEntityKey, operatorEntityId: null, needsConfirmation: false };
  }
  return { operatorKey: row.operatingEntityKey, operatorEntityId: resolvedEntityId, needsConfirmation: false };
}

/** The bearer of a single cost stream (IRP, or HVUT for this unit): the
 *  operator when this stream is a company cost AND the operator differs
 *  from the payer, otherwise the payer with no recharge. Driver-borne and
 *  unknown-borne HVUT never recharge — that money isn't a company cost at
 *  all, so there is nothing to reassign between group companies; it stays
 *  exactly where it always has, on the payer's books, pending resolution
 *  against the driver. */
function bearerFor(streamChargedTo: ChargedTo, unitOperator: UnitOperatorResolution, payerEntityId: string): StreamBearer {
  if (unitOperator.operatorEntityId && streamChargedTo === 'company') {
    return { entityId: unitOperator.operatorEntityId, paidByEntityId: payerEntityId, recharged: true };
  }
  return { entityId: payerEntityId, paidByEntityId: null, recharged: false };
}

/** The canonical reporting bucket a stream's cost lands in, independent of
 *  the opaque entity_id it actually resolved to. */
function bucketFor(unitOperator: UnitOperatorResolution, bearer: StreamBearer): OperatorBucket {
  if (bearer.recharged) return unitOperator.operatorKey as OperatorBucket;
  if (unitOperator.operatorKey === UNRESOLVED_OPERATOR_KEY) return 'unresolved';
  return 'zone';
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
  // Omitting operatorAssignments entirely preserves the pre-recharge
  // behavior byte-for-byte: every unit's cost stays with the payer.
  const operatorByVin = input.operatorAssignments
    ? new Map(input.operatorAssignments.map((r) => [r.vin, r] as const))
    : null;
  const operatorEntityByKey = input.operatorEntityByKey ?? {};

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
      // The recharge splits how the cost is RECOGNIZED (see scheduleRows /
      // postedEntries), never the fact that Zone is the one who actually
      // sent the cash for the whole invoice. This row stays exactly as it
      // was before the recharge existed.
      paidByEntityId: null,
      counterpartyEntityId: null,
      needsConfirmation: false,
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
      paidByEntityId: null,
      counterpartyEntityId: null,
      needsConfirmation: false,
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
  // Real coverage window for the per-truck overhead rate (readiness 6):
  // the first day of the first covered month through the LAST day of the
  // last covered month, e.g. 2026-09-01..2027-08-31 — never a hardcoded
  // 365, so the daily rate is exact for any registration year, leap or not.
  const coverageStart = months[0] as IsoDate;
  const coverageEnd = lastDayOfPeriodMonth(months[COVERAGE_MONTHS - 1] as IsoDate);

  const scheduleRows: AmortizationScheduleRowDraft[] = [];
  const postedEntries: LedgerEntryDraft[] = [];
  const intercompanyEntries: LedgerEntryDraft[] = [];
  const needsConfirmationUnits: NeedsConfirmationUnit[] = [];
  const overheadRates: TruckOverheadRate[] = [];
  const costByOperatorKeyCents: Record<OperatorBucket, number> = {
    zone: 0, xtrack: 0, afg: 0, unresolved: 0,
  };

  for (let i = 0; i < n; i++) {
    const unit = orderedUnits[i] as IrpInvoiceUnit;
    const truckId = truckByVin[unit.vin]?.truckId ?? null;
    const irpUnitCents = irpPerUnitCents[i] as number;
    const irpMonthlyCents = evenSplitCents(irpUnitCents, COVERAGE_MONTHS);

    const hvut = perUnitHvut[i] as { unit: IrpInvoiceUnit; chargedTo: ChargedTo; cents: number };
    const hvutMonthlyCents = evenSplitCents(hvut.cents, COVERAGE_MONTHS);

    // Resolved once per unit — "each month the operator's latest known
    // entity", never a re-derivation per month, since a schedule row that
    // hasn't posted yet may in principle move with a future transfer, but
    // this posting run only ever knows about the assignment as of today.
    const unitOperator = resolveUnitOperator(unit, operatorByVin, operatorEntityByKey, entityId);
    if (unitOperator.needsConfirmation) {
      needsConfirmationUnits.push({
        unitNumber: unit.unitNumber,
        vin: unit.vin,
        operatorKey: unitOperator.operatorKey as string,
      });
    }

    const streams = [
      {
        categoryId: IRP_CATEGORY, prepaidKey: 'irp-prepaid', monthly: irpMonthlyCents,
        fullYearCents: irpUnitCents, chargedTo: 'company' as ChargedTo, basis: 'even_split' as const,
        sourceDocumentId: input.irpSourceDocumentId, paymentDate: input.irpPaymentDate,
      },
      {
        categoryId: HVUT_CATEGORY, prepaidKey: 'hvut-prepaid', monthly: hvutMonthlyCents,
        fullYearCents: hvut.cents, chargedTo: hvut.chargedTo, basis: 'actual' as const,
        sourceDocumentId: input.hvutSourceDocumentId, paymentDate: input.hvutPaymentDate,
      },
    ];
    // Captured for the per-truck overhead rate below: IRP is always
    // company-borne (see `streams` above), so its bearer always exists and
    // is the truck's actual operator — unlike HVUT, whose bearer can be the
    // payer even when the truck is recharged elsewhere (driver-borne HVUT
    // never recharges).
    let irpBearerEntityId: string | null = null;
    for (const stream of streams) {
      const bearer = bearerFor(stream.chargedTo, unitOperator, entityId);
      if (stream.categoryId === IRP_CATEGORY) irpBearerEntityId = bearer.entityId;
      costByOperatorKeyCents[bucketFor(unitOperator, bearer)] += stream.fullYearCents;

      // The recharge (bullet 2 of the operator's decision): Zone's claim
      // against the operator is a real, present fact as of the moment Zone
      // paid — it does not wait for the benefit to be consumed month by
      // month, so it posts once, in full, dated at payment. This is also
      // the only place it CAN post: accounting.amortization_schedule (see
      // migration 004) was given paid_by_entity_id but no
      // counterparty_entity_id, so a monthly *scheduled* receivable could
      // never name who it's owed by. The cost side doesn't have this
      // problem — entity_id (operator) + paid_by_entity_id (Zone) fully
      // describes it on every schedule row below.
      if (bearer.recharged) {
        intercompanyEntries.push({
          key: `receivable:${stream.categoryId}:${unit.unitNumber}`,
          entityId, // Zone, the payer, holds the receivable
          truckId,
          unitType: 'truck',
          unitNumber: unit.unitNumber,
          categoryId: RECEIVABLE_CATEGORY,
          amount: decimalFromCents(stream.fullYearCents), // positive: an asset to Zone
          currency: CURRENCY,
          accrualDate: stream.paymentDate,
          chargedTo: 'company',
          allocationBasis: stream.basis,
          allocationNote:
            `Intercompany receivable: unit ${unit.unitNumber}'s ${stream.categoryId} (${decimalFromCents(stream.fullYearCents)}) ` +
            `follows the truck to operator "${unitOperator.operatorKey}" per docs/SOURCE-DISCOVERY.md §11e. Zone paid ` +
            `the full invoice on ${stream.paymentDate}, so the receivable is booked in full at that date rather ` +
            `than spread over the amortization schedule.`,
          sourceKind: 'document',
          sourceDocumentId: stream.sourceDocumentId,
          memo: `Intercompany receivable from operator "${unitOperator.operatorKey}" for unit ${unit.unitNumber} ` +
            `(VIN ${unit.vin}), ${stream.categoryId}.`,
          postedBy: input.postedBy,
          paidByEntityId: null,
          counterpartyEntityId: unitOperator.operatorEntityId,
          needsConfirmation: unitOperator.needsConfirmation,
        });
      }

      for (let m = 0; m < COVERAGE_MONTHS; m++) {
        const periodMonth = months[m] as IsoDate;
        const cents = stream.monthly[m] as number;
        const closed = isMonthClosed(periodMonth, input.asOf);

        let postedEntryKey: string | null = null;
        if (closed) {
          const key = `${stream.categoryId}:${unit.unitNumber}:${periodMonth}`;
          postedEntries.push({
            key,
            entityId: bearer.entityId,
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
            paidByEntityId: bearer.paidByEntityId,
            counterpartyEntityId: null,
            needsConfirmation: unitOperator.needsConfirmation,
          });
          postedEntryKey = key;
        }

        scheduleRows.push({
          sourceDocumentId: stream.sourceDocumentId,
          prepaidEntryKey: stream.prepaidKey,
          entityId: bearer.entityId,
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
          paidByEntityId: bearer.paidByEntityId,
          needsConfirmation: unitOperator.needsConfirmation,
        });
      }
    }

    // Per-truck overhead rate (readiness criterion for the operator's daily
    // /weekly-margin ask): IRP + HVUT for this unit, over the real coverage
    // window. Computed unconditionally — the annual cost is known in full
    // from the invoice regardless of whether a recharge crosswalk was
    // supplied, so this never depends on `operatorAssignments`.
    overheadRates.push({
      ...computeOverheadRate({
        annualCents: irpUnitCents + hvut.cents,
        coverageStart,
        coverageEnd,
      }),
      truckId,
      unitNumber: unit.unitNumber,
      vin: unit.vin,
      entityId: irpBearerEntityId as string,
      categoryIds: [IRP_CATEGORY, HVUT_CATEGORY],
    });
  }

  const costByOperatorKey = Object.fromEntries(
    OPERATOR_BUCKETS.map((bucket) => [bucket, decimalFromCents(costByOperatorKeyCents[bucket])]),
  ) as Record<OperatorBucket, Decimal>;
  const intercompanyReceivableTotalCents = sumCents(intercompanyEntries.map((e) => centsFromDecimal(e.amount)));

  return {
    prepaidEntries,
    scheduleRows,
    postedEntries,
    intercompanyEntries,
    overheadRates,
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
      costByOperatorKey,
      intercompanyReceivableTotal: decimalFromCents(intercompanyReceivableTotalCents),
      needsConfirmationUnits,
    },
  };
}
