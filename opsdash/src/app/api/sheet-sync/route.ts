/**
 * POST /api/sheet-sync — NOT in DATA-CONTRACT.md §6. This is the "sheet-sync
 * entry point" the task asked for, exposed as a route so it can be triggered
 * by a scheduled job or by hand; it is additive and does not change any of
 * the six fixed contract shapes.
 *
 * body: { purpose: 'revenue' | 'fuel' | 'expenses', rawText: string, fileName: string, uploadedBy: string }
 *
 * `rawText` is the sheet's exported pipe-table text (see src/db/repo/sheetSync.ts
 * for why this module does not itself call the Google Drive API).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runSheetSync } from '@/db/repo/sheetSync';

const sheetSyncSchema = z
  .object({
    purpose: z.enum(['revenue', 'fuel', 'expenses']),
    rawText: z.string().min(1),
    fileName: z.string().min(1),
    uploadedBy: z.string().min(1),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = sheetSyncSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid sync request', issues: parsed.error.issues }, { status: 422 });
  }

  try {
    const result = await runSheetSync(parsed.data);
    return NextResponse.json(result, { status: result.duplicateOf ? 200 : 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
