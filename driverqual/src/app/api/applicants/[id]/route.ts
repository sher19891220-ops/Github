import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import {
  compareCompanies,
  deleteApplicant,
  evaluateApplicantForCompany,
  getApplicant,
  getCurrentEvidence,
  getStoredEvaluation,
  saveEvidence,
  setApplicantCompany,
} from '@/db/repo';
import { emptyEvidence } from '@/domain/types';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const applicant = await getApplicant(db, id);
  if (!applicant) return NextResponse.json({ error: 'Applicant not found.' }, { status: 404 });
  const current = await getCurrentEvidence(db, id);
  return NextResponse.json({
    applicant,
    evidence: current?.evidence ?? null,
    evaluation: await getStoredEvaluation(db, id, applicant.companyId),
  });
}

/**
 * One endpoint, four actions, each of which re-evaluates only the company it
 * names. `compare` writes an independent result per selected company.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const db = await getDb();
  const applicant = await getApplicant(db, id);
  if (!applicant) return NextResponse.json({ error: 'Applicant not found.' }, { status: 404 });

  const actor = 'safety.reviewer';
  const evaluationDate = body.evaluationDate as string | undefined;

  try {
    switch (body.action) {
      case 'reevaluate':
        return NextResponse.json({
          evaluation: await evaluateApplicantForCompany(db, id, applicant.companyId, {
            evaluationDate,
            actor,
          }),
        });

      case 'change_company': {
        if (!body.companyId) {
          return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
        }
        return NextResponse.json({
          evaluation: await setApplicantCompany(db, id, body.companyId, { evaluationDate, actor }),
        });
      }

      case 'update_evidence': {
        const evidence = { ...emptyEvidence(), ...(body.evidence ?? {}) };
        await saveEvidence(db, id, evidence, actor);
        return NextResponse.json({
          evaluation: await evaluateApplicantForCompany(db, id, applicant.companyId, {
            evaluationDate,
            actor,
          }),
        });
      }

      case 'compare': {
        const companyIds: string[] = Array.isArray(body.companyIds) ? body.companyIds : [];
        if (companyIds.length === 0) {
          return NextResponse.json({ error: 'Select at least one company.' }, { status: 400 });
        }
        return NextResponse.json({
          comparisons: await compareCompanies(db, id, companyIds, { evaluationDate, actor }),
        });
      }

      default:
        return NextResponse.json({ error: `Unknown action "${body.action}".` }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Request failed.' },
      { status: 400 },
    );
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteApplicant(await getDb(), id, 'safety.reviewer');
  return NextResponse.json({ ok: true });
}
