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

  const entityId = p.get('entityId');
  const truckId = p.get('truckId');

  /**
   * Scope is INFERRED from the filters when it is not stated, and a stated
   * scope that contradicts them is refused.
   *
   * Before this, `?entityId=X` with no `scope` returned the whole group's
   * figures with `entityId: X` echoed back in the response — the caller
   * asked for one company's P&L and got the group's, labelled as theirs.
   * The UI always sends `scope`, so it never surfaced there; the API is
   * still the API. A wrong number carrying the right label is the exact
   * failure this build exists to prevent, so the two ways it could happen
   * are both closed: silence is inferred, contradiction is an error.
   */
  const explicitScope = p.get('scope');
  const inferredScope: PnlScope = truckId ? 'truck' : entityId ? 'entity' : 'group';
  const scopeRaw = explicitScope ?? inferredScope;

  if (!SCOPES.includes(scopeRaw as PnlScope)) {
    return NextResponse.json({ error: `scope must be one of ${SCOPES.join(', ')}` }, { status: 400 });
  }
  if (explicitScope !== null && explicitScope !== inferredScope) {
    return NextResponse.json(
      {
        error:
          `scope=${explicitScope} contradicts the filters supplied (${truckId ? 'truckId' : entityId ? 'entityId' : 'none'}). ` +
          'Refused rather than answering one of the two: a P&L returned at a different scope than the caller asked for is a wrong number carrying the right label.',
      },
      { status: 400 },
    );
  }

  try {
    const result = await getPnl({
      from,
      to,
      ...(grainRaw !== null ? { grain: grainRaw as Grain } : {}),
      scope: scopeRaw as PnlScope,
      entityId: entityId ?? undefined,
      truckId: truckId ?? undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PnlRequestError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
