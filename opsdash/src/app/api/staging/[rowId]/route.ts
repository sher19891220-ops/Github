/**
 * PATCH /api/staging/:rowId — DATA-CONTRACT.md §6.
 *
 * body: Partial<StagingRowEdit> -> { row: StagingRow }
 *
 * Validated with zod before it ever reaches the repo layer: `z.string()` on
 * amount/quantity rejects a JSON number outright, which is where "money
 * never crosses the wire as a float" is actually enforced at this boundary.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateStagingRow } from '@/db/repo/stagingRows';

const stagingRowEditSchema = z
  .object({
    reviewedPayload: z.record(z.string(), z.unknown()).nullable().optional(),
    entityId: z.string().nullable().optional(),
    truckId: z.string().nullable().optional(),
    driverId: z.string().nullable().optional(),
    accrualDate: z.string().nullable().optional(),
    categoryId: z.string().nullable().optional(),
    amount: z.string().nullable().optional(),
    quantity: z.string().nullable().optional(),
    jurisdiction: z.string().nullable().optional(),
    status: z.enum(['parsed', 'under_review', 'committed', 'rejected']).optional(),
    reviewNotes: z.string().nullable().optional(),
    reviewedBy: z.string().optional(),
  })
  .strict();

export async function PATCH(request: Request, context: { params: Promise<{ rowId: string }> }): Promise<Response> {
  const { rowId } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = stagingRowEditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid edit body', issues: parsed.error.issues }, { status: 422 });
  }

  const result = await updateStagingRow(rowId, parsed.data);

  if (!result.ok) {
    if (result.reason === 'not_found') {
      return NextResponse.json({ error: `staging row ${rowId} not found` }, { status: 404 });
    }
    if (result.reason === 'immutable') {
      return NextResponse.json({ error: result.message }, { status: 409 });
    }
    return NextResponse.json({ error: result.message }, { status: 422 });
  }

  return NextResponse.json({ row: result.row });
}
