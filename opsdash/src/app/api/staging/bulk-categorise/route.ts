/**
 * POST /api/staging/bulk-categorise
 *   { documentId, categoryId, stagingRowIds[], appliedBy, basis }
 *
 * Applies one category to the rows the operator was looking at. Takes
 * explicit row ids rather than a rule name on purpose — a bulk action must
 * be exactly the one that was reviewed, and re-deriving the set here would
 * let it drift between the screen rendering and the button being pressed.
 *
 * `basis` is required. A category applied to a few hundred rows at once
 * will be read back long after whoever pressed the button has forgotten
 * why, and the note goes onto every row it touches.
 */
import { NextResponse } from 'next/server';
import { applyCategoryToGroup, CategoriseError } from '@/db/repo/categorise';
import { badIdMessage, isUuid } from '@/lib/ids';

/** Enough for the largest real group (267 rows on the operator's export)
 *  with room to spare, and small enough that a runaway client cannot ask
 *  the database to lock the world. */
const MAX_ROWS = 5000;

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const documentId = String(body.documentId ?? '');
  if (!isUuid(documentId)) {
    return NextResponse.json({ error: badIdMessage('documentId') }, { status: 400 });
  }

  const ids = Array.isArray(body.stagingRowIds) ? body.stagingRowIds : null;
  if (ids === null || ids.length === 0) {
    return NextResponse.json({ error: 'stagingRowIds must be a non-empty array.' }, { status: 400 });
  }
  if (ids.length > MAX_ROWS) {
    return NextResponse.json({ error: `At most ${MAX_ROWS} rows in one call.` }, { status: 400 });
  }
  if (!ids.every((id) => typeof id === 'string' && isUuid(id))) {
    return NextResponse.json({ error: 'Every stagingRowId must be a UUID.' }, { status: 400 });
  }

  try {
    const result = await applyCategoryToGroup({
      documentId,
      categoryId: String(body.categoryId ?? ''),
      stagingRowIds: ids as string[],
      appliedBy: String(body.appliedBy ?? ''),
      basis: String(body.basis ?? ''),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof CategoriseError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
