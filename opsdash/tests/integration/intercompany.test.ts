/**
 * A shop invoice is two facts, and the group's cost is neither of them.
 *
 * TruckMax bills XTRACK $1,000 for a repair. The group has not spent
 * $1,000 — it has spent what the parts and labour cost. The charge is a
 * cost to the carrier and revenue to the shop, and those cancel on
 * consolidation, leaving the real cost behind.
 *
 * Before this, only the carrier's side was ever posted: the group's cost
 * was overstated by the shop's markup, and the shop had no revenue for work
 * it really did.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '@/db/pool';
import { IntercompanyError, postShopWork, unbalancedIntercompany } from '@/db/repo/intercompany';
import { ENTITY_XTRACK_ID, ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';

let shopId: string;
let attestationId: string;

beforeAll(async () => {
  await ensureBaseFixtures();
  const rows = await query<{ entity_id: string }>(
    `INSERT INTO accounting.entity (code, legal_name, kind)
     VALUES ($1, 'Test Fixture Shop', 'shop')
     ON CONFLICT (code) DO UPDATE SET kind = 'shop'
     RETURNING entity_id`,
    [`SHOP-TEST-${randomUUID().slice(0, 8)}`],
  );
  shopId = rows[0]!.entity_id;
  await query(
    `INSERT INTO accounting.category (category_id, category_group, display_name, sign)
     VALUES ('revenue.shop_work', 'revenue', 'Shop work billed to a group company', 1)
     ON CONFLICT (category_id) DO NOTHING`,
  );
  // The broken-pair tests below insert rows directly, bypassing postShopWork
  // to produce states it will not produce. They are still real ledger rows
  // and the ledger still requires a manual one to be attested.
  const att = await query<{ attestation_id: string }>(
    `INSERT INTO accounting.manual_attestation (asserted_by, basis)
     VALUES ('test', 'Deliberately malformed pair, to prove the imbalance view sees it.')
     RETURNING attestation_id`,
  );
  attestationId = att[0]!.attestation_id;
});

function work(over: Partial<Parameters<typeof postShopWork>[1]> = {}) {
  return {
    shopEntityId: shopId,
    billedEntityId: ENTITY_XTRACK_ID,
    accrualDate: '2026-04-06',
    amount: '1000.00',
    categoryId: 'maintenance.repair',
    assertedBasis: 'Shop work recorded from the repair order; invoice to follow.',
    postedBy: 'test',
    ...over,
  };
}

async function sumFor(entityId: string, pairId: string): Promise<number> {
  const rows = await query<{ s: string }>(
    `SELECT COALESCE(sum(amount),0)::text AS s FROM accounting.ledger_entry
      WHERE entity_id = $1 AND intercompany_pair_id = $2`,
    [entityId, pairId],
  );
  return Number(rows[0]!.s);
}

describe('shop work posts both legs', () => {
  it('costs the carrier and pays the shop, from one call', async () => {
    const r = await postShopWork(query, work());
    expect(await sumFor(ENTITY_XTRACK_ID, r.pairId)).toBe(-1000);
    expect(await sumFor(shopId, r.pairId)).toBe(1000);
  });

  it('nets to zero across the group, so consolidation leaves only the real cost', async () => {
    // The whole point. The group did not spend what the shop charged.
    const r = await postShopWork(query, work({ amount: '2500.00' }));
    const rows = await query<{ s: string }>(
      `SELECT COALESCE(sum(amount),0)::text AS s FROM accounting.ledger_entry WHERE intercompany_pair_id = $1`,
      [r.pairId],
    );
    expect(Number(rows[0]!.s)).toBe(0);
  });

  it('files the carrier side under the cost category and the shop side under revenue', async () => {
    const r = await postShopWork(query, work({ categoryId: 'maintenance.repair' }));
    const rows = await query<{ entity_id: string; category_id: string }>(
      `SELECT entity_id, category_id FROM accounting.ledger_entry WHERE intercompany_pair_id = $1`,
      [r.pairId],
    );
    const byEntity = Object.fromEntries(rows.map((x) => [x.entity_id, x.category_id]));
    expect(byEntity[ENTITY_XTRACK_ID]).toBe('maintenance.repair');
    expect(byEntity[shopId]).toBe('revenue.shop_work');
  });

  it('names each side as the other side’s counterparty', async () => {
    const r = await postShopWork(query, work());
    const rows = await query<{ entity_id: string; counterparty_entity_id: string }>(
      `SELECT entity_id, counterparty_entity_id FROM accounting.ledger_entry WHERE intercompany_pair_id = $1`,
      [r.pairId],
    );
    const byEntity = Object.fromEntries(rows.map((x) => [x.entity_id, x.counterparty_entity_id]));
    expect(byEntity[ENTITY_XTRACK_ID]).toBe(shopId);
    expect(byEntity[shopId]).toBe(ENTITY_XTRACK_ID);
  });
});

describe('what it refuses', () => {
  it('will not let a company bill itself', async () => {
    await expect(postShopWork(query, work({ billedEntityId: shopId }))).rejects.toThrow(/cannot bill itself/);
  });

  it('will not let a carrier bill shop work', async () => {
    // A carrier billing repair work to another carrier is a different
    // transaction and needs its own treatment; quietly accepting it here
    // would file it as shop revenue and misstate both companies.
    await expect(
      postShopWork(query, { ...work(), shopEntityId: ENTITY_ZONE_ID, billedEntityId: ENTITY_XTRACK_ID }),
    ).rejects.toThrow(/not a shop/);
  });


  it('will not post without an invoice or a stated basis', async () => {
    // A manual figure nobody has put their name to is exactly what this
    // ledger refuses, and shop work is no exception.
    const { assertedBasis: _drop, ...bare } = work();
    await expect(postShopWork(query, bare)).rejects.toThrow(/put their name to/);
  });

  it('will not take a negative or zero amount', async () => {
    // The sign is decided by which leg it is, never by the caller.
    await expect(postShopWork(query, work({ amount: '-500.00' }))).rejects.toThrow(IntercompanyError);
    await expect(postShopWork(query, work({ amount: '0' }))).rejects.toThrow(/positive amount/);
  });

  it('is refused by the database when a row names itself as counterparty', async () => {
    await expect(
      query(
        `INSERT INTO accounting.ledger_entry
           (entity_id, counterparty_entity_id, accrual_date, category_id, amount,
            source_kind, attestation_id, posted_by)
         VALUES ($1, $1, '2026-04-06', 'maintenance.repair', -1, 'manual', $2, 'test')`,
        [ENTITY_XTRACK_ID, attestationId],
      ),
    ).rejects.toThrow(/counterparty_is_another_entity/);
  });
});

describe('a missing leg is visible', () => {
  it('reports a pair with only one leg', async () => {
    // Exactly the state every shop invoice was in before this existed.
    const orphan = randomUUID();
    await query(
      `INSERT INTO accounting.ledger_entry
         (entity_id, counterparty_entity_id, intercompany_pair_id, accrual_date,
          category_id, amount, source_kind, attestation_id, posted_by)
       VALUES ($1, $2, $3, '2026-04-07', 'maintenance.repair', -900, 'manual', $4, 'test')`,
      [ENTITY_XTRACK_ID, shopId, orphan, attestationId],
    );
    const found = (await unbalancedIntercompany(query)).find((p) => p.intercompanyPairId === orphan);
    expect(found).toBeDefined();
    expect(found!.legs).toBe(1);
    expect(found!.problem).toMatch(/only one leg/);
  });

  it('reports two legs that do not cancel', async () => {
    const pair = randomUUID();
    for (const [entity, amount] of [[ENTITY_XTRACK_ID, -900], [shopId, 800]] as const) {
      await query(
        `INSERT INTO accounting.ledger_entry
           (entity_id, intercompany_pair_id, accrual_date, category_id, amount,
            source_kind, attestation_id, posted_by)
         VALUES ($1, $2, '2026-04-08', 'maintenance.repair', $3, 'manual', $4, 'test')`,
        [entity, pair, amount, attestationId],
      );
    }
    const found = (await unbalancedIntercompany(query)).find((p) => p.intercompanyPairId === pair);
    expect(found!.problem).toMatch(/do not cancel/);
    expect(Number(found!.net)).toBe(-100);
  });

  it('does not report a correctly posted pair', async () => {
    const r = await postShopWork(query, work({ amount: '777.00' }));
    expect((await unbalancedIntercompany(query)).find((p) => p.intercompanyPairId === r.pairId)).toBeUndefined();
  });
});
