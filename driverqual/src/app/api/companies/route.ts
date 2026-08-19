import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { createCompany, listCompanyCards } from '@/db/repo';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ companies: listCompanyCards(getDb()) });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
    return NextResponse.json({ error: 'Company name is required.' }, { status: 400 });
  }
  const company = createCompany(getDb(), { ...body, name: body.name.trim() }, 'safety.admin');
  return NextResponse.json({ company }, { status: 201 });
}
