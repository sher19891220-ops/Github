/**
 * What each Truck Max invoice charge becomes, decided before anything is
 * written.
 *
 * Kept apart from the script that posts it so the decisions can be tested
 * without a database — and because these are the decisions, not the SQL.
 *
 * The one that matters: WHO WAS BILLED IS NOT WHO BORE IT. Truck Max
 * invoices Zone for almost everything and the teams redistribute
 * afterwards, and the invoice log has no record of the redistribution. A
 * charge in the `company` file is evidence that Zone was billed and nothing
 * more, so it posts with that caveat attached and the run reports the total
 * sitting on a billing address.
 */

export interface Charge {
  payer: string;
  date: string | null;
  invoice: string | null;
  truck: string | null;
  trailer: string | null;
  is_trailer: boolean;
  unresolvable_truck: boolean;
  issue: string | null;
  amount: number;
}

export interface Control {
  payer: string;
  rows: number;
  detail_sum: number;
  printed_total: number | null;
  ties: boolean;
}

export type Decision =
  /** Both legs: a cost to the billed company, revenue to the shop. */
  | { kind: 'pair'; billedCode: string; categoryId: string; key: string; billingAddressOnly: boolean }
  /** Shop revenue only — billed outside the group, so nobody inside bears it. */
  | { kind: 'external'; key: string }
  /** Not posted, and why. */
  | { kind: 'held'; reason: string }
  | { kind: 'refused'; reason: string };

/** Who the invoice went to. `null` means outside the group entirely. */
export const BILLED_ENTITY: Readonly<Record<string, string | null>> = {
  company: 'ZONE',
  iron_lease: 'IRONLEASE',
  driver: null,
  sher_imam: null,
};

/**
 * A trailer's cost is a fixed cost, never a truck's. Trailers are pooled
 * across the carriers, so following the unit named on the invoice would
 * charge a tyre to whichever company happened to draw that trailer.
 */
export function categoryFor(c: Charge): string {
  return c.is_trailer ? 'trailer.fixed' : 'maintenance.repair';
}

/**
 * A natural key from the source, so a second run posts nothing. The invoice
 * number alone is not unique — one invoice can carry several charges — so
 * the payer, date, amount and unit go in with it.
 */
export function naturalKey(c: Charge): string {
  const unit = c.truck ?? c.trailer ?? 'no-unit';
  return `TM:${c.payer}:${c.invoice ?? 'no-invoice'}:${c.date ?? 'no-date'}:${c.amount.toFixed(2)}:${unit}`;
}

export function decide(c: Charge, refusedPayers: ReadonlySet<string>): Decision {
  if (refusedPayers.has(c.payer)) {
    return { kind: 'refused', reason: `${c.payer} does not tie to its own printed total` };
  }
  if (!c.date) return { kind: 'held', reason: `no date: ${c.invoice ?? '(no invoice)'} ${c.amount.toFixed(2)}` };
  if (!(c.amount > 0)) return { kind: 'held', reason: `not a positive charge: ${c.invoice ?? ''} ${c.amount}` };
  if (c.unresolvable_truck) {
    return { kind: 'held', reason: `unit could not be read: ${c.invoice ?? ''} ${c.amount.toFixed(2)}` };
  }

  const billedCode = BILLED_ENTITY[c.payer];
  if (billedCode === undefined) {
    // A new payer file is a new billing relationship, and guessing which
    // company it lands on is how a cost ends up on the wrong P&L.
    return { kind: 'held', reason: `unknown payer "${c.payer}": ${c.amount.toFixed(2)}` };
  }
  if (billedCode === null) return { kind: 'external', key: naturalKey(c) };

  return {
    kind: 'pair',
    billedCode,
    categoryId: categoryFor(c),
    key: naturalKey(c),
    billingAddressOnly: c.payer === 'company',
  };
}

export function refusedPayers(controls: readonly Control[]): Set<string> {
  return new Set(controls.filter((c) => !c.ties).map((c) => c.payer));
}
