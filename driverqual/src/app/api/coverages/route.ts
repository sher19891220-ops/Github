import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { createCoverage, listCoverages, listExpirationAlerts, refreshExpirationAlerts } from '@/db/repo';
import { normalizeCoverageType } from '@/domain/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const companyId = new URL(request.url).searchParams.get('companyId') ?? undefined;
  const db = getDb();
  refreshExpirationAlerts(db, companyId);
  return NextResponse.json({
    coverages: listCoverages(db, companyId),
    alerts: listExpirationAlerts(db),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.companyId || !body?.coverageType) {
    return NextResponse.json({ error: 'Company and coverage type are required.' }, { status: 400 });
  }
  const coverageType = normalizeCoverageType(String(body.coverageType));
  if (!coverageType) {
    return NextResponse.json(
      { error: `"${body.coverageType}" is not a recognised coverage type.` },
      { status: 400 },
    );
  }
  const coverage = createCoverage(
    getDb(),
    {
      companyId: body.companyId,
      coverageType,
      carrier: body.carrier ?? null,
      policyNumber: body.policyNumber ?? null,
      effectiveDate: body.effectiveDate ?? null,
      expirationDate: body.expirationDate ?? null,
      limits: body.limits ?? null,
    },
    'safety.admin',
  );
  return NextResponse.json({ coverage }, { status: 201 });
}
