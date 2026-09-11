/**
 * The P&L rollup engine's core: one primitive (`buildPnlBucket`) that every
 * grain — per truck, per entity, per group, per period — calls, so the
 * reconciliation identities (readiness criteria) hold by construction:
 * summing the same additive function over a partition of the same rows
 * always reproduces the total over the union, to the cent, with no
 * separate "total" code path that could drift from the parts.
 *
 * No database access anywhere in this file. Pure functions over
 * `SummaryLedgerEntry[]` in, results out.
 */
import type { CategoryGroup, Decimal } from '@/contract/types';
import type { AllocationBasis } from '@/engines/registration';
import { centsFromDecimal, decimalFromCents, sumCents } from '@/engines/registration';
import { resolveBearing } from './bearing';
import { isBalanceSheetCategory, isIntercompanyCategory, stripIntercompany } from './categoryRules';
import { daysInPeriod, isWithinPeriod, periodsCovering } from './periods';
import type {
  AllocatedAmount,
  CategoryGroupAmount,
  EntityPnlResult,
  GroupPnlResult,
  Period,
  PnlBucket,
  SummaryLedgerEntry,
  TruckPnlResult,
} from './types';
import type { Grain, IsoDate } from '@/contract/types';

interface GroupAccum {
  cents: number;
  count: number;
}

interface AllocatedAccum extends GroupAccum {
  categoryGroup: CategoryGroup;
  allocationBasis: Exclude<AllocationBasis, 'actual'>;
  bearer: 'company' | 'driver';
}

function bump(map: Map<CategoryGroup, GroupAccum>, group: CategoryGroup, cents: number): void {
  const existing = map.get(group);
  if (existing) {
    existing.cents += cents;
    existing.count += 1;
  } else {
    map.set(group, { cents, count: 1 });
  }
}

function bumpAllocated(
  map: Map<string, AllocatedAccum>,
  categoryGroup: CategoryGroup,
  allocationBasis: Exclude<AllocationBasis, 'actual'>,
  bearer: 'company' | 'driver',
  cents: number,
): void {
  const key = `${categoryGroup}::${allocationBasis}::${bearer}`;
  const existing = map.get(key);
  if (existing) {
    existing.cents += cents;
    existing.count += 1;
  } else {
    map.set(key, { categoryGroup, allocationBasis, bearer, cents, count: 1 });
  }
}

function toGroupArray(map: Map<CategoryGroup, GroupAccum>): CategoryGroupAmount[] {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([categoryGroup, v]) => ({
      categoryGroup,
      amount: decimalFromCents(v.cents),
      entryCount: v.count,
    }));
}

function toAllocatedArray(map: Map<string, AllocatedAccum>): AllocatedAmount[] {
  return [...map.values()]
    .sort((a, b) =>
      a.categoryGroup === b.categoryGroup
        ? a.allocationBasis.localeCompare(b.allocationBasis)
        : a.categoryGroup.localeCompare(b.categoryGroup),
    )
    .map((v) => ({
      categoryGroup: v.categoryGroup,
      allocationBasis: v.allocationBasis,
      bearer: v.bearer,
      amount: decimalFromCents(v.cents),
      entryCount: v.count,
    }));
}

/**
 * The one function every result in this engine is built from. Takes
 * whatever entries the caller has already filtered down to (a truck's rows,
 * an entity's rows, a consolidated group's rows, ...) plus the period they
 * cover, and produces one `PnlBucket`. Contains no entity/truck/group
 * filtering logic itself — that lives in the functions below, each of which
 * calls this once per bucket it needs.
 */
