/**
 * Types for the P&L rollup engine.
 *
 * Layers on top of `@/contract/types` exactly the way
 * `@/engines/registration/types.ts` does: the contract's `LedgerEntry` is
 * the wire/DB shape every screen builds against, but it does not (yet)
 * carry the columns migrations 002/003/004 put on `ledger_entry`
 * (`charged_to`, `allocation_basis`, `unit_type`, `unit_number`,
 * `paid_by_entity_id`, `counterparty_entity_id`) or the `category_group`
 * a category id maps to. This engine needs every one of those to obey
 * CLAUDE.md §2's rules, so `SummaryLedgerEntry` adds them here rather than
 * widening the shared contract unilaterally.
 *
 * **Known gap** (see the final report): `mapDbRowToLedgerEntry`
 * (`src/db/repo/mappers.ts`, not this engine's file to change) does not
 * currently select or map any of these columns either — the same gap
 * `src/db/repo/types.ts` already documents for `StagingRow`. `loadSummaryEntries`
 * (`src/db/repo/summaryEntries.ts`) is the query that selects every one of
 * them, including the `accounting.category` join for `category_group` and
 * `account_nature`; this engine cannot and does not go fetch them itself,
 * because it does no I/O.
 */

import type { AccountNature, CategoryGroup, Decimal, IsoDate } from '@/contract/types';
import type { AllocationBasis, ChargedTo, UnitType } from '@/engines/registration';

/**
 * The subset of a ledger row (plus the migration 002/003/004 additions)
 * this engine needs. Deliberately narrower than the full DB row — no
 * `postedAt`/`postedBy`/`memo`/`provenance`, because nothing here computes
 * from them. A caller building this from a real `ledger_entry` row simply
 * ignores the columns it doesn't list.
 */
export interface SummaryLedgerEntry {
  entryId: string;
  entityId: string;
  /** Null for an entry with no truck attribution (an office cost, a
   *  fleet-level prepaid payment, an intercompany leg, ...). Never guessed. */
  truckId: string | null;
  accrualDate: IsoDate;
  categoryId: string;
  /** Resolved externally by joining `accounting.category` — this engine
   *  never infers a group from a category id string (categories are
   *  maintained data, not a code enum; see migration 001 §2's comment). */
  categoryGroup: CategoryGroup;
  /**
   * Whether this row is a P&L line, a balance-sheet movement or an
   * intercompany leg — `accounting.category.account_nature`, migration
   * 009. Resolved by the same join as `categoryGroup` and required for the
   * same reason: this engine used to guess it from the category *name*,
   * which silently deleted any genuine expense whose id happened to
   * contain the word "principal". A row that cannot say what kind of
   * account it came from has no business being rolled up.
   */
  accountNature: AccountNature;
  /** Signed decimal string, ledger convention: + inflow, - outflow. */
  amount: Decimal;
  chargedTo: ChargedTo;
  allocationBasis: AllocationBasis;
  unitType: UnitType;
  unitNumber: string | null;
  /** Mirrors `ledger_entry.paid_by_entity_id`. Not used in any arithmetic
   *  here — carried through purely so a result can explain an intercompany
   *  figure without a second lookup. */
  paidByEntityId: string | null;
  /** Mirrors `ledger_entry.counterparty_entity_id`. */
  counterpartyEntityId: string | null;
  /**
   * Resolved driver share for a `chargedTo: 'split'` row, as a positive
   * `Decimal` (what the driver owes), once `accounting.chargeback_decision`
   * has decided the ratio for this specific row (migration 006 keys a
   * decision to `ledger_entry_id`). `ledger_entry.charged_to` itself never
   * carries a ratio — only `chargeback_decision.split_amount` /
   * `split_percent` do — so a `'split'` row with this left `null`/omitted
   * is treated exactly like `'unknown'`: excluded from company cost,
   * flagged for a human, never guessed at. Ignored for every other
   * `chargedTo` value.
   */
  splitDriverShare?: Decimal | null;
  /**
   * True when the caller already knows this row wants a human look for a
   * reason this engine cannot itself detect (append-only `ledger_entry`
   * rows have already passed every DB CHECK by the time they exist, so
   * there is no "failed validation" flag on the row today — see the final
   * report). Defaults to false. Never computed by this engine.
   */
  failsValidation?: boolean;
}

/** A [start, end] calendar-day span, both inclusive. */
export interface Period {
  periodStart: IsoDate;
  periodEnd: IsoDate;
}

/** One category group's total, at whichever bearer bucket it was aggregated into. */
export interface CategoryGroupAmount {
  categoryGroup: CategoryGroup;
  /** Signed decimal string — a company-cost bucket is usually negative, but
   *  `other_cost` can turn positive when it nets a `receivable.intercompany`
   *  leg (see the group roll-up doc on `summarizeGroup`). Never coerced to
   *  a fixed sign; the ledger's own convention is preserved throughout. */
  amount: Decimal;
  entryCount: number;
}

/**
 * A cost figure that is a derived allocation, not a direct measurement —
 * carried through explicitly per CLAUDE.md §2 ("an allocated figure is
 * never presented as measured"). `bearer` distinguishes an allocated
 * amount that landed on company cost from one that landed on a driver
 * receivable; both can happen for the same category (e.g. an even-split
 * IRP fee is always company-borne, but nothing stops a future allocated
 * driver charge).
 */
