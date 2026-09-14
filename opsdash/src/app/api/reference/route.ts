/**
 * GET /api/reference -> ReferenceData
 *
 * Added per the coordinator's relay of the UI workstream's gap report.
 * Inactive entities/trucks/drivers/categories are included, flagged via
 * `isActive`, never filtered out — see src/db/repo/reference.ts.
 */
import { NextResponse } from 'next/server';
import { getReferenceData } from '@/db/repo/reference';

export async function GET(): Promise<Response> {
  const data = await getReferenceData();
  return NextResponse.json(data);
}