export function buildPnlBucket(entries: readonly SummaryLedgerEntry[], period: Period): PnlBucket {
  const days = daysInPeriod(period);

  let revenueCents = 0;
  const companyByGroup = new Map<CategoryGroup, GroupAccum>();
  const driverByGroup = new Map<CategoryGroup, GroupAccum>();
  const allocated = new Map<string, AllocatedAccum>();
  let excludedBsCents = 0;
  let excludedBsCount = 0;
  let entryCount = 0;

  for (const e of entries) {
    if (isBalanceSheetCategory(e.categoryId)) {
      // Rule 5 / SOURCE-DISCOVERY §11c / §15: a balance-sheet movement
      // (a prepaid asset payment, a loan principal repayment) is never a
      // P&L line, at any grain. Counted here so the stripped dollar amount
      // stays visible rather than vanishing from every total.
      excludedBsCents += Math.abs(centsFromDecimal(e.amount));
      excludedBsCount += 1;
      continue;
    }
    entryCount += 1;

    if (e.categoryGroup === 'revenue') {
      // Revenue is never chargeable back to a driver in this model — it is
      // summed as-is regardless of `chargedTo` (which defaults to
      // 'company' for a revenue row at commit time; see db/repo/commit.ts).
      revenueCents += centsFromDecimal(e.amount);
      continue;
    }

    const bearing = resolveBearing(e);
    if (bearing.companyCents !== 0) {
      bump(companyByGroup, e.categoryGroup, bearing.companyCents);
      if (e.allocationBasis !== 'actual') {
        bumpAllocated(allocated, e.categoryGroup, e.allocationBasis, 'company', bearing.companyCents);
      }
    }
    if (bearing.driverCents !== 0) {
      bump(driverByGroup, e.categoryGroup, bearing.driverCents);
      if (e.allocationBasis !== 'actual') {
        bumpAllocated(allocated, e.categoryGroup, e.allocationBasis, 'driver', bearing.driverCents);
      }
    }
    // bearing.needsHuman rows contribute to neither bucket — see
    // `workQueue.ts`'s `unresolvedChargebackAmount` for where that dollar
    // amount is surfaced instead of silently disappearing.
  }

  const companyCostTotalCents = sumCents([...companyByGroup.values()].map((v) => v.cents));
  const driverBorneCostTotalCents = sumCents([...driverByGroup.values()].map((v) => v.cents));
  const marginCents = revenueCents + companyCostTotalCents;
  const costPerDayCents = days > 0 ? Math.round(Math.abs(companyCostTotalCents) / days) : 0;

  return {
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    days,
    revenue: decimalFromCents(revenueCents),
    companyCostByCategoryGroup: toGroupArray(companyByGroup),
    companyCostTotal: decimalFromCents(companyCostTotalCents),
    driverBorneCostByCategoryGroup: toGroupArray(driverByGroup),
    driverBorneCostTotal: decimalFromCents(driverBorneCostTotalCents),
    margin: decimalFromCents(marginCents),
    costPerDay: decimalFromCents(costPerDayCents),
    allocatedAmounts: toAllocatedArray(allocated),
    excludedBalanceSheetTotal: decimalFromCents(excludedBsCents),
    excludedBalanceSheetCount: excludedBsCount,
    entryCount,
  };
}

function inPeriod(e: SummaryLedgerEntry, period: Period): boolean {
  return isWithinPeriod(e.accrualDate, period);
}

/** Per-truck result: revenue, cost by category group, margin and
 *  cost-per-day for one truck over one period, with company-borne and
 *  driver-borne cost kept apart (CLAUDE.md §2 rule 1). */
export function summarizeTruck(
  entries: readonly SummaryLedgerEntry[],
  truckId: string,
  period: Period,
): TruckPnlResult {
  const filtered = entries.filter((e) => e.truckId === truckId && inPeriod(e, period));
  return { truckId, ...buildPnlBucket(filtered, period) };
}

/**
 * Per-entity result over BASE rows (intercompany legs included — CLAUDE.md
 * §2 rule 2: "per-entity roll-ups use the base rows"). Breaks out one
 * `TruckPnlResult` per distinct truck plus an `unattributed` bucket for
 * entries with no truck, so `sum(trucks) + unattributed === this bucket`
 * exactly (readiness criterion 1) — `trucks`/`unattributed` and the
 * top-level fields are all built from the exact same filtered set,
 * partitioned by `truckId`, with no row counted twice and none dropped.
 */
