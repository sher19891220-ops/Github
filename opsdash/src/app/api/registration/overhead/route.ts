/**
 * GET /api/registration/overhead -> { rates: TruckOverheadRate[] }
 *
 * Added per the coordinator's relay of the UI workstream's gap report.
 * Reads `src/engines/registration`'s own `overheadRates` output — see
 * src/db/repo/registrationOverhead.ts for exactly what real data feeds it
 * and what is intentionally out of scope (the operator recharge crosswalk).
 *
 * Optional query params: `asOf` (YYYY-MM-DD), `hvutRatePerUnit` (decimal string).
 */
import { NextResponse } from 'next/server';
import {
  RegistrationEntityUnresolvedError,
  RegistrationSourcesUnavailableError,
  getOverheadRates,
} from '@/db/repo/registrationOverhead';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  try {
    const rates = await getOverheadRates({
      asOf: params.get('asOf') ?? undefined,
      hvutRatePerUnit: params.get('hvutRatePerUnit') ?? undefined,
    });
    return NextResponse.json({ rates });
  } catch (err) {
    if (err instanceof RegistrationSourcesUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof RegistrationEntityUnresolvedError) {
      return NextResponse.json({ error: err.message }, { status: 424 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
