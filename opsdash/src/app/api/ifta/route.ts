/**
 * GET  /api/ifta ?from&to&entityId&mpgDecimalPlaces -> IftaReturnView
 * POST /api/ifta { from, to, entityId, savedBy }    -> saves it as a return
 *
 * Reachable by both departments the operator named: accounting files the
 * return, safety owns the mileage that feeds it. One endpoint, because two
 * would be two arithmetics.
 *
 * The GET never fails for a missing input. A period with no fuel, no rates,
 * or no mileage report returns 200 with `result: null`, `blocked` saying
 * why, and `sourceProblems` naming what to upload — an accountant needs to
 * see which input is missing, and a 4xx here would render as "something
 * went wrong" for a system that is working correctly and waiting on data.
 *
 * A 400 is reserved for a request that cannot be answered at all: a
 * malformed date, or a period spanning two quarters, which have different
 * rates and therefore no single answer.
 */
import { NextResponse } from 'next/server';
import { getIftaReturn, IftaRequestError, saveIftaReturn } from '@/db/repo/ifta';

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const from = p.get('from');
  const to = p.get('to');
  if (from === null || to === null) {
    return NextResponse.json(
      { error: 'from and to are required — an IFTA figure is always for a stated period' },
      { status: 400 },
    );
  }

  const placesRaw = p.get('mpgDecimalPlaces');
  let places: number | undefined;
  if (placesRaw !== null) {
    places = Number(placesRaw);
    if (!Number.isInteger(places) || places < 1 || places > 6) {
      return NextResponse.json(
        { error: 'mpgDecimalPlaces must be a whole number between 1 and 6' },
        { status: 400 },
      );
    }
  }

  try {
    const view = await getIftaReturn({
      from,
      to,
      entityId: p.get('entityId') ?? undefined,
      mpgDecimalPlaces: places,
    });
    return NextResponse.json(view);
  } catch (err) {
    if (err instanceof IftaRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: { from?: string; to?: string; entityId?: string; savedBy?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const { from, to, entityId, savedBy } = body;
  if (!from || !to || !entityId || !savedBy) {
    return NextResponse.json(
      { error: 'from, to, entityId and savedBy are all required to save a return.' },
      { status: 400 },
    );
  }

  try {
    // Recomputed server-side rather than trusting a posted result. A client
    // that could hand over its own lines could hand over any lines, and
    // this table is the record of what was filed.
    const view = await getIftaReturn({ from, to, entityId });
    const saved = await saveIftaReturn(view, savedBy);
    return NextResponse.json({ ...saved, view }, { status: 201 });
  } catch (err) {
    if (err instanceof IftaRequestError) {
      // 422, not 400: the request is well-formed and the refusal is about
      // the state of the data — an accrual, a missing rate, no entity.
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
