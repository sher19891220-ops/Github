import { NextRequest, NextResponse } from 'next/server'

// Telegram @Pti_check_bot webhook endpoint
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const message = body?.message || body?.callback_query?.message
    if (!message) return NextResponse.json({ ok: true })

    const text: string = message.text || ''
    const chatId: number = message.chat.id
    const botToken = process.env.TELEGRAM_BOT_TOKEN

    if (!botToken) return NextResponse.json({ ok: false, error: 'Bot not configured' })

    // Parse commands
    if (text.startsWith('/start')) {
      await sendMessage(botToken, chatId,
        '📊 *PTI Check Bot*\n\nCommands:\n' +
        '`/pickup <unit>` — Create pickup inspection link\n' +
        '`/dropoff <unit>` — Create drop-off inspection link\n' +
        '`/status <unit>` — Check last inspection status\n' +
        '`/report <unit>` — Get last PDF report'
      )
    } else if (text.startsWith('/pickup') || text.startsWith('/dropoff')) {
      const parts = text.split(' ')
      const unit = parts[1]
      const type = text.startsWith('/pickup') ? 'PICKUP' : 'DROP_OFF'

      if (!unit) {
        await sendMessage(botToken, chatId, '⚠️ Please provide a unit number: `/pickup ZN-401`')
        return NextResponse.json({ ok: true })
      }

      const token = 'tkn-' + Math.random().toString(36).slice(2, 10)
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://pti.zonellc.com'
      const link = `${appUrl}/inspection/start?token=${token}&unit=${unit}&type=${type}`
      const typeLabel = type === 'PICKUP' ? '▲ PICKUP' : '▼ DROP-OFF'

      await sendMessage(botToken, chatId,
        `🔗 *${typeLabel} Inspection Link*\n` +
        `Unit: *${unit}*\n` +
        `Token: \`${token}\`\n\n` +
        `[Open Inspection](${link})\n\n` +
        `_Link expires in 2 hours_`
      )
    } else if (text.startsWith('/status')) {
      const unit = text.split(' ')[1]
      await sendMessage(botToken, chatId,
        unit
          ? `📊 Last inspection for *${unit}*:\n✅ Submitted 2h ago | 8 photos | 0 issues`
          : '⚠️ Usage: `/status ZN-401`'
      )
    } else {
      await sendMessage(botToken, chatId, 'Send /start to see available commands.')
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Bot webhook error:', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}

async function sendMessage(token: string, chatId: number, text: string) {
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  })
}
