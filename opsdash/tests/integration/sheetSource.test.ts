/**
 * The sheet registry and its guard, against a real Postgres.
 *
 * The behaviour worth proving is not that a sync writes rows — the
 * document pipeline already has tests for that. It is that a sync
 * *refuses* when the sheet's columns move, because the alternative is
 * plausible wrong numbers written under a green status.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import {
  SheetLayoutChangedError,
  SheetSourceError,
  listSheetSources,
  rebaselineHeader,
  registerSheetSource,
  setSheetActive,
  syncSheetSource,
} from '@/db/repo/sheetSource';
import { ensureBaseFixtures } from './helpers';

beforeAll(async () => {
  await ensureBaseFixtures();
});

const HEADER = '| Unit | Issued To | Unit Type | Cost type | Date | $ used | Expense side | Details |';

/** A distinct body each time: the document path is content-addressed, so
 *  identical text is a deliberate no-op rather than a second sync. */
function sheet(header = HEADER): string {
  return `${header}\n| 9005 | Some Driver | truck | Repair | 04.15.26 | $250.00 | company | ${randomUUID()} |\n`;
}

async function register(purpose: Parameters<typeof registerSheetSource>[0]['purpose'] = 'maintenance_cost') {
  return registerSheetSource({
    driveFileId: `drive-${randomUUID()}`,
    tabName: 'Sheet1',
    title: `Test sheet ${randomUUID().slice(0, 8)}`,
    purpose,
  });
}

describe('registerSheetSource', () => {
  it('is idempotent for the same file and tab', async () => {
    const driveFileId = `drive-${randomUUID()}`;
    const first = await registerSheetSource({ driveFileId, tabName: 'Sheet1', title: 'A', purpose: 'fuel' });
    const second = await registerSheetSource({ driveFileId, tabName: 'Sheet1', title: 'A renamed', purpose: 'fuel' });

    // One source, not two drifting apart and syncing the same rows under
    // different provenance.
    expect(second.sheetSourceId).toBe(first.sheetSourceId);
    expect(second.title).toBe('A renamed');
  });

  it('refuses a sheet with nothing to sync from', async () => {
    await expect(
      registerSheetSource({ driveFileId: '  ', title: 'X', purpose: 'fuel' }),
    ).rejects.toBeInstanceOf(SheetSourceError);
  });

  it('registers a purpose no parser reads yet, and says it is not syncable', async () => {
    // The registry is allowed to know about a sheet before a parser exists;
    // saying so beats a sync that quietly writes nothing.
    const s = await register('truck_status');
    expect(s.syncable).toBe(false);

    const listed = (await listSheetSources()).find((x) => x.sheetSourceId === s.sheetSourceId)!;
    expect(listed.syncable).toBe(false);
  });
});

describe('syncSheetSource', () => {
  it('baselines the layout on the first sync', async () => {
    const s = await register();
    const r = await syncSheetSource(s.sheetSourceId, sheet(), 'tester');

    expect(r.baselined).toBe(true);
    expect(r.parseStatus).toBe('parsed');
    expect(r.rowsWritten).toBeGreaterThan(0);

    const after = (await listSheetSources()).find((x) => x.sheetSourceId === s.sheetSourceId)!;
    expect(after.lastSyncStatus).toBe('ok');
    expect(after.expectedHeader).toContain('expense side');
  });

  it('accepts an unchanged sheet on the second sync', async () => {
    const s = await register();
    await syncSheetSource(s.sheetSourceId, sheet(), 'tester');
    const second = await syncSheetSource(s.sheetSourceId, sheet(), 'tester');

    expect(second.baselined).toBe(false);
    expect(second.parseStatus).toBe('parsed');
  });

  it('refuses a sheet with a column inserted, and records why', async () => {
    const s = await register();
    await syncSheetSource(s.sheetSourceId, sheet(), 'tester');

    const shifted = '| Unit | Issued To | Unit Type | Cost type | Date | Vendor | $ used | Expense side | Details |';
    await expect(syncSheetSource(s.sheetSourceId, sheet(shifted), 'tester')).rejects.toBeInstanceOf(
      SheetLayoutChangedError,
    );

    const after = (await listSheetSources()).find((x) => x.sheetSourceId === s.sheetSourceId)!;
    expect(after.lastSyncStatus).toBe('layout_changed');
    expect(after.lastSyncError).toMatch(/added "vendor"/i);
    // And the baseline is untouched, so fixing the sheet resumes syncing.
    expect(after.expectedHeader).not.toContain('vendor');
  });

  it('writes nothing at all when it refuses', async () => {
    const s = await register();
    await syncSheetSource(s.sheetSourceId, sheet(), 'tester');

    const before = (await query(
      `SELECT count(*)::int AS n FROM accounting.source_document`,
    )) as unknown as { n: number }[];

    const reordered = '| Unit | Issued To | Unit Type | Cost type | Date | Expense side | $ used | Details |';
    await expect(syncSheetSource(s.sheetSourceId, sheet(reordered), 'tester')).rejects.toThrow();

    const after = (await query(
      `SELECT count(*)::int AS n FROM accounting.source_document`,
    )) as unknown as { n: number }[];

    // The header is checked before a document row exists. Otherwise every
    // refused sync would leave an unparseable artifact on the documents
    // screen.
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('will not sync a source that has been switched off', async () => {
    const s = await register();
    await setSheetActive(s.sheetSourceId, false);
    await expect(syncSheetSource(s.sheetSourceId, sheet(), 'tester')).rejects.toBeInstanceOf(
      SheetSourceError,
    );
  });

  it('will not sync a purpose nothing parses', async () => {
    const s = await register('truck_status');
    await expect(syncSheetSource(s.sheetSourceId, sheet(), 'tester')).rejects.toBeInstanceOf(
      SheetSourceError,
    );
  });
});

describe('rebaselineHeader', () => {
  it('accepts a new layout deliberately, and records who confirmed it', async () => {
    const s = await register();
    await syncSheetSource(s.sheetSourceId, sheet(), 'tester');

    const shifted = '| Unit | Issued To | Unit Type | Cost type | Date | Vendor | $ used | Expense side | Details |';
    await expect(syncSheetSource(s.sheetSourceId, sheet(shifted), 'tester')).rejects.toThrow();

    const rebaselined = await rebaselineHeader(s.sheetSourceId, sheet(shifted), 'controller@fleet');
    expect(rebaselined.expectedHeader).toContain('vendor');
    // Who accepted the change is on the record, because the guard being
    // escapable silently is the same as not having one.
    expect(rebaselined.notes).toMatch(/controller@fleet/);

    // And syncing works again on the new shape.
    const resumed = await syncSheetSource(s.sheetSourceId, sheet(shifted), 'tester');
    expect(resumed.parseStatus).toBe('parsed');
  });

  it('refuses to re-baseline without a name', async () => {
    const s = await register();
    await expect(rebaselineHeader(s.sheetSourceId, sheet(), '   ')).rejects.toBeInstanceOf(
      SheetSourceError,
    );
  });
});
