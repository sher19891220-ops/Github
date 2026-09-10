/**
 * `POST /api/documents/:id/commit` — atomicity, idempotency, provenance and
 * per-row rejection, proven against a real Postgres (readiness criteria 2-5).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/db/pool';
import { createDocument, getDocumentRows, getDocumentSummary } from '@/db/repo/documents';
import { commitDocument } from '@/db/repo/commit';
import { updateStagingRow } from '@/db/repo/stagingRows';
import { listLedgerEntries } from '@/db/repo/ledger';
import { CATEGORY_REVENUE, ENTITY_XTRACK_ID, ensureBaseFixtures } from './helpers';
import { dispatchFixture } from './fixtures';

beforeAll(async () => {
  await ensureBaseFixtures();
});

async function ledgerCountForDocument(documentId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM accounting.ledger_entry WHERE source_document_id = $1`,
    [documentId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function stagingStatusCounts(documentId: string): Promise<Record<string, number>> {
  const rows = await query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::int AS n FROM accounting.staging_row WHERE document_id = $1 GROUP BY status`,
    [documentId],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

describe('commitDocument — happy path and provenance', () => {
  it('posts a ledger entry carrying full document + staging provenance, amount as an exact decimal string', async () => {
    const created = await createDocument({
      docType: 'revenue',
      fileName: 'commit-happy.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from(dispatchFixture(`COMMIT-${Date.now()}-A`, '1879.98'), 'utf8'),
      uploadedBy: 'integration-test',
    });
    const [row] = await getDocumentRows(created.documentId);

    const result = await commitDocument(created.documentId, 'controller@fleet');
    expect(result.committed).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.entryIds).toHaveLength(1);

    const entries = await listLedgerEntries({});
    const entry = entries.find((e) => e.entryId === result.entryIds[0]);
    expect(entry).toBeDefined();
    // NUMERIC round-trip: 1879.98 in, "1879.98" back out, still a string.
    expect(entry?.amount).toBe('1879.98');
    expect(typeof entry?.amount).toBe('string');
    expect(entry?.entityId).toBe(ENTITY_XTRACK_ID);
    expect(entry?.categoryId).toBe(CATEGORY_REVENUE);
    expect(entry?.driverClass).toBe('unassigned'); // no driver resolved
    expect(entry?.provenance).toEqual({
      kind: 'document',
      sourceDocumentId: created.documentId,
      stagingRowId: row?.stagingRowId,
    });
    expect(entry?.postedBy).toBe('controller@fleet');
  });
});

describe('commitDocument — idempotency (readiness criterion 2)', () => {
  it('posting twice produces exactly one ledger entry and reports the same totals both times', async () => {
    const created = await createDocument({
      docType: 'revenue',
      fileName: 'commit-idempotent.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from(dispatchFixture(`COMMIT-${Date.now()}-B`, '250.00'), 'utf8'),
      uploadedBy: 'integration-test',
    });

    const first = await commitDocument(created.documentId, 'controller@fleet');
    const second = await commitDocument(created.documentId, 'controller@fleet');

    expect(second).toEqual(first);
    expect(first.committed).toBe(1);

    // The database, not just the reported counts, proves there is one set
    // of entries — the ux_ledger_staging_once index made double-posting
    // impossible, and this asserts it actually held.
    expect(await ledgerCountForDocument(created.documentId)).toBe(1);
  });
});

describe('commitDocument — atomicity (readiness criterion 3)', () => {
  it('a failure mid-batch rolls back every insert and every staging-row status change in that call', async () => {
    // Two valid truck-weeks in one document (two separate uploads merged is
    // not how the parser works, so this uses two independently-created
    // one-row documents committed as if they were one batch would be
    // artificial; instead this proves the mechanism directly: a real
    // two-row document, forced to fail after its first row commits.
    const text =
      dispatchFixture(`ATOMIC-${Date.now()}-A`, '100.00') +
      dispatchFixture(`ATOMIC-${Date.now()}-B`, '200.00').split('\n')[1] + '\n';
    const created = await createDocument({
      docType: 'revenue',
      fileName: 'commit-atomic.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from(text, 'utf8'),
      uploadedBy: 'integration-test',
    });
    const rowsBefore = await getDocumentRows(created.documentId);
    expect(rowsBefore.length).toBe(2);

    await expect(
      commitDocument(created.documentId, 'controller@fleet', { __testThrowAfter: 1 }),
    ).rejects.toThrow(/injected mid-batch failure/);

    // Nothing committed: zero ledger rows, zero staging rows flipped.
    expect(await ledgerCountForDocument(created.documentId)).toBe(0);
    const counts = await stagingStatusCounts(created.documentId);
    expect(counts.committed ?? 0).toBe(0);
    expect(counts.rejected ?? 0).toBe(0);

    // And a clean, non-throwing commit afterwards still works and commits both.
    const result = await commitDocument(created.documentId, 'controller@fleet');
    expect(result.committed).toBe(2);
    expect(await ledgerCountForDocument(created.documentId)).toBe(2);
  });
});

describe('commitDocument — rejection of rows missing required fields (readiness criterion 5)', () => {
  it('rejects with a reason instead of guessing, and never posts a ledger row for that staging row', async () => {
    const created = await createDocument({
      docType: 'revenue',
      fileName: 'commit-missing-field.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from(dispatchFixture(`COMMIT-${Date.now()}-C`, '400.00'), 'utf8'),
      uploadedBy: 'integration-test',
    });
    const [row] = await getDocumentRows(created.documentId);

    // The parser left entityId resolved (XTRACK); blank it out so this row
    // is genuinely missing a required field, exactly the case the contract
    // requires be rejected rather than defaulted.
    const edited = await updateStagingRow(row!.stagingRowId, { entityId: null });
    if (!edited.ok) throw new Error('setup failed');

    const result = await commitDocument(created.documentId, 'controller@fleet');
    expect(result.committed).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.entryIds).toHaveLength(0);
    expect(await ledgerCountForDocument(created.documentId)).toBe(0);

    const rows = await getDocumentRows(created.documentId);
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.reviewNotes).toMatch(/REJECTED: missing required field\(s\): entityId/);
  });

  it('returns document-not-found for a commit on an unknown document id', async () => {
    await expect(commitDocument('00000000-0000-0000-0000-000000000000', 'x')).rejects.toThrow(/not found/);
  });
});

describe('commitDocument — parse_status reflects staging state independent of commit', () => {
  it('committing does not change the document parse_status', async () => {
    const created = await createDocument({
      docType: 'revenue',
      fileName: 'commit-parse-status.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from(dispatchFixture(`COMMIT-${Date.now()}-D`, '900.00'), 'utf8'),
      uploadedBy: 'integration-test',
    });
    await commitDocument(created.documentId, 'controller@fleet');
    const summary = await getDocumentSummary(created.documentId);
    expect(summary?.parseStatus).toBe('parsed');
  });
});
