import { NextRequest, NextResponse } from 'next/server'
import { MOCK_INSPECTIONS } from '@/lib/mockData'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const ins = MOCK_INSPECTIONS.find((i) => i.id === params.id)
  if (!ins) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(ins)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const ins = MOCK_INSPECTIONS.find((i) => i.id === params.id)
  if (!ins) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    const body = await req.json()
    const allowed = ['status', 'notes']
    const invalid = Object.keys(body).filter((k) => !allowed.includes(k))
    if (invalid.length > 0) {
      return NextResponse.json({ error: `Non-patchable fields: ${invalid.join(', ')}` }, { status: 400 })
    }
    return NextResponse.json({ ...ins, ...body, updatedAt: new Date().toISOString() })
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
}
