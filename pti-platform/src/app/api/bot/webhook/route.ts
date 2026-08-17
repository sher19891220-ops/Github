import { NextRequest, NextResponse } from 'next/server'
import { sendMessage, escMd } from '@/lib/tg'
import { registerGroup, unregisterGroup, getRegisteredGroups, isKvConfigured } from '@/lib/kv'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const APP_URL   = process.env.NEXT_PUBLIC_APP_URL || 'https://pti-check.vercel.app'

// GET /api/bot/webhook — self-registers this URL as the Telegram webhook.
// Pass webhook url raw (not URLSearchParams-encoded) — Telegram rejects %3A%2F%2F in url param.
export async function GET() {
  if (!BOT_TOKEN) return NextResponse.json({ error: 'Bot token not configured' }, { status: 500 })
  const webhookUrl = `${APP_URL}/api/bot/webhook`
  // Build query string manually so the webhook URL itself is NOT percent-encoded.
  // URLSearchParams would encode ':' → '%3A' and '/' → '%2F' in the url value,
  // causing Telegram to reject the URL as invalid.
  const tgUrl =
    `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook` +
    `?url=${webhookUrl}` +
    `&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'edited_message', 'my_chat_member']))}` +
    `&drop_pending_updates=false`
  const res = await fetch(tgUrl, { method: 'GET', cache: 'no-store' })
  const data = await res.json()
  const info = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`,
    { cache: 'no-store' },
  ).then(r => r.json())
  return NextResponse.json({ webhookUrl, tgUrl, telegram: data, info })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    if (!BOT_TOKEN) return NextResponse.json({ ok: false, error: 'Bot token not configured' })

    // ── Handle bot added/removed from a group ────────────────────────────
    const memberUpdate = body?.my_chat_member
    if (memberUpdate) {
      const chat    = memberUpdate.chat
      const newMember = memberUpdate.new_chat_member
      const isBot   = newMember?.user?.is_bot

      if (isBot) {
        const status = newMember?.status
        const chatId: number = chat.id
        const title: string  = chat.title ?? 'Unknown Group'
        const type: string   = chat.type ?? 'group'

        if (status === 'member' || status === 'administrator') {
          // Bot was added to a group
          await registerGroup(chatId, title, type)
          await sendMessage(
            chatId,
            `👋 *PTI Check Bot activated in this group!*\n\n` +
            `Group ID: \`${chatId}\`\n` +
            `Group: *${escMd(title)}*\n\n` +
            `✅ This group is now registered to receive PTI inspection reports.\n\n` +
            `Commands:\n` +
            `/pickup UNIT \\[Driver Name\\] — Send pickup inspection link\n` +
            `/dropoff UNIT — Send drop\\-off inspection link\n` +
            `/chatid — Show this group's ID\n` +
            `/ptiregister — Re\\-register this group\n` +
            `/ptiunregister — Remove from report list`,
            'MarkdownV2',
          )
        } else if (status === 'left' || status === 'kicked') {
          // Bot was removed
          await unregisterGroup(chatId)
        }
      }
      return NextResponse.json({ ok: true })
    }

    // ── Handle regular messages ──────────────────────────────────────────
    const message = body?.message || body?.edited_message
    if (!message) return NextResponse.json({ ok: true })

    const text: string   = (message.text || '').trim()
    const chatId: number = message.chat.id
    const chatTitle: string = message.chat.title ?? 'Unknown'
    const chatType: string  = message.chat.type ?? 'private'

    const parts = text.split(/\s+/)
    const cmd   = (parts[0]?.split('@')[0] ?? '').toLowerCase()

    // ── /chatid ────────────────────────────────────────────────────────
    if (cmd === '/chatid') {
      await sendMessage(chatId, `Chat ID: \`${chatId}\`\nTitle: ${escMd(chatTitle)}`, 'MarkdownV2')
      return NextResponse.json({ ok: true })
    }

    // ── /ptiregister ──────────────────────────────────────────────────
    if (cmd === '/ptiregister') {
      await registerGroup(chatId, chatTitle, chatType)
      const kvNote = isKvConfigured()
        ? '✅ Saved to database — persists across deployments.'
        : '⚠️ No database configured. Set UPSTASH\\_REDIS\\_REST\\_URL and UPSTASH\\_REDIS\\_REST\\_TOKEN in Vercel for persistent auto\\-registration.'
      await sendMessage(
        chatId,
        `✅ *Group registered for PTI reports\\!*\n\nGroup ID: \`${chatId}\`\n${kvNote}`,
        'MarkdownV2',
      )
      return NextResponse.json({ ok: true })
    }

    // ── /ptiunregister ────────────────────────────────────────────────
    if (cmd === '/ptiunregister') {
      await unregisterGroup(chatId)
      await sendMessage(chatId, '🔕 This group has been removed from PTI inspection reports.')
      return NextResponse.json({ ok: true })
    }

    // ── /ptigroups — list all registered groups (admin use) ───────────
    if (cmd === '/ptigroups') {
      const groups = await getRegisteredGroups()
      if (groups.length === 0) {
        await sendMessage(chatId, '📋 No groups currently registered\\.\nSet TELEGRAM\\_GROUP\\_CHAT\\_IDS in Vercel or add bot to a group to auto\\-register\\.', 'MarkdownV2')
      } else {
        const lines = groups.map((g, i) =>
          `${i + 1}\\. *${escMd(g.title)}*\n   ID: \`${g.chatId}\` \\(${escMd(g.type)}\\)`
        )
        await sendMessage(chatId, `📋 *Registered PTI groups \\(${groups.length}\\)*\n\n${lines.join('\n\n')}`, 'MarkdownV2')
      }
      return NextResponse.json({ ok: true })
    }

    // ── /start / /help ────────────────────────────────────────────────
    if (cmd === '/start' || cmd === '/help') {
      await sendMessage(
        chatId,
        '🚛 *PTI Check Bot*\n\n' +
        'Send a command to generate an inspection link:\n\n' +
        '`/pickup UNIT` — Pickup \\(pre\\-trip\\)\n' +
        '`/dropoff UNIT` — Drop\\-off \\(post\\-trip\\)\n' +
        '`/pickup UNIT Driver Name` — Include driver name\n\n' +
        '*Group management:*\n' +
        '`/ptiregister` — Register this group for reports\n' +
        '`/ptiunregister` — Unregister this group\n' +
        '`/ptigroups` — List all registered groups\n' +
        '`/chatid` — Show this group\'s ID\n\n' +
        '_Add this bot to any group — it auto\\-registers and starts sending reports\\._',
        'MarkdownV2',
      )
      return NextResponse.json({ ok: true })
    }

    // ── /pickup / /dropoff ────────────────────────────────────────────
    if (cmd === '/pickup' || cmd === '/dropoff') {
      const unit       = parts[1]
      const driverName = parts.slice(2).filter((w) => !w.startsWith('@')).join(' ')
      const type       = cmd === '/pickup' ? 'PICKUP' : 'DROP_OFF'
      const typeLabel  = type === 'PICKUP' ? '▲ PICKUP' : '▼ DROP\\-OFF'

      if (!unit) {
        await sendMessage(chatId, `⚠️ Please include the unit number\\. Example: \`/${cmd.slice(1)} UNIT\``, 'MarkdownV2')
        return NextResponse.json({ ok: true })
      }

      const params = new URLSearchParams({ unit, type })
      if (driverName) params.set('driver', driverName)
      const link = `${APP_URL}/inspection/start?${params.toString()}`

      const driverLine = driverName ? `\nDriver: *${escMd(driverName)}*` : ''
      await sendMessage(
        chatId,
        `🔗 *${typeLabel} Inspection*\n` +
        `Unit: *${escMd(unit)}*${driverLine}\n\n` +
        `[Open on phone](${link})\n\n` +
        `_Share this link with the driver — no login needed_`,
        'MarkdownV2',
      )
      return NextResponse.json({ ok: true })
    }

    // ── /status ────────────────────────────────────────────────────────
    if (cmd === '/status') {
      const unit = parts[1]
      if (!unit) {
        await sendMessage(chatId, '⚠️ Usage: `/status UNIT`', 'MarkdownV2')
        return NextResponse.json({ ok: true })
      }
      await sendMessage(chatId, `📊 *Unit ${escMd(unit)}*\n_No inspections on record yet_`, 'MarkdownV2')
      return NextResponse.json({ ok: true })
    }

    // ── Unknown command (only reply to commands, ignore plain messages) ─
    if (cmd.startsWith('/')) {
      await sendMessage(chatId, 'Unknown command\\. Send /help to see what I can do\\.', 'MarkdownV2')
    }
    return NextResponse.json({ ok: true })

  } catch (err) {
    console.error('Bot webhook error:', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
