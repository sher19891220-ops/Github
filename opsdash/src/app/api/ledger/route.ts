/**
 * GET /api/ledger?entity&truck&driver&from&to&category — DATA-CONTRACT.md §6.
 *
 * Query params map to entity_id/truck_id/driver_id/category_id and an
 * inclusive accrual_date range. All money crosses back out as the decimal
 * strings the database returned — no arithmetic, no Number(...) anywhere in
 * this path.
 */
import { NextResponse } from 'next/server';
import { listLedgerEntries } from '@/db/repo/ledger';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const entries = await listLedgerEntries({
    entityId: params.get('entity') ?? undefined,
    truckId: params.get('truck') ?? undefined,
    driverId: params.get('driver') ?? undefined,
    categoryId: params.get('category') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
  });

  return NextResponse.json({ entries });
}
