/**
 * End-to-end proof that the actual Next.js route handlers (not just the
 * repo functions underneath them) work against a real Postgres — every
 * handler here is the exact function Next.js would invoke for that route.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GET as getDocuments, POST as postDocuments } from '@/app/api/documents/route';
import { GET as getDocument } from '@/app/api/documents/[id]/route';
import { GET as getDocumentRowsRoute } from '@/app/api/documents/[id]/rows/route';
import { POST as postCommit } from '@/app/api/documents/[id]/commit/route';
import { PATCH as patchStaging } from '@/app/api/staging/[rowId]/route';
import { GET as getLedger } from '@/app/api/ledger/route';
import { GET as getReference } from '@/app/api/reference/route';
import { ensureBaseFixtures } from './helpers';
import { dispatchFixture } from './fixtures';

beforeAll(async () => {
  await ensureBaseFixtures();
});

function multipartRequest(fields: Record<string, string | Blob>): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('http://localhost/api/documents', { method: 'POST', body: form });
}

describe('API routes, end to end against a real database', () => {
  it('POST /api/documents -> GET /:id -> GET /:id/rows -> PATCH /staging/:rowId -> POST /:id/commit -> GET /api/ledger', async () => {
    const text = dispatchFixture(`ROUTE-${Date.now()}`, '1234.56');
    const file = new File([text], 'route-test.txt', { type: 'text/plain' });

    const uploadReq = multipartRequest({ file, docType: 'revenue', uploadedBy: 'route-tester' });
    const uploadRes = await postDocuments(uploadReq);
    expect(uploadRes.status).toBe(201);
    const uploadBody = await uploadRes.json();
    expect(typeof uploadBody.documentId).toBe('string');
    expect(typeof uploadBody.sha256).toBe('string');
    expect(uploadBody.duplicateOf).toBeUndefined();
    const documentId: string = uploadBody.documentId;

    const getRes = await getDocument(new Request(`http://localhost/api/documents/${documentId}`), {
      params: Promise.resolve({ id: documentId }),
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody).toEqual({
      documentId,
      docType: 'revenue',
      parseStatus: 'parsed',
      parseError: null,
      rowCount: 1,
    });

    const rowsRes = await getDocumentRowsRoute(new Request(`http://localhost/api/documents/${documentId}/rows`), {
      params: Promise.resolve({ id: documentId }),
    });
    expect(rowsRes.status).toBe(200);
    const rowsBody = await rowsRes.json();
    expect(rowsBody.rows).toHaveLength(1);
    // Straight over JSON — still a decimal string, never a number.
    expect(rowsBody.rows[0].amount).toBe('1234.56');
    expect(typeof rowsBody.rows[0].amount).toBe('string');
    const rowId: string = rowsBody.rows[0].stagingRowId;

    const patchReq = new Request(`http://localhost/api/staging/${rowId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-reviewed-by': 'route-tester' },
      body: JSON.stringify({ jurisdiction: 'IL' }),
    });
    const patchRes = await patchStaging(patchReq, { params: Promise.resolve({ rowId }) });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.row.jurisdiction).toBe('IL');
    expect(patchBody.row.status).toBe('under_review');

    const commitReq = new Request(`http://localhost/api/documents/${documentId}/commit`, { method: 'POST' });
    const commitRes = await postCommit(commitReq, { params: Promise.resolve({ id: documentId }) });
    expect(commitRes.status).toBe(200);
    const commitBody = await commitRes.json();
    expect(commitBody.committed).toBe(1);
    expect(commitBody.rejected).toBe(0);
    expect(commitBody.entryIds).toHaveLength(1);

    // Pressing commit again over HTTP must not double-post.
    const commitAgainRes = await postCommit(new Request(commitReq.url, { method: 'POST' }), {
      params: Promise.resolve({ id: documentId }),
    });
    const commitAgainBody = await commitAgainRes.json();
    expect(commitAgainBody).toEqual(commitBody);

    const ledgerRes = await getLedger(new Request(`http://localhost/api/ledger?category=revenue.linehaul`));
    expect(ledgerRes.status).toBe(200);
    const ledgerBody = await ledgerRes.json();
    expect(ledgerBody.entries.some((e: { entryId: string }) => e.entryId === commitBody.entryIds[0])).toBe(true);
  });

  it('GET /api/documents/:id 404s on an unknown id', async () => {
    const id = '00000000-0000-0000-0000-000000000000';
    const res = await getDocument(new Request(`http://localhost/api/documents/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/documents 400s when the required docType field is missing', async () => {
    const file = new File(['x'], 'f.txt', { type: 'text/plain' });
    const res = await postDocuments(multipartRequest({ file }));
    expect(res.status).toBe(400);
  });

  it('PATCH /api/staging/:rowId 422s on a JSON-number amount (schema rejects it before the repo layer)', async () => {
    // A real-shaped id, so the body actually gets validated. This test
    // used to pass an id of "some-row" and started returning 400 when the
    // routes gained a UUID guard — it was asserting 422 while never
    // reaching the code that returns it.
    const rowId = '00000000-0000-4000-8000-0000000000ff';
    const patchReq = new Request(`http://localhost/api/staging/${rowId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 812.44 }),
    });
    const res = await patchStaging(patchReq, { params: Promise.resolve({ rowId }) });
    expect(res.status).toBe(422);
  });

  it('PATCH /api/staging/:rowId 400s on an id that is not a UUID', async () => {
    // Unguarded this reached Postgres, raised "invalid input syntax for
    // type uuid", and left as a 500 — the status that means the server is
    // broken, for a request that is merely malformed.
    const patchReq = new Request('http://localhost/api/staging/some-row', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '812.44' }),
    });
    const res = await patchStaging(patchReq, { params: Promise.resolve({ rowId: 'some-row' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must be a UUID/);
  });

  it('GET /api/documents (list) returns the richer contract DocumentSummary shape', async () => {
    const res = await getDocuments();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.documents)).toBe(true);
    if (body.documents.length > 0) {
      const d = body.documents[0];
      expect(d).toHaveProperty('fileName');
      expect(d).toHaveProperty('sha256');
      expect(d).toHaveProperty('uploadedAt');
    }
  });

  it('GET /api/reference returns option lists with isActive set', async () => {
    const res = await getReference();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entities)).toBe(true);
    expect(Array.isArray(body.categories)).toBe(true);
    for (const e of body.entities) expect(typeof e.isActive).toBe('boolean');
    for (const c of body.categories) {
      expect(typeof c.sign).toBe('number');
      expect(typeof c.categoryGroup).toBe('string');
    }
  });
});