export function summarizeEntity(
  entries: readonly SummaryLedgerEntry[],
  entityId: string,
  period: Period,
): EntityPnlResult {
  const inEntity = entries.filter((e) => e.entityId === entityId && inPeriod(e, period));

  const truckIds = [...new Set(inEntity.filter((e) => e.truckId !== null).map((e) => e.truckId as string))].sort();
  const trucks = truckIds.map((truckId) => summarizeTruck(inEntity, truckId, period));
  const unattributedEntries = inEntity.filter((e) => e.truckId === null);
  const unattributed = buildPnlBucket(unattributedEntries, period);

  const whole = buildPnlBucket(inEntity, period);

  const intercompanyCents = sumCents(
    inEntity.filter((e) => isIntercompanyCategory(e.categoryId)).map((e) => centsFromDecimal(e.amount)),
  );

  return {
    entityId,
    ...whole,
    trucks,
    unattributed,
    intercompanyNet: decimalFromCents(intercompanyCents),
  };
}

/**
 * Group result over the CONSOLIDATED set (intercompany legs stripped —
 * CLAUDE.md §2 rule 2: "group uses the consolidated set"). `entities` is
 * still built from each entity's own BASE rows (its real, un-eliminated
 * view — exactly what a per-entity screen would show), so the
 * reconciliation identity is checkable directly on this result:
 *
 *   sum(entities[i].margin) === margin + eliminatedIntercompany   (to the cent)
 *
 * See `summary-intercompany.test.ts` for the proof with real figures.
 */
export function summarizeGroup(
  entries: readonly SummaryLedgerEntry[],
  entityIds: readonly string[],
  period: Period,
): GroupPnlResult {
  const entityIdSet = new Set(entityIds);
  const entities = entityIds.map((entityId) => summarizeEntity(entries, entityId, period));

  const inGroup = entries.filter((e) => entityIdSet.has(e.entityId) && inPeriod(e, period));
  const consolidated = stripIntercompany(inGroup);
  const whole = buildPnlBucket(consolidated, period);

  const eliminatedCents = sumCents(entities.map((e) => centsFromDecimal(e.intercompanyNet)));

  return {
    ...whole,
    entities,
    eliminatedIntercompany: decimalFromCents(eliminatedCents),
  };
}

// ---------------------------------------------------------------------
// Period series — day/week/month/quarter/year, all built from the same
// `periodsCovering` primitive plus the single-period functions above, so a
// twelve-month series and a one-year period are two views of literally the
// same additive computation (readiness criterion 5).
// ---------------------------------------------------------------------

export function summarizeTruckSeries(
  entries: readonly SummaryLedgerEntry[],
  truckId: string,
  grain: Grain,
  rangeStart: IsoDate,
  rangeEnd: IsoDate,
): TruckPnlResult[] {
  return periodsCovering(grain, rangeStart, rangeEnd).map((p) => summarizeTruck(entries, truckId, p));
}

export function summarizeEntitySeries(
  entries: readonly SummaryLedgerEntry[],
  entityId: string,
  grain: Grain,
  rangeStart: IsoDate,
  rangeEnd: IsoDate,
): EntityPnlResult[] {
  return periodsCovering(grain, rangeStart, rangeEnd).map((p) => summarizeEntity(entries, entityId, p));
}

export function summarizeGroupSeries(
  entries: readonly SummaryLedgerEntry[],
  entityIds: readonly string[],
  grain: Grain,
  rangeStart: IsoDate,
  rangeEnd: IsoDate,
): GroupPnlResult[] {
  return periodsCovering(grain, rangeStart, rangeEnd).map((p) => summarizeGroup(entries, entityIds, p));
}

/** Convenience for a "profitable vs negative" truck list: every distinct
 *  truck across `entries` (regardless of entity), summarized once over
 *  `period` and sorted worst-margin-first so a CEO screen can slice the
 *  list at zero without re-deriving the sort. Does not itself decide what
 *  counts as "the group" (no intercompany stripping) — pass an
 *  already-consolidated `entries` set for a group-wide list, or a single
 *  entity's base rows for one entity's list. */
export function rankTrucksByMargin(entries: readonly SummaryLedgerEntry[], period: Period): TruckPnlResult[] {
  const truckIds = [...new Set(entries.filter((e) => e.truckId !== null).map((e) => e.truckId as string))].sort();
  return truckIds
    .map((truckId) => summarizeTruck(entries, truckId, period))
    .sort((a, b) => centsFromDecimal(a.margin) - centsFromDecimal(b.margin));
}

export { decimalFromCents, centsFromDecimal };
export type { Decimal };
