/** GET /api/documents/:id — DATA-CONTRACT.md §6. */
import { NextResponse } from 'next/server';
import { getDocumentSummary } from '@/db/repo/documents';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const doc = await getDocumentSummary(id);
  if (!doc) return NextResponse.json({ error: `document ${id} not found` }, { status: 404 });
  return NextResponse.json(doc);
}
