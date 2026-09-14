/**
 * The sheet-sync entry point — against a real Postgres.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { runSheetSync } from '@/db/repo/sheetSync';
import { getDocumentRows } from '@/db/repo/documents';
import { ENTITY_XTRACK_ID, ensureBaseFixtures } from './helpers';
import { dispatchFixture } from './fixtures';

beforeAll(async () => {
  await ensureBaseFixtures();
});

describe('runSheetSync', () => {
  it('runs the dispatch parser over sheet text and writes staging rows', async () => {
    const rawText = dispatchFixture(`SYNC-${Date.now()}-A`, '333.33');
    const result = await runSheetSync({
      purpose: 'revenue',
      rawText,
      fileName: 'Dispatch Sheet 2026 — sync 1',
      uploadedBy: 'scheduler',
    });

    expect(result.duplicateOf).toBeNull();
    expect(result.parseStatus).toBe('parsed');
    expect(result.rowsWritten).toBe(1);

    const rows = await getDocumentRows(result.documentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe('333.33');
    expect(rows[0]?.entityId).toBe(ENTITY_XTRACK_ID);
  });

  it('syncing the exact same sheet content twice is a no-op the second time', async () => {
    const rawText = dispatchFixture(`SYNC-${Date.now()}-B`, '444.44');
    const first = await runSheetSync({ purpose: 'revenue', rawText, fileName: 'sync-2', uploadedBy: 'scheduler' });
    const second = await runSheetSync({ purpose: 'revenue', rawText, fileName: 'sync-2', uploadedBy: 'scheduler' });

    expect(second.duplicateOf).toBe(first.documentId);
    expect(second.documentId).toBe(first.documentId);
    expect(second.rowsWritten).toBe(first.rowsWritten);

    const rows = await getDocumentRows(first.documentId);
    expect(rows).toHaveLength(1); // not doubled by the second sync
  });

  it('a sheet that fails to parse is recorded, not thrown past the caller', async () => {
    const result = await runSheetSync({
      purpose: 'expenses',
      rawText: 'this is not the expenses sheet at all',
      fileName: 'garbage-sync',
      uploadedBy: 'scheduler',
    });
    expect(result.parseStatus).toBe('failed');
    expect(result.parseError).toBeTruthy();
    expect(result.rowsWritten).toBe(0);
  });
});
