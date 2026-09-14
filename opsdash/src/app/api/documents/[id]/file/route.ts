/**
 * GET /api/documents/:id/file — the original bytes somebody uploaded.
 *
 * This is the endpoint the whole provenance claim depends on, and until now
 * it did not exist. `getBlob` had no callers: bytes were being stored and
 * there was no way to ask for them back. "Every number traces to a source
 * document" was true of the database and untestable in the product.
 *
 * Authorisation is the middleware's, not this file's — `/api/documents` is
 * already in the read matrix for the roles that may see documents, and a
 * second check here would be a second place to get it wrong.
 *
 * A missing blob returns 410 Gone rather than 404 Not Found, and the two
 * mean different things to whoever is reading: 404 is "no such document",
 * 410 is "this document is real, its ledger entries are valid, and the file
 * itself has to be re-uploaded". Telling those apart is the difference
 * between an accountant re-uploading a statement and an accountant
 * wondering whether the entry was ever real.
 */
import { NextResponse } from 'next/server';
import { badIdMessage, isUuid } from '@/lib/ids';
import { getDocumentSummary, getDocumentFileMeta } from '@/db/repo/documents';
import { BlobNotFoundError, getBlob } from '@/db/repo/blobStore';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: badIdMessage('documentId') }, { status: 400 });
  }

  const doc = await getDocumentSummary(id);
  if (!doc) return NextResponse.json({ error: `document ${id} not found` }, { status: 404 });

  const meta = await getDocumentFileMeta(id);
  if (!meta) return NextResponse.json({ error: `document ${id} not found` }, { status: 404 });

  let bytes: Buffer;
  try {
    bytes = await getBlob(meta.storageKey);
  } catch (err) {
    if (err instanceof BlobNotFoundError) {
      return NextResponse.json({ error: err.message, documentId: id, fileName: meta.fileName }, { status: 410 });
    }
    throw err;
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': meta.mimeType || 'application/octet-stream',
      // `inline` so a PDF opens beside the ledger entry rather than landing
      // in a downloads folder; the filename is still offered for saving.
      // Quoted and stripped of quotes/newlines: the name comes from an
      // uploaded file, which is to say from outside.
      'Content-Disposition': `inline; filename="${meta.fileName.replace(/["\r\n]/g, '')}"`,
      'Content-Length': String(bytes.byteLength),
      // The bytes are content-addressed and immutable. Caching them is safe
      // and it is private data, so private caching only.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
