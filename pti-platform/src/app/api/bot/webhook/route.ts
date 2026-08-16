import { NextRequest, NextResponse } from 'next/server'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const APP_URL   = process.env.NEXT_PUBLIC_APP_URL || 'https://pti.zonellc.com'

// Telegram @Pti_check_bot webhook
// Commands:
//   /pickup  ZN-401 [John Smith]  — send a PICKUP inspection link
//   /dropoff ZN-401 [John Smith]  — send a DROP-OFF inspection link
//   /status  ZN-401               — last inspection summary for that unit
//   /start                        — show help
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const message = body?.message || body?.edited_message
    if (!message) return NextResponse.json({ ok: true })

    const text: string  = (message.text || '').trim()
    const chatId: number = message.chat.id

    if (!BOT_TOKEN) return NextResponse.json({ ok: false, error: 'Bot token not configured' })

    const parts = text.split(/\s+/)
    // Strip @BotName suffix so group commands (/pickup@Pti_check_bot) match
    const cmd   = (parts[0]?.split('@')[0] ?? '').toLowerCase()

    if (cmd === '/chatid') {
      await send(chatId, `Chat ID: \`${chatId}\``, 'MarkdownV2')
      return NextResponse.json({ ok: true })
    }

    if (cmd === '/start' || cmd === '/help') {
      await send(chatId,
        '🚛 *PTI Check Bot*\n\n' +
        'Send a command to generate an inspection link:\n\n' +
        '`/pickup ZN\-401` — Pickup \(pre\-trip\)\n' +
        '`/dropoff ZN\-401` — Drop\-off \(post\-trip\)\n' +
        '`/status ZN\-401` — Last inspection result\n\n' +
        'Optionally include the driver name:\n' +
        '`/pickup ZN\-401 John Smith`\n\n' +
        '_Driver opens the link on their phone \— no login required_',
        'MarkdownV2'
      )
      return NextResponse.json({ ok: true })
    }

    if (cmd === '/pickup' || cmd === '/dropoff') {
      const unit       = parts[1]
      // Only take words that are NOT @mentions — strip if dispatcher included them
      const driverName = parts.slice(2).filter((w) => !w.startsWith('@')).join(' ')
      const type       = cmd === '/pickup' ? 'PICKUP' : 'DROP_OFF'
      const typeLabel  = type === 'PICKUP'  ? '▲ PICKUP' : '▼ DROP\-OFF'

      if (!unit) {
        await send(chatId, `⚠️ Please include the unit number: \`/${cmd.slice(1)} ZN\-401\``, 'MarkdownV2')
        return NextResponse.json({ ok: true })
      }

      const params = new URLSearchParams({ unit, type })
      if (driverName) params.set('driver', driverName)
      const link = `${APP_URL}/inspection/start?${params.toString()}`

      const driverLine = driverName ? `\nDriver: *${escMd(driverName)}*` : ''
      await send(chatId,
        `🔗 *${typeLabel} Inspection*\n` +
        `Unit: *${escMd(unit)}*${driverLine}\n\n` +
        `[Open on phone](${link})\n\n` +
        `_Share this link with the driver_ \— no login needed`,
        'MarkdownV2'
      )
      return NextResponse.json({ ok: true })
    }

    if (cmd === '/status') {
      const unit = parts[1]
      if (!unit) {
        await send(chatId, '⚠️ Usage: `/status ZN\-401`', 'MarkdownV2')
        return NextResponse.json({ ok: true })
      }
      // Placeholder until real DB is wired — replace with Prisma query
      await send(chatId,
        `📊 *Unit ${escMd(unit)}*\n_No inspections on record yet_`,
        'MarkdownV2'
      )
      return NextResponse.json({ ok: true })
    }

    // Unrecognised command
    await send(chatId, 'Unknown command\. Send /help to see what I can do\.', 'MarkdownV2')
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Bot webhook error:', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}

function escMd(s: string) {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1')
}

async function send(chatId: number, text: string, parseMode: 'Markdown' | 'MarkdownV2' = 'Markdown') {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, link_preview_options: { is_disabled: true } }),
  })
}
