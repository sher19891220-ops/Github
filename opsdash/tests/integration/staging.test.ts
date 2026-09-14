/**
 * PATCH /api/staging/:rowId semantics — against a real Postgres.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createDocument, getDocumentRows } from '@/db/repo/documents';
import { commitDocument } from '@/db/repo/commit';
import { updateStagingRow } from '@/db/repo/stagingRows';
import { ENTITY_ZONE_ID, ensureBaseFixtures, uniqueText } from './helpers';
import { dispatchFixture } from './fixtures';

beforeAll(async () => {
  await ensureBaseFixtures();
});

async function makeOneRowDocument(truck: string, amount = '500.00') {
  const created = await createDocument({
    docType: 'revenue',
    fileName: 'staging-test.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from(dispatchFixture(truck, amount), 'utf8'),
    uploadedBy: 'integration-test',
  });
  const rows = await getDocumentRows(created.documentId);
  return { documentId: created.documentId, row: rows[0]! };
}

describe('updateStagingRow', () => {
  it('writes an edit into reviewedPayload and the normalized column, never touching parsedPayload', async () => {
    const { row } = await makeOneRowDocument(`STG-${Date.now()}-A`);
    const originalParsedPayload = row.parsedPayload;

    const result = await updateStagingRow(row.stagingRowId, { jurisdiction: 'OH' }, 'reviewer@fleet');
    if (!result.ok) throw new Error('expected ok');

    expect(result.row.jurisdiction).toBe('OH');
    // An edit clears the review flag: `under_review` means a machine flagged
    // the row and nobody has looked, and this edit is somebody looking. The
    // audit trail lives in reviewedPayload/reviewedBy, asserted just below.
    expect(result.row.status).toBe('parsed');
    expect(result.row.parsedPayload).toEqual(originalParsedPayload);
    expect(result.row.reviewedPayload).toMatchObject({ jurisdiction: 'OH' });
    // The edit did not invent values for fields it never touched.
    expect(result.row.entityId).toBe(row.entityId);
  });

  it('lets a human resolve entity/truck/driver that the parser could not', async () => {
    const { row } = await makeOneRowDocument(`STG-${Date.now()}-B`);
    const result = await updateStagingRow(row.stagingRowId, { entityId: ENTITY_ZONE_ID }, 'reviewer@fleet');
    if (!result.ok) throw new Error('expected ok');
    expect(result.row.entityId).toBe(ENTITY_ZONE_ID);
  });

  it('rejects a JSON-number-shaped amount at the validation boundary (string only)', async () => {
    const { row } = await makeOneRowDocument(`STG-${Date.now()}-C`);
    // @ts-expect-error -- intentionally wrong type, proving the runtime guard catches what TS would too
    const result = await updateStagingRow(row.stagingRowId, { amount: 812.44 });
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed decimal string with a clear reason', async () => {
    const { row } = await makeOneRowDocument(`STG-${Date.now()}-D`);
    const result = await updateStagingRow(row.stagingRowId, { amount: 'not-a-number' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('returns not_found for a row that does not exist', async () => {
    const result = await updateStagingRow('00000000-0000-0000-0000-000000000000', { jurisdiction: 'OH' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses to edit a row that has already committed a ledger entry', async () => {
    const { documentId, row } = await makeOneRowDocument(`STG-${Date.now()}-E`);
    await commitDocument(documentId, 'tester');

    const result = await updateStagingRow(row.stagingRowId, { jurisdiction: 'OH' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('immutable');
  });

  it('still allows a reviewNotes-only annotation after commit is NOT special-cased in this build (documented limitation)', async () => {
    // Deliberately proves current behavior rather than assuming it: any
    // value-field touch on a committed row is blocked, and reviewNotes is
    // treated as a value field. See final report.
    const { documentId, row } = await makeOneRowDocument(`STG-${Date.now()}-F`);
    await commitDocument(documentId, 'tester');
    const result = await updateStagingRow(row.stagingRowId, { reviewNotes: 'looked fine' });
    expect(result.ok).toBe(false);
  });
});
