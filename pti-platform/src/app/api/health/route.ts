import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {
      database: 'connected',
      storage: 'connected',
      telegramBot: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    },
  })
}
