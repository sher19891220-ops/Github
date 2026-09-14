/**
 * GET /api/reconciliation/:documentId -> { set: ReconciliationSet, summary: ReconSummary }
 *
 * A GET here opens a reconciliation run if the document has none. That is a
 * write on a read, which is normally wrong, and is right in this one case:
 * opening a reconciliation is a work-queue action, not a ledger posting, it
 * is idempotent under migration 008's partial unique index, and the
 * alternative — an explicit POST to open — puts a button in front of a
 * screen whose whole purpose is to show the work.
 */
import { NextResponse } from 'next/server';
import { badIdMessage, isUuid } from '@/lib/ids';
import { DocumentNotReconcilableError, getReconciliation } from '@/db/repo/reconciliation';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const { documentId } = await params;

  if (!isUuid(documentId)) {
    return NextResponse.json({ error: badIdMessage('documentId') }, { status: 400 });
  }
  const openedBy = new URL(request.url).searchParams.get('openedBy') ?? 'system';

  try {
    const result = await getReconciliation(documentId, openedBy);
    if (result === null) {
      return NextResponse.json({ error: `document ${documentId} not found` }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DocumentNotReconcilableError) {
      // 422, not 404 and not 500: the document exists and the request is
      // well formed, there is simply nothing in it to reconcile yet.
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
