import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { createCompany, listCompanyCards } from '@/db/repo';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = await getDb();
  return NextResponse.json({ companies: await listCompanyCards(db) });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
    return NextResponse.json({ error: 'Company name is required.' }, { status: 400 });
  }
  const db = await getDb();
  const company = await createCompany(db, { ...body, name: body.name.trim() }, 'safety.admin');
  return NextResponse.json({ company }, { status: 201 });
}
