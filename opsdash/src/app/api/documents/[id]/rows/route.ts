/** GET /api/documents/:id/rows — DATA-CONTRACT.md §6. */
import { NextResponse } from 'next/server';
import { badIdMessage, isUuid } from '@/lib/ids';
import { getDocumentRows, getDocumentSummary } from '@/db/repo/documents';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: badIdMessage('documentId') }, { status: 400 });
  }
  const doc = await getDocumentSummary(id);
  if (!doc) return NextResponse.json({ error: `document ${id} not found` }, { status: 404 });
  const rows = await getDocumentRows(id);
  return NextResponse.json({ rows });
}
