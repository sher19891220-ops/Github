import { NextRequest, NextResponse } from 'next/server'

// GET /api/bot/setup
// Registers this app as the Telegram webhook for @Pti_check_bot.
// Call this once after deployment, or any time the bot stops responding.
// Protect with a shared secret via ?secret=... query param.
export async function GET(req: NextRequest) {
  const botToken  = process.env.TELEGRAM_BOT_TOKEN
  const appUrl    = process.env.NEXT_PUBLIC_APP_URL
  const setupKey  = process.env.BOT_SETUP_KEY

  if (!botToken)  return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 500 })
  if (!appUrl)    return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL not set' }, { status: 500 })

  // Simple auth — caller must pass ?secret=BOT_SETUP_KEY
  if (setupKey) {
    const provided = req.nextUrl.searchParams.get('secret')
    if (provided !== setupKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const webhookUrl = `${appUrl}/api/bot/webhook`
  const params = new URLSearchParams({
    url: webhookUrl,
    allowed_updates: JSON.stringify(['message', 'edited_message', 'my_chat_member']),
    drop_pending_updates: 'true',
  })

  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/setWebhook?${params.toString()}`,
    { method: 'GET', cache: 'no-store' },
  )

  const data = await res.json()

  if (data.ok) {
    return NextResponse.json({
      ok: true,
      message: `Webhook registered → ${webhookUrl}`,
      telegram: data,
    })
  }

  return NextResponse.json({ ok: false, telegram: data }, { status: 500 })
}

// GET /api/bot/setup?action=info
// Shows the current webhook info without making any changes.
export async function POST(req: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 500 })

  const res  = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`)
  const data = await res.json()
  return NextResponse.json(data)
}
