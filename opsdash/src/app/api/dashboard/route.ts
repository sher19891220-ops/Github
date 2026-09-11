/**
 * GET /api/dashboard ?from&to -> DashboardResponse
 *
 * The landing screen's figures, read live. Defaults to the current
 * calendar year when no period is given, because a dashboard with no
 * stated period is the easiest number on a screen to quote out of context.
 */
import { NextResponse } from 'next/server';
import { getDashboard } from '@/db/repo/dashboard';

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const year = new Date().getUTCFullYear();
  const from = p.get('from') ?? `${year}-01-01`;
  const to = p.get('to') ?? `${year}-12-31`;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM-DD.' }, { status: 400 });
  }

  try {
    return NextResponse.json(await getDashboard(from, to));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
