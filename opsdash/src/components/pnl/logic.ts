/**
 * Pure presentation logic for the P&L screen.
 *
 * Kept out of the component so it can be tested under this repo's `node`
 * vitest environment, which has no DOM — and because every function here
 * is a place a P&L can quietly lie. Each one is about refusing to show a
 * number that reads as more certain than it is.
 */
import type { Decimal, Grain } from '@/contract/types';
import { moneyToCents } from '@/components/format/decimal';
import type { CategoryGroupAmount, PnlBucket } from '@/engines/summary';
import { daysInPeriod, periodFor } from '@/engines/summary';

/**
 * Margin as a share of revenue, to one decimal place.
 *
 * Returns `null` when there is no revenue, and the caller renders that as
 * "—" rather than "0.0%". A period with costs and no revenue has an
 * undefined margin percentage, not a zero one; showing 0% invites someone
 * to read a truck that earned nothing as merely breaking even.
 */
export function marginPercent(revenue: Decimal, margin: Decimal): string | null {
  const revenueCents = moneyToCents(revenue);
  if (revenueCents === 0n) return null;
  // Scale before dividing so the single division is the only rounding, and
  // it happens on integers. ×1000 gives one decimal place after ÷10.
  const scaled = (moneyToCents(margin) * 1000n) / revenueCents;
  const sign = scaled < 0n ? '-' : '';
  const abs = scaled < 0n ? -scaled : scaled;
  return `${sign}${abs / 10n}.${abs % 10n}%`;
}

/**
 * How wide to draw a bar for one cost group, 0..1 of the largest group.
 *
 * Proportional to the biggest bar, not to the total: with eight groups the
 * largest would otherwise occupy a third of the cell and the rest would be
 * slivers indistinguishable from each other.
 *
 * A float is correct here and only here — this is a pixel width, never a
 * figure anyone reads. It is derived from exact cents so the ordering can
 * never disagree with the numbers in the same row.
 */
export function barShare(amount: Decimal, largest: Decimal): number {
  const largestCents = moneyToCents(largest);
  const abs = largestCents < 0n ? -largestCents : largestCents;
  if (abs === 0n) return 0;
  const cents = moneyToCents(amount);
  const absCents = cents < 0n ? -cents : cents;
  const share = Number((absCents * 10000n) / abs) / 10000;
  return share > 1 ? 1 : share;
}

/** Cost groups, largest first — the order someone reads a cost table in. */
export function byLargestCost(groups: readonly CategoryGroupAmount[]): CategoryGroupAmount[] {
  return [...groups].sort((a, b) => {
    const av = moneyToCents(a.amount);
    const bv = moneyToCents(b.amount);
    const aAbs = av < 0n ? -av : av;
    const bAbs = bv < 0n ? -bv : bv;
    return aAbs === bAbs ? 0 : aAbs > bAbs ? -1 : 1;
  });
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** A short label for one bucket, at the grain that produced it. */
export function periodLabel(bucket: { periodStart: string; periodEnd: string }, grain: Grain | null): string {
  const [y, m, d] = bucket.periodStart.split('-') as [string, string, string];
  const month = MONTHS[Number(m) - 1] ?? m;
  switch (grain) {
    case 'day':
      return `${Number(d)} ${month} ${y}`;
    case 'week':
      return `w/c ${Number(d)} ${month}`;
    case 'month':
      return `${month} ${y}`;
    case 'quarter':
      return `Q${Math.floor((Number(m) - 1) / 3) + 1} ${y}`;
    case 'year':
      return y;
    default:
      return `${bucket.periodStart} → ${bucket.periodEnd}`;
  }
}

/**
 * True when a bucket covers fewer days than a whole period of its grain.
 *
 * `periodsCovering` clamps the first and last bucket to the requested
 * range, which is what makes a series sum to its total. The cost is that a
 * 17-day January can sit in a column beside twelve full months and read as
 * a terrible month. Marking it is the difference between a clamped series
 * being honest and being misleading.
 */
export function isPartialPeriod(bucket: PnlBucket, grain: Grain | null): boolean {
  if (grain === null) return false;
  return bucket.days < daysInPeriod(periodFor(grain, bucket.periodStart));
}

/** Human label for a category group, for a table a person reads all day. */
export function categoryGroupLabel(group: string): string {
  switch (group) {
    case 'revenue':
      return 'Revenue';
    case 'fuel':
      return 'Fuel';
    case 'toll':
      return 'Tolls';
    case 'maintenance':
      return 'Maintenance';
    case 'permit':
      return 'Permits & registration';
    case 'ifta':
      return 'IFTA';
    case 'insurance':
      return 'Insurance';
    case 'driver_pay':
      return 'Driver pay';
    case 'lease':
      return 'Lease & financing';
    case 'other_cost':
      return 'Other';
    default:
      return group;
  }
}

export interface Caveat {
  id: string;
  label: string;
  amount: Decimal | null;
  count: number;
  /** What a person should do about it, or why it is not a defect. */
  detail: string;
}

/**
 * What the totals on screen are still missing, and why.
 *
 * A margin shown without these is a lower bound wearing a margin's
 * clothes. Every entry returns even at zero, because "nothing unresolved"
 * is itself information an accountant wants confirmed rather than inferred
 * from an absent row.
 */
export function caveatsFor(
  bucket: PnlBucket,
  workQueue: {
    unresolvedChargebackCount: number;
    unresolvedChargebackAmount: Decimal;
  },
): Caveat[] {
  return [
    {
      id: 'unresolved-chargeback',
      label: 'Cost rows not yet assigned to company or driver',
      amount: workQueue.unresolvedChargebackAmount,
      count: workQueue.unresolvedChargebackCount,
      detail:
        'Excluded from both company cost and the driver receivable — never guessed onto either side. Resolve them on the chargeback screen and this margin will move.',
    },
    {
      id: 'balance-sheet',
      label: 'Balance-sheet movements stripped out',
      amount: bucket.excludedBalanceSheetTotal,
      count: bucket.excludedBalanceSheetCount,
      detail:
        'Prepaid payments and loan principal are money moving between an asset and a liability, not money spent. Counted here so the amount stays visible rather than vanishing from every total.',
    },
    {
      id: 'driver-receivable',
      label: 'Driver-borne cost, owed to the company',
      amount: bucket.driverBorneCostTotal,
      count: 0,
      detail:
        'Not part of company cost and not subtracted from margin — it is a receivable, and treating it as a cost would understate the company twice over.',
    },
  ];
}
