/**
 * Chargeback decisions against a real Postgres.
 *
 * The point of these is that a decision is a *record*, not a column edit.
 * A driver disputing a deduction months later needs to see who decided,
 * when, on what split, and what the decision before it was.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { createDocument, getDocumentRows } from '@/db/repo/documents';
import { updateStagingRow } from '@/db/repo/stagingRows';
import {
  InvalidChargebackDecisionError,
  listChargebackRows,
  recordChargebackDecisions,
} from '@/db/repo/chargeback';
import { CATEGORY_MAINTENANCE, ENTITY_ZONE_ID, ensureBaseFixtures } from './helpers';
import { expensesFixture } from './fixtures';

beforeAll(async () => {
  await ensureBaseFixtures();
});

async function makeDriver(name: string): Promise<string> {
  const rows = (await query(
    `INSERT INTO accounting.driver (full_name) VALUES ($1) RETURNING driver_id`,
    [name],
  )) as unknown as { driver_id: string }[];
  return rows[0]!.driver_id;
}

/** One undecided cost row, ready for the queue. */
async function makeCostRow(amount: string, driverId: string | null): Promise<string> {
  const unit = `CB${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
  const created = await createDocument({
    docType: 'maintenance',
    fileName: `chargeback-${unit}.txt`,
    mimeType: 'text/plain',
    // The parser writes 'company' into charged_to from the Expense side
    // column; the test blanks it back to undecided, which is the state the
    // 713 real rows are actually in.
    bytes: Buffer.from(expensesFixture(unit, amount, 'company', '04.15.26'), 'utf8'),
    uploadedBy: 'integration-test',
  });
  const [row] = await getDocumentRows(created.documentId);
  const edit = await updateStagingRow(row!.stagingRowId, {
    entityId: ENTITY_ZONE_ID,
    categoryId: CATEGORY_MAINTENANCE,
    ...(driverId !== null ? { driverId } : {}),
  });
  if (!edit.ok) throw new Error(`setup failed: ${JSON.stringify(edit)}`);

  await query(`UPDATE accounting.staging_row SET charged_to = NULL WHERE staging_row_id = $1`, [
    row!.stagingRowId,
  ]);
  return row!.stagingRowId;
}

function decision(over: Partial<Parameters<typeof recordChargebackDecisions>[1]> = {}) {
  return {
    chargedTo: 'company' as const,
    splitRatio: null,
    note: null,
    decidedBy: 'controller@fleet',
    decidedAt: new Date().toISOString(),
    ...over,
  };
}

describe('the chargeback queue', () => {
  it('offers only undecided costs, and never revenue', async () => {
    const rowId = await makeCostRow('300.00', null);
    const open = await listChargebackRows({ status: 'open', limit: 2000 });

    expect(open.some((r) => r.costRowId === rowId)).toBe(true);
    // Every row in the queue is a cost. A chargeback question does not
    // arise for revenue, and offering it as a choice invites the answer.
    expect(open.every((r) => r.amount.startsWith('-'))).toBe(true);
    expect(open.every((r) => r.chargedTo === 'unknown')).toBe(true);
  });

  it('records who decided and when, and drops the row out of the open queue', async () => {
    const rowId = await makeCostRow('410.00', null);

    const [updated] = await recordChargebackDecisions([rowId], decision());
    expect(updated!.chargedTo).toBe('company');
    expect(updated!.decision?.decidedBy).toBe('controller@fleet');
    expect(updated!.decision?.decidedAt).not.toBe('');

    const stillOpen = await listChargebackRows({ status: 'open', limit: 2000 });
    expect(stillOpen.some((r) => r.costRowId === rowId)).toBe(false);
  });

  it('applies a bulk decision to exactly the named rows and to no other', async () => {
    const a = await makeCostRow('111.00', null);
    const b = await makeCostRow('222.00', null);
    const bystander = await makeCostRow('333.00', null);

    const updated = await recordChargebackDecisions([a, b], decision({ note: 'shop error, ours' }));
    expect(updated.map((r) => r.costRowId).sort()).toEqual([a, b].sort());

    const open = await listChargebackRows({ status: 'open', limit: 2000 });
    expect(open.some((r) => r.costRowId === bystander)).toBe(true);
  });

  it('keeps the superseded decision so a disputed charge stays readable', async () => {
    const driverId = await makeDriver(`Disputing Driver ${randomUUID()}`);
    const rowId = await makeCostRow('500.00', driverId);

    await recordChargebackDecisions([rowId], decision({ chargedTo: 'driver', note: 'driver damage' }));
    const [after] = await recordChargebackDecisions([rowId], decision({ note: 'reversed on appeal' }));

    // The column follows the latest decision...
    expect(after!.chargedTo).toBe('company');
    expect(after!.decision?.note).toBe('reversed on appeal');

    // ...and the earlier one is still on file, named by what replaced it.
    const chain = (await query(
      `SELECT charged_to, note, supersedes_id FROM accounting.chargeback_decision
        WHERE staging_row_id = $1 ORDER BY decided_at`,
      [rowId],
    )) as unknown as { charged_to: string; note: string | null; supersedes_id: string | null }[];
    expect(chain).toHaveLength(2);
    expect(chain[0]!.charged_to).toBe('driver');
    expect(chain[0]!.supersedes_id).toBeNull();
    expect(chain[1]!.charged_to).toBe('company');
    expect(chain[1]!.supersedes_id).not.toBeNull();
  });

  it('refuses a split with no ratio — that is a deferral, not a decision', async () => {
    const driverId = await makeDriver(`Split Driver ${randomUUID()}`);
    const rowId = await makeCostRow('600.00', driverId);

    await expect(
      recordChargebackDecisions([rowId], decision({ chargedTo: 'split', splitRatio: null })),
    ).rejects.toBeInstanceOf(InvalidChargebackDecisionError);
  });

  it('refuses to charge a driver on a row that names none', async () => {
    const rowId = await makeCostRow('700.00', null);

    await expect(
      recordChargebackDecisions([rowId], decision({ chargedTo: 'driver' })),
    ).rejects.toBeInstanceOf(InvalidChargebackDecisionError);

    // And nothing was written — a rejected decision leaves no trace on the row.
    const open = await listChargebackRows({ status: 'open', limit: 2000 });
    expect(open.some((r) => r.costRowId === rowId)).toBe(true);
  });

  it('accepts a split that carries a percentage, and reads it back', async () => {
    const driverId = await makeDriver(`Sharing Driver ${randomUUID()}`);
    const rowId = await makeCostRow('800.00', driverId);

    const [updated] = await recordChargebackDecisions(
      [rowId],
      decision({
        chargedTo: 'split',
        splitRatio: { kind: 'percentage', driverShare: '60.000' },
        note: 'driver bears 60%',
      }),
    );
    expect(updated!.chargedTo).toBe('split');
    expect(updated!.decision?.splitRatio).toEqual({ kind: 'percentage', driverShare: '60.000' });
  });

  it('refuses a percentage outside the open interval', async () => {
    const driverId = await makeDriver(`Impossible Driver ${randomUUID()}`);
    const rowId = await makeCostRow('900.00', driverId);

    await expect(
      recordChargebackDecisions(
        [rowId],
        decision({ chargedTo: 'split', splitRatio: { kind: 'percentage', driverShare: '100' } }),
      ),
    ).rejects.toBeInstanceOf(InvalidChargebackDecisionError);
  });

  it('names the row it could not find rather than failing silently', async () => {
    await expect(
      recordChargebackDecisions(['00000000-0000-4000-8000-0000000000fe'], decision()),
    ).rejects.toThrow(/not found/);
  });
});
