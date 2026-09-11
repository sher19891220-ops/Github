/**
 * GET /api/pnl ?from&to&grain&scope&entityId&truckId
 *   -> { scope, from, to, grain, entityId, truckId, results, workQueue }
 *
 * The last route in DATA-CONTRACT.md §6 to be built, and the one whose
 * shape changed on the way: §6 specified a flat `PnlLine[]`, one row per
 * period × dimension × category group. That shape cannot carry three
 * things CLAUDE.md §2 requires to stay visible — the driver-borne
 * receivable kept apart from company cost, an allocated figure marked as
 * allocated rather than measured, and the balance-sheet rows stripped out
 * of the total. Flattening would have made a margin look like a complete
 * answer when it is a lower bound. The response returns the engine's own
 * result shapes instead, and §6 is amended to match rather than the
 * mismatch being left for a reader to trip over.
 *
 * `from` and `to` are required. A P&L over "everything ever" is not a
 * period, and the engine's contract is that a result covers exactly the
 * days it was asked for.
 */
import { NextResponse } from 'next/server';
import type { Grain } from '@/contract/types';
import { type PnlScope, PnlRequestError, getPnl } from '@/db/repo/pnl';

const GRAINS: readonly Grain[] = ['day', 'week', 'month', 'quarter', 'year'];
const SCOPES: readonly PnlScope[] = ['group', 'entity', 'truck'];

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;

  const from = p.get('from');
  const to = p.get('to');
  if (from === null || to === null) {
    return NextResponse.json(
      { error: 'from and to are required — a P&L is always for a stated period' },
      { status: 400 },
    );
  }

  const grainRaw = p.get('grain');
  if (grainRaw !== null && !GRAINS.includes(grainRaw as Grain)) {
    return NextResponse.json(
      { error: `grain must be one of ${GRAINS.join(', ')}` },
      { status: 400 },
    );
  }

  const scopeRaw = p.get('scope') ?? 'group';
  if (!SCOPES.includes(scopeRaw as PnlScope)) {
    return NextResponse.json({ error: `scope must be one of ${SCOPES.join(', ')}` }, { status: 400 });
  }

  try {
    const result = await getPnl({
      from,
      to,
      ...(grainRaw !== null ? { grain: grainRaw as Grain } : {}),
      scope: scopeRaw as PnlScope,
      entityId: p.get('entityId') ?? undefined,
      truckId: p.get('truckId') ?? undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PnlRequestError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
