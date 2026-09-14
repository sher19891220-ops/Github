/**
 * GET  /api/truck-status  -> { statuses: TruckStatusNow[], counts }
 * POST /api/truck-status  body { truckId, status, source, ... }
 *
 * The fleet board's source, at last. `counts` carries an `unknown` bucket
 * for trucks nobody has marked — kept separate rather than folded into
 * `open`, because "nobody has told us" and "available" are different facts
 * and a board that conflates them invents fleet capacity.
 */
import { NextResponse } from 'next/server';
import {
  TruckStatusError,
  listCurrentStatus,
  setTruckStatus,
  statusCounts,
  type SetStatusInput,
} from '@/db/repo/truckStatus';

export async function GET(): Promise<Response> {
  try {
    const [statuses, counts] = await Promise.all([listCurrentStatus(), statusCounts()]);
    return NextResponse.json({ statuses, counts });
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

  if (typeof body.truckId !== 'string' || typeof body.status !== 'string') {
    return NextResponse.json({ error: 'truckId and status are required' }, { status: 400 });
  }
  if (typeof body.source !== 'string') {
    return NextResponse.json(
      { error: 'source is required: samsara, motive, sheet or manual' },
      { status: 400 },
    );
  }

  try {
    const result = await setTruckStatus(body as unknown as SetStatusInput);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof TruckStatusError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
