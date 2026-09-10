/**
 * `GET /api/ledger` filtering — against a real Postgres.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createDocument, getDocumentRows } from '@/db/repo/documents';
import { commitDocument } from '@/db/repo/commit';
import { updateStagingRow } from '@/db/repo/stagingRows';
import { listLedgerEntries } from '@/db/repo/ledger';
import { CATEGORY_REVENUE, ENTITY_ZONE_ID, ENTITY_XTRACK_ID, ensureBaseFixtures } from './helpers';
import { dispatchFixture } from './fixtures';

beforeAll(async () => {
  await ensureBaseFixtures();
});

async function commitOneRow(truck: string, amount: string, entityId?: string) {
  const created = await createDocument({
    docType: 'revenue',
    fileName: 'ledger-filter-test.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from(dispatchFixture(truck, amount), 'utf8'),
    uploadedBy: 'integration-test',
  });
  if (entityId) {
    const [row] = await getDocumentRows(created.documentId);
    await updateStagingRow(row!.stagingRowId, { entityId });
  }
  const result = await commitDocument(created.documentId, 'tester');
  return { documentId: created.documentId, entryId: result.entryIds[0]! };
}

describe('listLedgerEntries filters', () => {
  it('filters by entity, category and accrual_date range consistently', async () => {
    const marker = `LEDGERFILT-${Date.now()}`;
    const zoneEntry = await commitOneRow(`${marker}-Z`, '111.11', ENTITY_ZONE_ID);
    const xtrackEntry = await commitOneRow(`${marker}-X`, '222.22', ENTITY_XTRACK_ID);

    const zoneOnly = await listLedgerEntries({ entityId: ENTITY_ZONE_ID });
    expect(zoneOnly.some((e) => e.entryId === zoneEntry.entryId)).toBe(true);
    expect(zoneOnly.some((e) => e.entryId === xtrackEntry.entryId)).toBe(false);

    const byCategory = await listLedgerEntries({ categoryId: CATEGORY_REVENUE });
    expect(byCategory.some((e) => e.entryId === zoneEntry.entryId)).toBe(true);
    expect(byCategory.some((e) => e.entryId === xtrackEntry.entryId)).toBe(true);

    // Both fixture rows post on 2026-01-05 (Monday of the fixture's header week).
    const inRange = await listLedgerEntries({ from: '2026-01-01', to: '2026-01-31' });
    expect(inRange.some((e) => e.entryId === zoneEntry.entryId)).toBe(true);

    const outOfRange = await listLedgerEntries({ from: '2020-01-01', to: '2020-01-31' });
    expect(outOfRange.some((e) => e.entryId === zoneEntry.entryId)).toBe(false);
  });

  it('every returned amount is a decimal string, never a JS number', async () => {
    const entries = await listLedgerEntries({ categoryId: CATEGORY_REVENUE });
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e.amount).toBe('string');
      if (e.quantity !== null) expect(typeof e.quantity).toBe('string');
    }
  });
});
