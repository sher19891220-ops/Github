/**
 * GET  /api/ifta/rates ?year&quarter -> { year, quarter, rates }
 * POST /api/ifta/rates { jurisdiction, year, quarter, ratePerGallon,
 *                        surchargePerGallon?, sourceNote, enteredBy }
 *
 * The rate table is the one input to the IFTA engine that no document
 * supplies and nothing can derive. It is therefore the one place in this
 * build where a person typing a number is the source of record — and the
 * POST requires `sourceNote` and `enteredBy` for the same reason the manual
 * ledger path requires an attestation: the provenance of a typed figure is
 * a named person naming where they read it.
 *
 * Re-posting the same jurisdiction and quarter overwrites it, because a
 * published rate being corrected is a correction, not a second rate.
 */
import { NextResponse } from 'next/server';
import { IftaRequestError, listRates, upsertRate, type Quarter } from '@/db/repo/ifta';

function parseQuarter(year: string | null, quarter: string | null): Quarter {
  const y = Number(year);
  const q = Number(quarter);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new IftaRequestError('year is required (YYYY).');
  if (!Number.isInteger(q) || q < 1 || q > 4) throw new IftaRequestError('quarter must be 1, 2, 3 or 4.');
  return { year: y, quarter: q as 1 | 2 | 3 | 4 };
}

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  try {
    const q = parseQuarter(p.get('year'), p.get('quarter'));
    return NextResponse.json({ year: q.year, quarter: q.quarter, rates: await listRates(q) });
  } catch (err) {
    if (err instanceof IftaRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  try {
    await upsertRate({
      jurisdiction: String(body.jurisdiction ?? ''),
      year: Number(body.year),
      quarter: Number(body.quarter),
      ratePerGallon: String(body.ratePerGallon ?? ''),
      surchargePerGallon:
        body.surchargePerGallon === undefined || body.surchargePerGallon === null || body.surchargePerGallon === ''
          ? undefined
          : String(body.surchargePerGallon),
      sourceNote: String(body.sourceNote ?? ''),
      enteredBy: String(body.enteredBy ?? ''),
    });
    const q = { year: Number(body.year), quarter: Number(body.quarter) as 1 | 2 | 3 | 4 };
    return NextResponse.json({ year: q.year, quarter: q.quarter, rates: await listRates(q) }, { status: 201 });
  } catch (err) {
    if (err instanceof IftaRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
