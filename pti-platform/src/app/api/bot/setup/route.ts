import { NextRequest, NextResponse } from 'next/server'
import { getRegisteredGroups, unregisterGroup } from '@/lib/kv'

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

// POST /api/bot/setup — diagnostic: shows bot identity + webhook state from Vercel's perspective
export async function POST(_req: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 500 })

  const [meRes, infoRes] = await Promise.all([
    fetch(`https://api.telegram.org/bot${botToken}/getMe`, { cache: 'no-store' }),
    fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, { cache: 'no-store' }),
  ])
  const me   = await meRes.json()
  const info = await infoRes.json()

  // Mask token — show only first 10 and last 4 chars for verification
  const masked = `${botToken.slice(0, 10)}...${botToken.slice(-4)}`

  const webhookEndpoint: string = info?.result?.url ?? ''

  // Separately report which bot lib/tg.ts is ACTUALLY using to send
  // reports — this is TELEGRAM_SEND_BOT_TOKEN if set, otherwise it falls
  // back to TELEGRAM_BOT_TOKEN (the same @Pti_check_bot token above).
  // This tells us definitively whether the env var has been added yet,
  // rather than guessing from send failures alone.
  const sendToken = process.env.TELEGRAM_SEND_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const usingFallback = !process.env.TELEGRAM_SEND_BOT_TOKEN
  let sendBotIdentity: { bot_id?: number; bot_username?: string; source: string } = { source: 'none' }
  if (sendToken) {
    const sendMeRes = await fetch(`https://api.telegram.org/bot${sendToken}/getMe`, { cache: 'no-store' })
    const sendMe = await sendMeRes.json()
    sendBotIdentity = {
      bot_id: sendMe?.result?.id,
      bot_username: sendMe?.result?.username,
      source: usingFallback ? 'FALLBACK: TELEGRAM_SEND_BOT_TOKEN not set, using TELEGRAM_BOT_TOKEN (@Pti_check_bot)' : 'TELEGRAM_SEND_BOT_TOKEN',
    }
  }

  return NextResponse.json({
    token_masked: masked,
    bot_id: me?.result?.id,
    bot_username: me?.result?.username,
    webhook_endpoint: webhookEndpoint,
    webhook_raw: info,
    report_sending_currently_uses: sendBotIdentity,
  })
}


// DELETE /api/bot/setup?secret=BOT_SETUP_KEY
// Fully retires @Pti_check_bot: removes its Telegram webhook (so it stops
// responding to messages entirely) and clears every group it had
// auto-registered for PTI reports, so no stale registration can ever act
// as a silent fallback target for a report. Only @gr_observer_bot should
// handle inspections after this — this bot is intentionally shut down,
// not just paused.
export async function DELETE(req: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const setupKey = process.env.BOT_SETUP_KEY

  if (!botToken) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 500 })

  if (setupKey) {
    const provided = req.nextUrl.searchParams.get('secret')
    if (provided !== setupKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // 1. Delete the Telegram webhook — the bot stops receiving updates entirely.
  const deleteRes = await fetch(
    `https://api.telegram.org/bot${botToken}/deleteWebhook`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drop_pending_updates: true }), cache: 'no-store' },
  )
  const deleteData = await deleteRes.json()

  // 2. Confirm the webhook is actually gone (don't just trust the delete call).
  const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, { cache: 'no-store' })
  const infoData = await infoRes.json()
  const webhookNowEmpty = !infoData?.result?.url

  // 3. Clear every group this bot had registered, so nothing lingers as a
  //    fallback broadcast target.
  const groupsBefore = await getRegisteredGroups()
  for (const g of groupsBefore) {
    await unregisterGroup(g.chatId)
  }
  const groupsAfter = await getRegisteredGroups()

  return NextResponse.json({
    ok: webhookNowEmpty && groupsAfter.length === 0,
    webhook_deleted: deleteData,
    webhook_now_empty: webhookNowEmpty,
    groups_cleared: groupsBefore.map((g) => ({ chatId: g.chatId, title: g.title })),
    groups_remaining: groupsAfter.length,
  })
}
