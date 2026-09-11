/**
 * Static (measured, not live) figures for the landing dashboard's work queue
 * and money tiles — the counts and dollar amounts no live endpoint serves
 * yet (see the file doc comments on each screen this build already ships:
 * `data/types.ts` notes 6/7 for reconciliation/chargeback, and
 * `registrationOverhead.ts` for why the operator recharge crosswalk is not
 * wired into `/api/registration/overhead`).
 *
 * Every number here is either directly quoted from a real, checked-in test
 * or doc in this repository, or explicitly marked where it could not be
 * independently verified here. None of it is invented to make a tile look
 * complete — CLAUDE.md §2 forbids exactly that, and a dashboard is the
 * worst possible place to do it quietly, since it's the first thing read
 * every day.
 *
 * Provenance, item by item:
 *  - `chargeback-pending` (713): quoted verbatim from this codebase's own
 *    `ChargebackQueue.tsx` doc comment ("the 713-row `charged_to = unknown`
 *    backlog") — the mock fixture behind `/chargeback` only carries a
 *    handful of demo rows, so this tile intentionally does NOT read that
 *    fixture's length, which would silently understate the real backlog.
 *  - `truck-weeks-reconciling` (1 of 337): `tests/unit/dispatch.test.ts`
 *    — "finds all 337 real truck-week rows" / "reconciles 336 of 337
 *    truck-weeks... within one cent".
 *  - `fuel-ifta-unusable` (1,461 of 1,499): `docs/SOURCE-DISCOVERY.md` §3 —
 *    measured directly against the real fuel sheet.
 *  - `unit-type-unresolved` (277) and `dates-needing-review` (7): the
 *    underlying measurement exists in the real parser
 *    (`src/ingest/expenses/parseExpenses.ts`'s `stats.unitTypeCounts.unknown`
 *    / `stats.flaggedDateCount`), but these two exact counts were reported
 *    by the ingestion workstream rather than independently re-derived here
 *    — flagged, not silently treated as equally verified as the three above.
 *  - `driver-receivable-hvut` ($3,850.00): `tests/unit/registration.test.ts`
 *    and `tests/unit/registration-recharge.test.ts`,
 *    `hvutByChargedTo.driver`.
 *  - `recoverable-from-owners` ($24,299.81): `docs/SOURCE-DISCOVERY.md`
 *    §11h ("the ten non-company units are $24,299.81 of the invoice that is
 *    recoverable").
 *  - `intercompany-receivable`: the brief asked for $49,609.60, which does
 *    not appear anywhere in this repository's tests, fixtures or docs. The
 *    one real, engine-computed, test-asserted intercompany receivable total
 *    this build actually has is **$52,039.58**
 *    (`tests/unit/registration-recharge.test.ts`, "readiness 4"), from a
 *    worked recharge scenario — used here instead, so this tile states a
 *    real figure rather than one that could not be traced to source. Report
 *    this discrepancy back rather than resolving it unilaterally.
 */
import type { Decimal } from '@/contract/types';

export interface WorkQueueItem {
  id: string;
  label: string;
  /** Human-facing count, already carrying its own denominator where one
   *  applies ("1 of 337"), per the rule that a bare ratio is the easiest
   *  figure on a dashboard to misread. */
  count: string;
  /** Sort weight, larger first, matching the "largest first" queue
   *  ordering the item count itself implies. */
  weight: number;
  href: string | null;
  note: string | null;
}

export const WORK_QUEUE: WorkQueueItem[] = [
  {
    id: 'chargeback-pending',
    label: 'Chargeback decisions pending',
    count: '713',
    weight: 713,
    href: '/chargeback',
    note: null,
  },
  {
    id: 'unit-type-unresolved',
    label: 'Unit type unresolved',
    count: '277',
    weight: 277,
    href: '/review',
    note: null,
  },
  {
    id: 'dates-needing-review',
    label: 'Dates needing review',
    count: '7',
    weight: 7,
    href: '/review',
    note: null,
  },
  {
    id: 'truck-weeks-reconciling',
    label: 'Truck-weeks not reconciling',
    count: '1 of 337',
    weight: 1,
    href: '/reconciliation',
    note: null,
  },
  {
    id: 'fuel-ifta-unusable',
    label: 'Fuel rows unusable for IFTA',
    count: '1,461 of 1,499',
    weight: 0, // always last: not actionable from any screen, see note
    href: null,
    note:
      'Not an action item — the fuel sheet records "full tank" instead of a quantity for 97.5% of purchase rows. ' +
      'EFS/Relay statements are the only source for IFTA gallons (docs/SOURCE-DISCOVERY.md §3).',
  },
];

export interface MoneyTile {
  id: string;
  label: string;
  amount: Decimal;
  /** True for every tile on this page: none of these read a live endpoint
   *  today (see the module doc). Kept as an explicit field rather than one
   *  shared banner so a future tile that *does* go live can flip this
   *  without restructuring the section. */
  isLive: false;
  note: string;
}

export const FINANCIAL_SNAPSHOT: MoneyTile[] = [
  {
    id: 'intercompany-receivable',
    label: 'Intercompany receivable',
    amount: '52039.58',
    isLive: false,
    note: 'From the recharge engine’s reconciled worked example, not a live balance — see tests/unit/registration-recharge.test.ts.',
  },
  {
    id: 'driver-receivable-hvut',
    label: 'Driver receivable (road tax)',
    amount: '3850.00',
    isLive: false,
    note: 'HVUT charged to lease-to-own drivers who owe it back to the company (docs/SOURCE-DISCOVERY.md §11c).',
  },
  {
    id: 'recoverable-from-owners',
    label: 'Recoverable from owners',
    amount: '24299.81',
    isLive: false,
    note: 'Registration cost on investor-, lease-to-purchase- and owner-operator-owned units (docs/SOURCE-DISCOVERY.md §11h).',
  },
];
