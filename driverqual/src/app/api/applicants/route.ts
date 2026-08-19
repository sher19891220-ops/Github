import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { createApplicant, dashboardRows, evaluateApplicantForCompany } from '@/db/repo';
import { emptyEvidence, type DriverEvidence } from '@/domain/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ rows: dashboardRows(getDb()) });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });

  const missing = ['companyId', 'firstName', 'lastName'].filter((f) => !body[f]);
  if (missing.length) {
    return NextResponse.json(
      { error: `Missing required field(s): ${missing.join(', ')}.` },
      { status: 400 },
    );
  }

  const db = getDb();
  const evidence: DriverEvidence = { ...emptyEvidence(), ...(body.evidence ?? {}) };

  try {
    const applicant = createApplicant(db, body, evidence, 'safety.reviewer');
    const evaluation = evaluateApplicantForCompany(db, applicant.id, applicant.companyId, {
      evaluationDate: body.evaluationDate,
      actor: 'safety.reviewer',
    });
    return NextResponse.json({ applicant, evaluation }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not create the applicant.' },
      { status: 400 },
    );
  }
}
