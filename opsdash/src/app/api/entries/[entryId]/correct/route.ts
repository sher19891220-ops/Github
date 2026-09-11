/**
 * POST /api/entries/:entryId/correct — fix a posted figure.
 *
 * The ledger is append-only, so this is not an edit: it posts a reversing
 * entry that cancels the original and a fresh one for the right amount.
 * Both survive, which is the difference between an audit trail and a number
 * that has simply always been this.
 */
import { NextResponse } from 'next/server';
import { EntryNotFoundError, ManualEntryError, correctEntry } from '@/db/repo/manualEntry';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ entryId: string }> },
): Promise<Response> {
  const { entryId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  if (typeof body.amount !== 'string') {
    return NextResponse.json({ error: 'amount is required, as a decimal string' }, { status: 400 });
  }
  const correctedBy = typeof body.correctedBy === 'string' ? body.correctedBy.trim() : '';
  if (correctedBy === '') {
    return NextResponse.json({ error: 'correctedBy is required — a correction names who made it' }, { status: 400 });
  }
  const basis = typeof body.basis === 'string' ? body.basis.trim() : '';
  if (basis === '') {
    return NextResponse.json({ error: 'basis is required — say why this figure is being corrected' }, { status: 400 });
  }

  try {
    const result = await correctEntry(
      entryId,
      { amount: body.amount, memo: typeof body.memo === 'string' ? body.memo : null },
      correctedBy,
      basis,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof EntryNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ManualEntryError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
