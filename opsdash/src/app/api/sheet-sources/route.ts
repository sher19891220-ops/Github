/**
 * GET  /api/sheet-sources — the registry.
 * POST /api/sheet-sources — register a sheet (idempotent per file + tab).
 */
import { NextResponse } from 'next/server';
import { SheetSourceError, listSheetSources, registerSheetSource, type SheetPurpose } from '@/db/repo/sheetSource';

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json({ sources: await listSheetSources() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }
  if (typeof body.driveFileId !== 'string' || typeof body.title !== 'string' || typeof body.purpose !== 'string') {
    return NextResponse.json({ error: 'driveFileId, title and purpose are required' }, { status: 400 });
  }
  try {
    const source = await registerSheetSource({
      driveFileId: body.driveFileId,
      tabName: typeof body.tabName === 'string' && body.tabName !== '' ? body.tabName : null,
      title: body.title,
      purpose: body.purpose as SheetPurpose,
      notes: typeof body.notes === 'string' ? body.notes : null,
    });
    return NextResponse.json({ source }, { status: 201 });
  } catch (err) {
    if (err instanceof SheetSourceError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
