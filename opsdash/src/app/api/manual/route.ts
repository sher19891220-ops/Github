/**
 * POST /api/manual — type a figure in.
 *
 * The second of the four intake paths in `docs/INTAKE-MATRIX.md`, and the
 * one that makes the other three optional: maintenance a shop quoted by
 * phone, a factoring status read off a portal, IFTA miles copied from a
 * Samsara screen, all enterable today rather than when a connector lands.
 *
 * `assertedBy` and `basis` are not form niceties. The database rejects a
 * manual entry without an attestation, so there is no way through this
 * route to add a number nobody stands behind.
 */
import { NextResponse } from 'next/server';
import { ManualEntryError, createManualEntry, type ManualEntryInput } from '@/db/repo/manualEntry';

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const required = ['entityId', 'accrualDate', 'categoryId', 'amount', 'assertedBy', 'basis'];
  const missing = required.filter((k) => typeof body[k] !== 'string' || (body[k] as string).trim() === '');
  if (missing.length > 0) {
    return NextResponse.json({ error: `missing or empty: ${missing.join(', ')}` }, { status: 400 });
  }

  try {
    const result = await createManualEntry(
      body as unknown as ManualEntryInput,
      typeof body.postedBy === 'string' && body.postedBy.trim() !== ''
        ? body.postedBy
        : (body.assertedBy as string),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ManualEntryError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // A constraint the route did not pre-check (an unknown category, an
    // entity that does not exist) surfaces its own message rather than a
    // generic failure — the person typing can act on the real reason.
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
