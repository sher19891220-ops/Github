/**
 * POST /api/sheet-sources/:id/rebaseline — deliberately accept a new layout.
 *
 * The guard has to be escapable, because columns legitimately change. It
 * must not be escapable by accident, so this is a separate action that
 * records who confirmed it.
 */
import { NextResponse } from 'next/server';
import { SheetSourceError, rebaselineHeader } from '@/db/repo/sheetSource';

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
  if (typeof body.rawText !== 'string' || typeof body.confirmedBy !== 'string') {
    return NextResponse.json(
      { error: 'rawText and confirmedBy are required — accepting a new layout names who accepted it' },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({ source: await rebaselineHeader(id, body.rawText, body.confirmedBy) });
  } catch (err) {
    if (err instanceof SheetSourceError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
