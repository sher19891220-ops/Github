/**
 * PATCH /api/staging/:rowId — DATA-CONTRACT.md §6.
 *
 * body: Partial<StagingRowEdit> -> { row: StagingRow }
 *
 * `StagingRowEdit` is `@/contract/types`' definition (added by the UI
 * workstream; the API and UI now build to the same import). Validated with
 * zod before it ever reaches the repo layer: `z.string()` on amount/quantity
 * rejects a JSON number outright, which is where "money never crosses the
 * wire as a float" is actually enforced at this boundary.
 *
 * The contract type has no field for "who made this edit" — read from the
 * `x-reviewed-by` header instead of the body, so the strict body schema can
 * match `Partial<StagingRowEdit>` exactly.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateStagingRow } from '@/db/repo/stagingRows';

const stagingRowEditSchema = z
  .object({
    entityId: z.string().nullable().optional(),
    truckId: z.string().nullable().optional(),
    driverId: z.string().nullable().optional(),
    accrualDate: z.string().nullable().optional(),
    categoryId: z.string().nullable().optional(),
    amount: z.string().nullable().optional(),
    quantity: z.string().nullable().optional(),
    jurisdiction: z.string().nullable().optional(),
    reviewNotes: z.string().nullable().optional(),
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

  const reviewedBy = request.headers.get('x-reviewed-by') ?? 'unknown';
  const result = await updateStagingRow(rowId, parsed.data, reviewedBy);

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
