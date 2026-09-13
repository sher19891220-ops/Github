/**
 * The fixed cost the operator already tracks, per truck per week.
 *
 * Before this the ledger held maintenance, tolls and trailer cost — about 2%
 * of revenue — and the dashboard reported a 97.7% margin, which is not a
 * margin but an absent cost side. These pin the two properties that make a
 * rate card safe to post: it can never be read back as a measured cost, and
 * posting the same week twice cannot double it.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { createManualEntry } from '@/db/repo/manualEntry';
import { ENTITY_XTRACK_ID, ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';

const CAT = 'lease.truck';

async function rate(entityId: string, lineItem: string, r: string, from: string, to: string | null) {
  await query(
    `INSERT INTO accounting.fixed_cost_rate
       (entity_id, category_id, line_item, rate_per_truck_week, effective_from, effective_to, source)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, 'test')`,
    [entityId, CAT, lineItem, r, from, to],
  );
}

describe('the fixed-cost rate card', () => {
  beforeAll(async () => {
    await ensureBaseFixtures();
    await query(
      `INSERT INTO accounting.category (category_id, category_group, display_name, sign)
       VALUES ('lease.truck','lease','Truck lease (fixture)',-1),
              ('overhead.salaries','overhead','Salaries (fixture)',-1)
       ON CONFLICT (category_id) DO NOTHING`,
    );
  });

  it('refuses two rates for the same line and carrier on the same day', async () => {
    const line = `L${randomUUID().slice(0, 8)}`;
    await rate(ENTITY_ZONE_ID, line, '842.95', '2026-01-01', '2026-06-30');
    // Overlaps by a day. Without this a reload that forgot to close the old
    // row would double every cost derived from it, silently.
    await expect(rate(ENTITY_ZONE_ID, line, '900.00', '2026-06-30', null)).rejects.toThrow(
      /fixed_cost_rate_never_overlaps/,
    );
  });

  it('accepts a rate change as two adjacent periods', async () => {
    const line = `L${randomUUID().slice(0, 8)}`;
    await rate(ENTITY_ZONE_ID, line, '842.95', '2026-01-01', '2026-06-30');
    await expect(rate(ENTITY_ZONE_ID, line, '900.00', '2026-07-01', null)).resolves.toBeUndefined();
  });

  it('posts as `rate_card`, never as a measured amount', async () => {
    // The whole point of the column: an invoice and a model must be tellable
    // apart afterwards, by a query and not by reading a memo.
    const { entry } = await createManualEntry(
      {
        entityId: ENTITY_XTRACK_ID,
        accrualDate: '2026-03-02',
        categoryId: CAT,
        amount: '-42121.44',
        chargedTo: 'company',
        allocationBasis: 'rate_card',
        allocationNote: 'Truck average @ $877.53/truck/week x 48 trucks',
        assertedBy: 'test',
        basis: "Operator's fixed cost rate card. Modelled, not an invoice.",
      },
      'test',
    );
    const row = await query<{ basis: string; note: string | null }>(
      `SELECT allocation_basis AS basis, allocation_note AS note
         FROM accounting.ledger_entry WHERE entry_id = $1`,
      [entry.entryId],
    );
    expect(row[0]?.basis).toBe('rate_card');
    expect(row[0]?.note).toMatch(/per truck per week|\/truck\/week/);
  });

  it('a rate-card entry is not counted as an actual by the allocation report', async () => {
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting.ledger_entry
        WHERE allocation_basis = 'rate_card' AND category_id = $1`,
      [CAT],
    );
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThan(0);
    const actuals = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting.ledger_entry
        WHERE allocation_basis = 'actual' AND allocation_note LIKE '%truck%week%'`,
    );
    expect(Number(actuals[0]?.n ?? 0)).toBe(0);
  });

  it('a blank cell is "not applied", which is not the same as zero', async () => {
    // AFG pays no IFTA line on the real card. A zero rate would assert the
    // cost is nothing; absence asserts nothing at all, and the loader skips
    // blanks rather than writing 0.
    const present = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting.fixed_cost_rate WHERE rate_per_truck_week = 0
         AND line_item NOT LIKE '#headcount=%'`,
    );
    expect(Number(present[0]?.n ?? 0)).toBe(0);
  });
});
