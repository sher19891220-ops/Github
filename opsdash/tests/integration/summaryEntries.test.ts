/**
 * The P&L loader, against a real Postgres.
 *
 * The rollup engine's arithmetic is proven by unit tests. What only a real
 * database can prove is that the facts the engine refuses to guess actually
 * arrive — `account_nature` above all, because a missing one is not a blank
 * field on a screen, it is the prepaid registration payment counted on top
 * of the twelve monthly recognitions of the same money.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { createDocument, getDocumentRows } from '@/db/repo/documents';
import { commitDocument } from '@/db/repo/commit';
import { updateStagingRow } from '@/db/repo/stagingRows';
import { loadSummaryEntries } from '@/db/repo/summaryEntries';
import { summarizeTruck } from '@/engines/summary';
import { CATEGORY_MAINTENANCE, ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';
import { expensesFixture } from './fixtures';

beforeAll(async () => {
  await ensureBaseFixtures();
});

/** Posts one expense row and returns its ledger entry id. */
async function postCost(
  amount: string,
  dateMmDdYy: string,
  categoryId: string,
  truckId: string | null,
): Promise<{ entryId: string; unit: string }> {
  const unit = `SE${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
  const created = await createDocument({
    docType: 'maintenance',
    fileName: `summary-${unit}.txt`,
    mimeType: 'text/plain',
    bytes: Buffer.from(expensesFixture(unit, amount, 'company', dateMmDdYy), 'utf8'),
    uploadedBy: 'integration-test',
  });
  const [row] = await getDocumentRows(created.documentId);
  const edit = await updateStagingRow(row!.stagingRowId, {
    entityId: ENTITY_ZONE_ID,
    categoryId,
    ...(truckId !== null ? { truckId } : {}),
  });
  if (!edit.ok) throw new Error(`setup failed: ${JSON.stringify(edit)}`);
  const result = await commitDocument(created.documentId, 'tester');
  if (result.committed !== 1) throw new Error(`setup failed: ${JSON.stringify(result)}`);
  return { entryId: result.entryIds[0]!, unit };
}

async function makeTruck(number: string): Promise<string> {
  const rows = (await query(
    `INSERT INTO accounting.truck (unit_number) VALUES ($1) RETURNING truck_id`,
    [number],
  )) as unknown as { truck_id: string }[];
  return rows[0]!.truck_id;
}

describe('loadSummaryEntries', () => {
  it('carries the category facts the engine refuses to infer', async () => {
    const { entryId } = await postCost('412.55', '05.04.26', CATEGORY_MAINTENANCE, null);

    const entries = await loadSummaryEntries({ from: '2026-05-01', to: '2026-05-31' });
    const ours = entries.find((e) => e.entryId === entryId);

    expect(ours).toBeDefined();
    // Read off accounting.category, not inferred from the id string.
    expect(ours!.categoryGroup).toBe('maintenance');
    expect(ours!.accountNature).toBe('pnl');
    // And the migration 002/003/004 columns the general ledger reader omits.
    expect(ours!.chargedTo).toBe('company');
    expect(ours!.allocationBasis).toBe('actual');
    expect(ours!.unitType).toBeDefined();
    // Money arrives as an exact decimal string, never a JSON number.
    expect(ours!.amount).toBe('-412.55');
    expect(typeof ours!.amount).toBe('string');
  });

  it('marks a prepaid payment as a balance-sheet movement, so it never hits the P&L', async () => {
    const truckId = await makeTruck(`SE-PREPAID-${Date.now()}`);
    // The IRP invoice payment, booked as the prepaid asset it is...
    const prepaid = await postCost('-1879.98', '06.01.26', 'prepaid.registration', truckId);
    // ...and one month's recognition of that same money as a real cost.
    const recognized = await postCost('-156.67', '06.02.26', 'permit.irp', truckId);

    const entries = await loadSummaryEntries({
      from: '2026-06-01',
      to: '2026-06-30',
      truckId,
    });
    const prepaidRow = entries.find((e) => e.entryId === prepaid.entryId)!;
    const recognizedRow = entries.find((e) => e.entryId === recognized.entryId)!;

    expect(prepaidRow.accountNature).toBe('balance_sheet');
    expect(recognizedRow.accountNature).toBe('pnl');

    // The whole point, end to end: the truck's June cost is the month's
    // recognition only. Counting the payment too would double the year —
    // catastrophically unprofitable for a day, free for the rest of it.
    const june = summarizeTruck(entries, truckId, {
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
    });
    expect(june.companyCostTotal).toBe('156.67');
    // Excluded, not silently dropped: the stripped amount stays visible.
    expect(june.excludedBalanceSheetTotal).not.toBe('0.00');
  });

  it('restricts to the period it was asked for, on both ends', async () => {
    const truckId = await makeTruck(`SE-RANGE-${Date.now()}`);
    const inside = await postCost('-100.00', '07.15.26', CATEGORY_MAINTENANCE, truckId);
    const before = await postCost('-200.00', '06.30.26', CATEGORY_MAINTENANCE, truckId);
    const after = await postCost('-300.00', '08.01.26', CATEGORY_MAINTENANCE, truckId);

    const entries = await loadSummaryEntries({ from: '2026-07-01', to: '2026-07-31', truckId });
    const ids = entries.map((e) => e.entryId);

    expect(ids).toContain(inside.entryId);
    expect(ids).not.toContain(before.entryId);
    expect(ids).not.toContain(after.entryId);
  });
});
