/**
 * Provenance, end to end: bytes uploaded must come back out.
 *
 * This is the claim the whole build rests on — "every number traces to a
 * source document" — and until this file existed nothing tested it, because
 * nothing retrieved a document at all. `getBlob` had no callers. Bytes went
 * in, a storage key was recorded, and the only proof the file was still
 * there was that nobody had asked.
 *
 * Run with `DATABASE_URL=$(npm run -s db:local) npx vitest run tests/integration`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createDocument, getDocumentFileMeta } from '@/db/repo/documents';
import { BlobNotFoundError, getBlob, hasBlob, keyFor } from '@/db/repo/blobStore';
import { ensureBaseFixtures, uniqueText } from './helpers';
import { dispatchFixture } from './fixtures';

beforeAll(async () => {
  await ensureBaseFixtures();
});

async function upload(label: string) {
  const text = dispatchFixture(`BYTES-${label}-${Date.now()}`, '123.45') + uniqueText('# salt');
  const bytes = Buffer.from(text, 'utf8');
  const created = await createDocument({
    docType: 'revenue',
    fileName: `${label}.txt`,
    mimeType: 'text/plain',
    bytes,
    uploadedBy: 'integration-test',
  });
  return { created, bytes };
}

describe('an uploaded document can be produced again', () => {
  it('returns the exact bytes that were uploaded', async () => {
    const { created, bytes } = await upload('roundtrip');
    const meta = await getDocumentFileMeta(created.documentId);
    expect(meta).not.toBeNull();

    const back = await getBlob(meta!.storageKey);
    // Byte-for-byte, not "parses the same". A statement that comes back
    // subtly altered is worse than one that does not come back at all.
    expect(back.equals(bytes)).toBe(true);
    expect(createHash('sha256').update(back).digest('hex')).toBe(created.sha256);
  });

  it('records the metadata needed to serve it back with the right name and type', async () => {
    const { created, bytes } = await upload('metadata');
    const meta = await getDocumentFileMeta(created.documentId);
    expect(meta!.fileName).toBe('metadata.txt');
    expect(meta!.mimeType).toBe('text/plain');
    expect(meta!.byteSize).toBe(bytes.byteLength);
    expect(meta!.sha256).toBe(created.sha256);
  });

  it('keys storage by content, so the key is derivable from the hash alone', async () => {
    const { created } = await upload('addressing');
    const meta = await getDocumentFileMeta(created.documentId);
    expect(meta!.storageKey).toBe(keyFor(created.sha256));
  });

  it('stores one copy when the same file is uploaded twice', async () => {
    const { created, bytes } = await upload('dedupe');
    const again = await createDocument({
      docType: 'revenue',
      fileName: 'a-different-name.txt',
      mimeType: 'text/plain',
      bytes,
      uploadedBy: 'someone-else',
    });
    expect(again.duplicateOf).toBe(created.documentId);
    expect(again.sha256).toBe(created.sha256);
    expect((await getBlob(keyFor(created.sha256))).equals(bytes)).toBe(true);
  });

  it('returns null metadata for a document that does not exist', async () => {
    expect(await getDocumentFileMeta('00000000-0000-4000-8000-0000000000ff')).toBeNull();
  });
});

describe('a document whose stored copy is gone', () => {
  it('is reported as missing rather than as an unexplained failure', async () => {
    // Exactly the state every document was left in by the old temp-directory
    // store after a deploy: the row is intact, the bytes are not.
    const orphanKey = keyFor('f'.repeat(64));
    expect(await hasBlob(orphanKey)).toBe(false);
    await expect(getBlob(orphanKey)).rejects.toThrow(BlobNotFoundError);
  });

  it('says the ledger entries are still good, because they are', async () => {
    const err = await getBlob(keyFor('e'.repeat(64))).catch((e) => e);
    expect(err).toBeInstanceOf(BlobNotFoundError);
    expect(err.message).toMatch(/ledger entries are still valid/);
    expect(err.message).toMatch(/blobs:check/);
  });
});
