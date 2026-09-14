/**
 * The P&L service against a real Postgres.
 *
 * The engine's arithmetic is proven in unit tests. These prove the things
 * that only exist once a database is involved: that a group roll-up sees
 * both halves of an intercompany balance, that a series still nests after
 * going through a query, and that the caveats travel with the totals
 * instead of being computed somewhere else over some other rows.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { createDocument, getDocumentRows } from '@/db/repo/documents';
import { commitDocument } from '@/db/repo/commit';
import { updateStagingRow } from '@/db/repo/stagingRows';
import { PnlRequestError, getPnl } from '@/db/repo/pnl';
import { centsFromDecimal, sumCents } from '@/engines/registration';
import type { EntityPnlResult, GroupPnlResult, TruckPnlResult } from '@/engines/summary';
import {
  CATEGORY_MAINTENANCE,
  CATEGORY_REVENUE,
  ENTITY_ZONE_ID,
  ensureBaseFixtures,
} from './helpers';
import { expensesFixture } from './fixtures';

beforeAll(async () => {
  await ensureBaseFixtures();
});

async function makeTruck(): Promise<string> {
  const rows = (await query(
    `INSERT INTO accounting.truck (unit_number) VALUES ($1) RETURNING truck_id`,
    [`PNL-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`],
  )) as unknown as { truck_id: string }[];
  return rows[0]!.truck_id;
}

/** Posts one row through the real commit path. `amount` is written as the
 *  sheet writes it; the expense parser signs costs negative itself. */
