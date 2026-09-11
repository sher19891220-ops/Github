/**
 * POST /api/sheet-sources/:id/sync — ingest a sheet's exported text.
 *
 * 409 when the sheet's columns moved. That is not a server error and not a
 * bad request: the request was fine and the sheet changed underneath it,
 * and the operator's next action is to look at the sheet, then re-baseline
 * deliberately if the new shape is correct.
 */
import { NextResponse } from 'next/server';
import { SheetLayoutChangedError, SheetSourceError, syncSheetSource } from '@/db/repo/sheetSource';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }
  if (typeof body.rawText !== 'string' || body.rawText.trim() === '') {
    return NextResponse.json({ error: 'rawText is required — the sheet export' }, { status: 400 });
  }
  const uploadedBy = typeof body.uploadedBy === 'string' && body.uploadedBy.trim() !== '' ? body.uploadedBy : 'sheet-sync';

  try {
    return NextResponse.json(await syncSheetSource(id, body.rawText, uploadedBy));
  } catch (err) {
    if (err instanceof SheetLayoutChangedError) {
      return NextResponse.json({ error: err.message, layoutChanged: true }, { status: 409 });
    }
    if (err instanceof SheetSourceError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
