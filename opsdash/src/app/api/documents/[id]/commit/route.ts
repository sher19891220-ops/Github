/**
 * POST /api/documents/:id/commit — DATA-CONTRACT.md §6.
 *
 * All-or-nothing per document, and safe to press twice — see
 * src/db/repo/commit.ts for the atomicity and idempotency guarantees.
 */
import { NextResponse } from 'next/server';
import { badIdMessage, isUuid } from '@/lib/ids';
import { commitDocument, NonPostingDocumentError } from '@/db/repo/commit';
import { DocumentNotFoundError } from '@/db/repo/types';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: badIdMessage('documentId') }, { status: 400 });
  }

  let postedBy = 'unknown';
  try {
    const body: unknown = await request.json();
    if (body && typeof body === 'object' && 'postedBy' in body && typeof (body as { postedBy: unknown }).postedBy === 'string') {
      postedBy = (body as { postedBy: string }).postedBy;
    }
  } catch {
    // No body, or not JSON — postedBy defaults to 'unknown'. Not an error:
    // the contract does not require a body on this endpoint.
  }

  try {
    const result = await commitDocument(id, postedBy);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DocumentNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    // 422: the request is well-formed and the document exists — it is the
    // wrong kind of document to post. Distinguished from 500 so the screen
    // can explain rather than showing a server error for a correct refusal.
    if (err instanceof NonPostingDocumentError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    // Any other failure means the transaction rolled back — nothing was
    // committed and nothing was left half-marked. Surface it rather than
    // reporting a false success.
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
