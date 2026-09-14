/**
 * GET /api/ceo ?from&to -> CeoResponse
 *
 * Every entity's position, every truck's, and next week's forecast with
 * the back-test behind its band. The forecast is a separate field from the
 * actuals and never merged into them — see `db/repo/ceo.ts`.
 */
import { NextResponse } from 'next/server';
import { getCeoView } from '@/db/repo/ceo';

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const year = new Date().getUTCFullYear();
  const from = p.get('from') ?? `${year}-01-01`;
  const to = p.get('to') ?? `${year}-12-31`;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM-DD.' }, { status: 400 });
  }

  try {
    return NextResponse.json(await getCeoView(from, to));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
