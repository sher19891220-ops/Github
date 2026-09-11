/**
 * `source_document` + staging-row persistence, against a real Postgres.
 * Run with `DATABASE_URL=$(npm run -s db:local) npx vitest run tests/integration`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createDocument, getDocumentRows, getDocumentSummary, listDocumentSummaries } from '@/db/repo/documents';
import { ENTITY_XTRACK_ID, ensureBaseFixtures, uniqueText, waitForParseStatus } from './helpers';
import { dispatchFixture } from './fixtures';

beforeAll(async () => {
  await ensureBaseFixtures();
});

describe('createDocument + getDocumentSummary/getDocumentRows', () => {
  it('parses a text revenue document synchronously and stages its rows', async () => {
    const text = dispatchFixture(`DOC-${Date.now()}-A`, '500.00') + uniqueText('# salt');
    const bytes = Buffer.from(text, 'utf8');

    const created = await createDocument({
      docType: 'revenue',
      fileName: 'dispatch-sync.txt',
      mimeType: 'text/plain',
      bytes,
      uploadedBy: 'integration-test',
    });

    expect(created.duplicateOf).toBeNull();

    const summary = await getDocumentSummary(created.documentId);
    expect(summary).not.toBeNull();
    expect(summary?.docType).toBe('revenue');
    expect(summary?.parseStatus).toBe('parsed');
    expect(summary?.parseError).toBeNull();
    expect(summary?.rowCount).toBe(1);

    const rows = await getDocumentRows(created.documentId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Money is a decimal string end to end, never a JS number.
    expect(typeof row.amount).toBe('string');
    expect(row.amount).toBe('500.00');
    expect(row.categoryId).toBe('revenue.linehaul');
    // The raw "XTRACK" marker was resolved through source_key_map to the
    // canonical entity id seeded in helpers.ts — never left as the raw string.
    expect(row.entityId).toBe(ENTITY_XTRACK_ID);
    // parsedPayload is exactly what the parser read; never touched here.
    expect((row.parsedPayload as Record<string, unknown>).amountRaw).toBe('$500.00');
    expect(row.reviewedPayload).toBeNull();
  });

  it('re-uploading byte-identical content is a no-op, not a second document', async () => {
    const text = dispatchFixture(`DOC-${Date.now()}-B`, '600.00');
    const bytes = Buffer.from(text, 'utf8');

    const first = await createDocument({
      docType: 'revenue',
      fileName: 'dispatch-sync.txt',
      mimeType: 'text/plain',
      bytes,
      uploadedBy: 'integration-test',
    });
    expect(first.duplicateOf).toBeNull();

    const second = await createDocument({
      docType: 'revenue',
      fileName: 'dispatch-sync-again.txt', // even a different file name
      mimeType: 'text/plain',
      bytes,
      uploadedBy: 'someone-else',
    });
    expect(second.duplicateOf).toBe(first.documentId);
    expect(second.documentId).toBe(first.documentId);
    expect(second.sha256).toBe(first.sha256);

    // Still exactly one row — the duplicate was never re-parsed.
    const rows = await getDocumentRows(first.documentId);
    expect(rows).toHaveLength(1);
  });

  it('stores unparseable content without crashing, and reports parse_status failed', async () => {
    const bytes = Buffer.from(uniqueText('not a dispatch sheet at all'), 'utf8');
    const created = await createDocument({
      docType: 'revenue',
      fileName: 'garbage.txt',
      mimeType: 'text/plain',
      bytes,
      uploadedBy: 'integration-test',
    });

    const summary = await getDocumentSummary(created.documentId);
    expect(summary?.parseStatus).toBe('failed');
    expect(summary?.parseError).toBeTruthy();
    expect(summary?.rowCount).toBe(0);
  });

  it('routes binary content to real extraction in the background, and reports why it failed once done', async () => {
    // A real PDF magic-number header on garbage bytes: this is not a valid
    // PDF, so real extraction (poppler's pdfinfo, invoked for real — never
    // mocked) genuinely fails on it, honestly, with its own reason. This is
    // the behavior change this fix makes: previously any non-text mime type
    // failed synchronously with "no text-extraction step exists" before
    // ever looking at the bytes; now it is routed to the same binary path
    // `parseBinaryDocument` uses and fails on what the bytes actually are.
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0x01, 0x02, ...Buffer.from(uniqueText('pdf'))]);
    const created = await createDocument({
      docType: 'maintenance',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      bytes,
      uploadedBy: 'integration-test',
    });

    // The upload call itself already returned above without waiting for
    // extraction — this is the "does not block on OCR-heavy work" contract.
    // Poll rather than assert on an immediate read, since parse_status
    // starts 'pending' and flips out of band.
    const finalStatus = await waitForParseStatus(async () => (await getDocumentSummary(created.documentId))?.parseStatus);
    expect(finalStatus).toBe('failed');

    const summary = await getDocumentSummary(created.documentId);
    expect(summary?.parseError).toBeTruthy();
    // Never the old, bytes-never-even-looked-at message.
    expect(summary?.parseError).not.toMatch(/no text-extraction step/);
    // Real extraction genuinely ran and genuinely failed on these bytes.
    expect(summary?.parseError).toMatch(/PDF/i);
    expect(summary?.rowCount).toBe(0);
  });

  it('an unsupported mime type still fails cleanly, never fabricating a parse', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, ...Buffer.from(uniqueText('mystery'))]);
    const created = await createDocument({
      docType: 'maintenance',
      fileName: 'mystery.dat',
      mimeType: 'application/octet-stream',
      bytes,
      uploadedBy: 'integration-test',
    });

    const finalStatus = await waitForParseStatus(async () => (await getDocumentSummary(created.documentId))?.parseStatus);
    expect(finalStatus).toBe('failed');
    const summary = await getDocumentSummary(created.documentId);
    expect(summary?.parseError).toBeTruthy();
    expect(summary?.rowCount).toBe(0);
  });

  it('returns null for a document that does not exist', async () => {
    const summary = await getDocumentSummary('00000000-0000-0000-0000-000000000000');
    expect(summary).toBeNull();
  });

  it('listDocumentSummaries includes newly-created documents with the full contract shape', async () => {
    const text = dispatchFixture(`DOC-${Date.now()}-C`, '700.00');
    const created = await createDocument({
      docType: 'revenue',
      fileName: 'for-listing.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from(text, 'utf8'),
      uploadedBy: 'integration-test',
    });

    const list = await listDocumentSummaries();
    const found = list.find((d) => d.documentId === created.documentId);
    expect(found).toBeDefined();
    expect(found?.fileName).toBe('for-listing.txt');
    expect(found?.sha256).toBe(created.sha256);
    expect(found?.duplicateOf).toBeNull();
    expect(typeof found?.uploadedAt).toBe('string');
  });
});