export interface AllocatedAmount {
  categoryGroup: CategoryGroup;
  allocationBasis: Exclude<AllocationBasis, 'actual'>;
  bearer: 'company' | 'driver';
  amount: Decimal;
  entryCount: number;
}

/**
 * The common shape every grain of rollup (truck / unattributed-within-entity
 * / entity / group) produces, built by the one primitive (`buildPnlBucket`)
 * every other function in this engine calls. Nothing below is computed a
 * second, different way anywhere else in the module — that is what makes
 * the nesting/reconciliation properties hold by construction rather than by
 * coincidence.
 */
export interface PnlBucket {
  periodStart: IsoDate;
  periodEnd: IsoDate;
  days: number;
  /** Sum of every `category_group: 'revenue'` entry. Never reduced by
   *  `chargedTo` — revenue is not chargeable back to a driver in this model. */
  revenue: Decimal;
  companyCostByCategoryGroup: CategoryGroupAmount[];
  /** Sum of `companyCostByCategoryGroup`. Always excludes `chargedTo:
   *  'driver'` rows and the company's remaining share of `'split'` rows —
   *  never the whole cost. See CLAUDE.md §2 rule 1. */
  companyCostTotal: Decimal;
  driverBorneCostByCategoryGroup: CategoryGroupAmount[];
  /** A receivable from the driver(s), expressed as a positive amount owed
   *  TO the company — NOT part of `companyCostTotal` and NOT subtracted
   *  from `margin`. */
  driverBorneCostTotal: Decimal;
  /** `revenue + companyCostTotal` (the latter already signed negative for
   *  an ordinary cost), in cents, formatted back to a decimal string. */
  margin: Decimal;
  /** Analysis figure: `abs(companyCostTotal) / days`, rounded to the
   *  nearest cent. Never posted anywhere; purely a per-truck/per-entity
   *  comparison rate, same spirit as `registration/overheadRate.ts`'s
   *  `dailyRate`. */
  costPerDay: Decimal;
  allocatedAmounts: AllocatedAmount[];
  /** Total of rows stripped as balance-sheet movements (a prepaid asset
   *  payment, a loan-principal repayment) rather than a recognized P&L
   *  cost — see `categoryRules.ts`. Reported so the amount is visible
   *  somewhere rather than silently vanishing from every total. */
  excludedBalanceSheetTotal: Decimal;
  excludedBalanceSheetCount: number;
  /** Count of P&L-eligible rows this bucket actually summed (excludes the
   *  balance-sheet-stripped rows counted above). */
  entryCount: number;
}

export interface TruckPnlResult extends PnlBucket {
  truckId: string;
}

export interface EntityPnlResult extends PnlBucket {
  entityId: string;
  /** One result per distinct truck this entity has entries for in the
   *  period. `sum(trucks[i].<field>) + unattributed.<field> ===
   *  this.<field>` exactly, for every money field — see readiness
   *  criterion 1 and `summary-rollup.test.ts`. */
  trucks: TruckPnlResult[];
  /** Entries attributed to this entity but to no truck at all (office
   *  costs, fleet-level prepaid payments before per-truck amortization,
   *  intercompany legs, ...). Kept apart rather than folded into a
   *  fictitious "truck", so `trucks` never lies about what it covers. */
  unattributed: PnlBucket;
  /** Net of every `receivable.intercompany` / `payable.intercompany` row
   *  included in this entity's totals above (this function always uses
   *  base rows, per CLAUDE.md §2 rule 2). This is exactly the figure a
   *  group roll-up must add back to reconcile: see `summarizeGroup`. */
  intercompanyNet: Decimal;
}

export interface GroupPnlResult extends PnlBucket {
  /** Every field above is computed on the CONSOLIDATED set (intercompany
   *  legs stripped) across every entity in `entityIds`, matching
   *  `accounting.v_ledger_consolidated`'s contract: "group uses the
   *  consolidated set." */
  entities: EntityPnlResult[];
  /** `sum(entities[i].intercompanyNet)`. Reconciliation identity (readiness
   *  criterion 1): `sum(entities[i].margin) === margin + eliminatedIntercompany`,
   *  to the cent. */
  eliminatedIntercompany: Decimal;
}

export interface WorkQueueSummary {
  /** `chargedTo: 'unknown'`, plus `chargedTo: 'split'` rows with no
   *  resolved `splitDriverShare` — both are cost rows this engine could not
   *  assign to company or driver, so neither total above includes them.
   *  This is the dollar amount currently missing from both for that reason. */
  unresolvedChargebackCount: number;
  unresolvedChargebackAmount: Decimal;
  /** `unitType: 'unknown'` with no `truckId`/`unitNumber` at all, on a cost
   *  row whose category group ordinarily names a unit (fuel, toll,
   *  maintenance, permit) — i.e. a cost that plausibly belongs to a
   *  specific truck but cannot currently be attributed to one. */
  unresolvedUnitTypeCount: number;
  unresolvedUnitTypeAmount: Decimal;
  /** Rows the caller has already flagged via `failsValidation`. See the
   *  type doc on `SummaryLedgerEntry.failsValidation` for why this engine
   *  cannot compute this flag itself. */
  failingValidationCount: number;
  failingValidationAmount: Decimal;
  /** Rows stripped under the "principal is never a cost" guard
   *  (`categoryRules.isPrincipalCategory`) — surfaced so a stripped dollar
   *  amount is visible somewhere, never silently absorbed into a total. */
  excludedPrincipalCount: number;
  excludedPrincipalAmount: Decimal;
}
