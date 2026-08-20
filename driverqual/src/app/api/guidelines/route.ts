import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { createGuideline, listGuidelines } from '@/db/repo';
import { parseRuleSet } from '@/domain/guideline';
import { normalizeCoverageType, type CoverageType } from '@/domain/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const companyId = url.searchParams.get('companyId') ?? undefined;
  const status = url.searchParams.get('status') ?? undefined;
  const db = await getDb();
  return NextResponse.json({ guidelines: await listGuidelines(db, { companyId, status }) });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.companyId || !body?.coverageType) {
    return NextResponse.json(
      { error: 'Company and coverage are both required on a guideline.' },
      { status: 400 },
    );
  }

  const coverageType = normalizeCoverageType(String(body.coverageType));
  if (!coverageType) {
    return NextResponse.json(
      { error: `"${body.coverageType}" is not a recognised coverage type.` },
      { status: 400 },
    );
  }

  // An interpreted rule set is optional at upload time, but if one is supplied
  // it must be structurally valid before it is stored.
  let ruleSet: unknown = undefined;
  if (body.ruleSet) {
    const parsed = parseRuleSet(body.ruleSet);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: `The interpreted criteria are not valid: ${parsed.errors.join('; ')}` },
        { status: 400 },
      );
    }
    ruleSet = parsed.ruleSet;
  }

  const db = await getDb();
  const guideline = await createGuideline(
    db,
    { ...body, coverageType: coverageType as CoverageType, ruleSet },
    'safety.admin',
  );
  return NextResponse.json({ guideline }, { status: 201 });
}
