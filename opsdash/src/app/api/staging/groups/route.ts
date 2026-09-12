/**
 * GET /api/staging/groups?documentId= -> CategoryGroupsView
 *
 * The uncategorised rows of one document, grouped by a suggested category
 * and ordered by how much money is in each. See db/repo/categorise.ts for
 * why the response carries the row ids the operator is about to act on.
 */
import { NextResponse } from 'next/server';
import { getCategoryGroups } from '@/db/repo/categorise';
import { badIdMessage, isUuid } from '@/lib/ids';

export async function GET(request: Request): Promise<Response> {
  const documentId = new URL(request.url).searchParams.get('documentId');
  if (documentId === null) {
    return NextResponse.json({ error: 'documentId is required.' }, { status: 400 });
  }
  if (!isUuid(documentId)) {
    return NextResponse.json({ error: badIdMessage('documentId') }, { status: 400 });
  }
  try {
    return NextResponse.json(await getCategoryGroups(documentId));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
