/**
 * What a Truck Max invoice charge becomes, and what it must never become.
 *
 * The shop bills the carriers, so every charge is potentially two ledger
 * entries. Getting the second one wrong is worse than not posting it: a cost
 * on a company that was never billed is a number somebody will defend.
 */
import { describe, expect, it } from 'vitest';
import { BILLED_ENTITY, categoryFor, decide, naturalKey, refusedPayers, type Charge } from '@/ingest/truckmax/plan';

function charge(over: Partial<Charge> = {}): Charge {
  return {
    payer: 'company',
    date: '2026-04-06',
    invoice: 'INV-1',
    truck: '1543',
    trailer: null,
    is_trailer: false,
    unresolvable_truck: false,
    issue: 'brake job',
    amount: 1200.5,
    ...over,
  };
}
const none = new Set<string>();

describe('a file that does not reconcile does not post', () => {
  it('refuses every row from a payer whose detail misses its printed total', () => {
    // The same discipline the fuel sheet got: a figure that does not tie is a
    // finding, not a number.
    const refused = refusedPayers([
      { payer: 'company', rows: 3, detail_sum: 100, printed_total: 100, ties: true },
      { payer: 'sher_imam', rows: 1, detail_sum: 150, printed_total: 999, ties: false },
    ]);
    expect(decide(charge({ payer: 'sher_imam' }), refused).kind).toBe('refused');
    expect(decide(charge({ payer: 'company' }), refused).kind).toBe('pair');
  });
});

describe('who was billed decides how many legs', () => {
  it('bills a group company as a pair', () => {
    const d = decide(charge({ payer: 'company' }), none);
    expect(d).toMatchObject({ kind: 'pair', billedCode: 'ZONE' });
  });

  it('bills Iron Lease as a pair too', () => {
    expect(decide(charge({ payer: 'iron_lease' }), none)).toMatchObject({ kind: 'pair', billedCode: 'IRONLEASE' });
  });

  it('posts shop revenue only when the customer is outside the group', () => {
    // Nobody inside the group bears it, so there is no second leg. Inventing
    // one would put a cost on a company that was never billed.
    expect(decide(charge({ payer: 'driver' }), none).kind).toBe('external');
    expect(decide(charge({ payer: 'sher_imam' }), none).kind).toBe('external');
  });

  it('holds a payer it has never seen rather than guessing where it lands', () => {
    const d = decide(charge({ payer: 'new_arrangement' }), none);
    expect(d).toMatchObject({ kind: 'held' });
    expect((d as { reason: string }).reason).toMatch(/unknown payer/);
  });
});

describe('the billing-address caveat travels with the row', () => {
  it('marks a company-file charge as billed, not borne', () => {
    // Truck Max invoices Zone for almost everything and the teams
    // redistribute afterwards; this source has no record of that.
    expect(decide(charge({ payer: 'company' }), none)).toMatchObject({ billingAddressOnly: true });
  });

  it('does not mark an Iron Lease charge that way', () => {
    expect(decide(charge({ payer: 'iron_lease' }), none)).toMatchObject({ billingAddressOnly: false });
  });
});

describe('a trailer is not a truck', () => {
  it('files trailer work as fixed cost, never as that truck’s repair', () => {
    // Trailers are pooled across the carriers. Following the unit named on
    // the invoice would charge a tyre to whoever drew that trailer.
    expect(categoryFor(charge({ is_trailer: true, truck: null, trailer: 'T-88' }))).toBe('trailer.fixed');
    expect(categoryFor(charge({ is_trailer: false }))).toBe('maintenance.repair');
  });
});

describe('what it holds', () => {
  it('holds a charge with no date — a ledger entry needs one', () => {
    expect(decide(charge({ date: null }), none)).toMatchObject({ kind: 'held' });
  });

  it('holds a zero or negative charge', () => {
    expect(decide(charge({ amount: 0 }), none).kind).toBe('held');
    expect(decide(charge({ amount: -50 }), none).kind).toBe('held');
  });

  it('holds a charge whose unit could not be read', () => {
    expect(decide(charge({ unresolvable_truck: true }), none)).toMatchObject({ kind: 'held' });
  });
});

describe('the natural key', () => {
  it('separates two charges on one invoice', () => {
    // An invoice number alone is not unique, so keying on it would post the
    // first charge and silently skip the rest as duplicates.
    const a = naturalKey(charge({ amount: 100 }));
    const b = naturalKey(charge({ amount: 200 }));
    expect(a).not.toBe(b);
  });

  it('is stable across runs, so a second load posts nothing', () => {
    expect(naturalKey(charge())).toBe(naturalKey(charge()));
  });

  it('separates the same amount billed to different payers', () => {
    expect(naturalKey(charge({ payer: 'company' }))).not.toBe(naturalKey(charge({ payer: 'driver' })));
  });

  it('survives a missing invoice number without colliding on unit', () => {
    const a = naturalKey(charge({ invoice: null, truck: '1543' }));
    const b = naturalKey(charge({ invoice: null, truck: '1544' }));
    expect(a).not.toBe(b);
  });
});

describe('the payer map itself', () => {
  it('routes every payer the pipeline produces', () => {
    // A payer the pipeline emits but this map does not know would be held on
    // every run, silently, forever.
    for (const p of ['company', 'driver', 'iron_lease', 'sher_imam']) {
      expect(p in BILLED_ENTITY).toBe(true);
    }
  });
});