async function post(opts: {
  amount: string;
  date: string;
  categoryId: string;
  truckId: string | null;
  chargedTo?: 'company' | 'driver';
}): Promise<string> {
  const unit = `PN${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
  const created = await createDocument({
    docType: 'maintenance',
    fileName: `pnl-${unit}.txt`,
    mimeType: 'text/plain',
    bytes: Buffer.from(
      expensesFixture(unit, opts.amount, opts.chargedTo ?? 'company', opts.date),
      'utf8',
    ),
    uploadedBy: 'integration-test',
  });
  const [row] = await getDocumentRows(created.documentId);
  const edit = await updateStagingRow(row!.stagingRowId, {
    entityId: ENTITY_ZONE_ID,
    categoryId: opts.categoryId,
    ...(opts.truckId !== null ? { truckId: opts.truckId } : {}),
  });
  if (!edit.ok) throw new Error(`setup failed: ${JSON.stringify(edit)}`);
  const result = await commitDocument(created.documentId, 'tester');
  if (result.committed !== 1) throw new Error(`setup failed: ${JSON.stringify(result)}`);
  return result.entryIds[0]!;
}

describe('getPnl', () => {
  it('rejects a request with no period rather than answering for all time', async () => {
    await expect(getPnl({ from: '2026-13-01', to: '2026-12-31', scope: 'group' })).rejects.toBeInstanceOf(
      PnlRequestError,
    );
    await expect(getPnl({ from: '2026-12-31', to: '2026-01-01', scope: 'group' })).rejects.toBeInstanceOf(
      PnlRequestError,
    );
    await expect(getPnl({ from: '2026-01-01', to: '2026-12-31', scope: 'entity' })).rejects.toBeInstanceOf(
      PnlRequestError,
    );
  });

  it('computes a truck P&L where margin is revenue plus company cost', async () => {
    const truckId = await makeTruck();
    await post({ amount: '-4000.00', date: '09.03.26', categoryId: CATEGORY_REVENUE, truckId });
    await post({ amount: '1250.75', date: '09.04.26', categoryId: CATEGORY_MAINTENANCE, truckId });

    const res = await getPnl({ from: '2026-09-01', to: '2026-09-30', scope: 'truck', truckId });
    const truck = res.results[0] as TruckPnlResult;

    expect(res.results).toHaveLength(1);
    expect(truck.truckId).toBe(truckId);
    expect(truck.revenue).toBe('4000.00');
    expect(truck.companyCostTotal).toBe('-1250.75');
    expect(truck.margin).toBe('2749.25');
    // 30 days in September, and the range asked for exactly those.
    expect(truck.days).toBe(30);
  });

  it('keeps a driver-borne cost out of margin and shows it as a receivable', async () => {
    const truckId = await makeTruck();
    await post({ amount: '-2000.00', date: '10.05.26', categoryId: CATEGORY_REVENUE, truckId });
    await post({
      amount: '500.00',
      date: '10.06.26',
      categoryId: CATEGORY_MAINTENANCE,
      truckId,
      chargedTo: 'driver',
    });

    const res = await getPnl({ from: '2026-10-01', to: '2026-10-31', scope: 'truck', truckId });
    const truck = res.results[0] as TruckPnlResult;

    // The cost is absent from company cost entirely, not netted down.
    expect(truck.companyCostTotal).toBe('0.00');
    expect(truck.margin).toBe('2000.00');
    // And present as a positive amount owed to the company.
    expect(truck.driverBorneCostTotal).toBe('500.00');
  });

  it('nests: a monthly series over a quarter sums to the quarter', async () => {
    const truckId = await makeTruck();
    await post({ amount: '-1111.11', date: '01.10.26', categoryId: CATEGORY_REVENUE, truckId });
    await post({ amount: '-2222.22', date: '02.14.26', categoryId: CATEGORY_REVENUE, truckId });
    await post({ amount: '-3333.33', date: '03.20.26', categoryId: CATEGORY_REVENUE, truckId });

    const series = await getPnl({
      from: '2026-01-01',
      to: '2026-03-31',
      grain: 'month',
      scope: 'truck',
      truckId,
    });
    const whole = await getPnl({ from: '2026-01-01', to: '2026-03-31', scope: 'truck', truckId });

    expect(series.results).toHaveLength(3);
    expect(series.grain).toBe('month');
    expect(whole.grain).toBeNull();

    const seriesCents = sumCents(series.results.map((r) => centsFromDecimal(r.revenue)));
    expect(seriesCents).toBe(centsFromDecimal(whole.results[0]!.revenue));
    expect(whole.results[0]!.revenue).toBe('6666.66');
  });

  it('rolls a truck up into its entity without losing or inventing a cent', async () => {
    const truckId = await makeTruck();
    await post({ amount: '-900.00', date: '11.02.26', categoryId: CATEGORY_REVENUE, truckId });
    await post({ amount: '150.00', date: '11.03.26', categoryId: CATEGORY_MAINTENANCE, truckId });
    // An entity-level cost that names no truck at all.
    await post({ amount: '75.00', date: '11.04.26', categoryId: CATEGORY_MAINTENANCE, truckId: null });

    const res = await getPnl({
      from: '2026-11-01',
      to: '2026-11-30',
      scope: 'entity',
      entityId: ENTITY_ZONE_ID,
    });
    const entity = res.results[0] as EntityPnlResult;

    // The identity the whole engine is built to hold: trucks plus the
    // unattributed remainder equal the entity, exactly.
    const trucksMargin = sumCents(entity.trucks.map((t) => centsFromDecimal(t.margin)));
    expect(trucksMargin + centsFromDecimal(entity.unattributed.margin)).toBe(
      centsFromDecimal(entity.margin),
    );
    // And the truck we just posted is in there, not folded into a fiction.
    expect(entity.trucks.some((t) => t.truckId === truckId)).toBe(true);
  });

  it('reconciles a group roll-up against its entities by the intercompany net', async () => {
    const res = await getPnl({ from: '2026-01-01', to: '2026-12-31', scope: 'group' });
    const group = res.results[0] as GroupPnlResult;

    // sum(entities) === group + eliminated. This is the identity that says
    // the group total did not double-count a dollar that moved between two
    // companies in the same group.
    const entitiesMargin = sumCents(group.entities.map((e) => centsFromDecimal(e.margin)));
    expect(entitiesMargin).toBe(
      centsFromDecimal(group.margin) + centsFromDecimal(group.eliminatedIntercompany),
    );
  });

  it('reports what the totals are still missing, over the same rows', async () => {
    const res = await getPnl({ from: '2026-01-01', to: '2026-12-31', scope: 'group' });

    // Not an assertion about a particular count — an assertion that the
    // caveats exist at all. A margin shown without them is a lower bound
    // wearing a margin's clothes.
    expect(res.workQueue).toBeDefined();
    expect(typeof res.workQueue.unresolvedChargebackCount).toBe('number');
    expect(typeof res.workQueue.unresolvedChargebackAmount).toBe('string');
  });

  it('returns a zero-valued period rather than an error when nothing was posted', async () => {
    const truckId = await makeTruck();
    const res = await getPnl({ from: '2030-01-01', to: '2030-01-31', scope: 'truck', truckId });

    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.revenue).toBe('0.00');
    expect(res.results[0]!.entryCount).toBe(0);
  });
});
