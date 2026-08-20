import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { approveGuideline, removeGuideline } from '@/db/repo';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (body.action !== 'approve') {
    return NextResponse.json({ error: `Unknown action "${body.action}".` }, { status: 400 });
  }
  await approveGuideline(await getDb(), id, 'safety.admin');
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await removeGuideline(await getDb(), id, 'safety.admin');
  return NextResponse.json({ ok: true });
}
