import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { driverId, vehicleId, type } = body

    if (!driverId || !vehicleId || !type) {
      return NextResponse.json({ error: 'driverId, vehicleId, and type required' }, { status: 400 })
    }

    // Generate a unique, time-limited session token
    const token = 'tkn-' + crypto.randomBytes(8).toString('hex')
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() // 2 hours

    const session = {
      token,
      driverId,
      vehicleId,
      type,
      expiresAt,
      url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://pti.zonellc.com'}/inspection/start?token=${token}`,
      createdAt: new Date().toISOString(),
    }

    // In production: store in DB and optionally send Telegram link
    return NextResponse.json(session, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}
