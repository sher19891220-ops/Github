import { NextRequest, NextResponse } from 'next/server'
import { MOCK_INSPECTIONS } from '@/lib/mockData'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const company = searchParams.get('company')
  const type = searchParams.get('type')
  const status = searchParams.get('status')
  const page = Number(searchParams.get('page') || 1)
  const limit = Number(searchParams.get('limit') || 20)

  let data = [...MOCK_INSPECTIONS]
  if (company) data = data.filter((i) => i.company === company)
  if (type) data = data.filter((i) => i.type === type)
  if (status) data = data.filter((i) => i.status === status)

  const total = data.length
  const offset = (page - 1) * limit
  const items = data.slice(offset, offset + limit)

  return NextResponse.json({
    items,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // Validate required fields
    const required = ['sessionToken', 'type', 'driver', 'vehicle', 'odometer']
    for (const field of required) {
      if (!body[field]) {
        return NextResponse.json({ error: `Missing required field: ${field}` }, { status: 400 })
      }
    }

    if (!['PICKUP', 'DROP_OFF'].includes(body.type)) {
      return NextResponse.json({ error: 'type must be PICKUP or DROP_OFF' }, { status: 400 })
    }

    if (typeof body.odometer !== 'number' || body.odometer <= 0) {
      return NextResponse.json({ error: 'odometer must be a positive number' }, { status: 400 })
    }

    // In production, persist to PostgreSQL via Prisma/Drizzle
    const inspection = {
      id: Math.random().toString(36).slice(2, 11),
      ...body,
      status: 'SUBMITTED',
      submittedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // Notify PTI bot (fire-and-forget)
    notifyPtiBot(inspection).catch(() => {})

    return NextResponse.json({ id: inspection.id, status: 'SUBMITTED' }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}

async function notifyPtiBot(inspection: Record<string, unknown>) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!botToken || !chatId) return

  const driver = inspection.driver as { name: string; company: string }
  const vehicle = inspection.vehicle as { unitNumber: string }
  const type = inspection.type === 'PICKUP' ? '▲ PICKUP' : '▼ DROP-OFF'
  const failCount = (inspection.checklist as Array<{ status: string }>)?.filter((i) => i.status === 'FAIL').length ?? 0
  const status = failCount > 0 ? `⚠️ ${failCount} item(s) FAILED` : '✅ All items PASSED'

  const text =
    `📋 *PTI Inspection Submitted*\n` +
    `${type} | Unit: *${vehicle.unitNumber}*\n` +
    `Driver: ${driver.name} (${driver.company})\n` +
    `${status}\n` +
    `Token: \`${inspection.sessionToken}\``

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  })
}
