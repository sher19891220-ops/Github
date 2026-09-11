/**
 * POST /api/ifta/rates/import — a whole published matrix for one quarter.
 *
 * Rates are the only input to the IFTA engine no document supplies, and
 * typing 48 jurisdictions by hand every quarter is the step that would not
 * get done. This takes the matrix as published (pasted from iftach.org, in
 * whatever shape it copies out as) and stores each rate with the same
 * provenance a typed one carries.
 *
 * A 400 here is usually not a malformed request — it is the parser
 * refusing figures that are the wrong column. The response returns what it
 * rejected and why, per jurisdiction, rather than a single failure line.
 */
import { NextResponse } from 'next/server';
import { IftaRequestError, importRateMatrix, listRates } from '@/db/repo/ifta';

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const year = Number(body.year);
  const quarter = Number(body.quarter);
  if (!Number.isInteger(year) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    return NextResponse.json({ error: 'year and quarter (1-4) are required.' }, { status: 400 });
  }

  try {
    const result = await importRateMatrix({
      text: String(body.text ?? ''),
      year,
      quarter,
      sourceNote: String(body.sourceNote ?? ''),
      enteredBy: String(body.enteredBy ?? ''),
    });
    return NextResponse.json(
      { ...result, year, quarter, rates: await listRates({ year, quarter: quarter as 1 | 2 | 3 | 4 }) },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof IftaRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
