import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { companyDeletionImpact, deleteCompany, getCompany } from '@/db/repo';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = getCompany(getDb(), id);
  if (!company) return NextResponse.json({ error: 'Company not found.' }, { status: 404 });
  return NextResponse.json({ company, impact: companyDeletionImpact(getDb(), id) });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = deleteCompany(getDb(), id, 'safety.admin');
  if (!result.ok) {
    return NextResponse.json({ error: result.error, impact: result.impact }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
