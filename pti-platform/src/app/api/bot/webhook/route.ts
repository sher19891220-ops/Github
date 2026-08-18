import { NextRequest, NextResponse } from 'next/server'
import { sendMessage } from '@/lib/tg'
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

  // Register commands so they appear in Telegram's "/" autocomplete menu
  const commands = [
    { command: 'pickup',       description: 'Send a pickup inspection link' },
    { command: 'dropoff',      description: 'Send a drop-off inspection link' },
    { command: 'link',         description: 'Get a pinnable universal inspection link' },
    { command: 'chatid',       description: 'Show this group\'s Telegram ID' },
    { command: 'help',         description: 'Show all commands' },
    { command: 'ptiregister',  description: 'Register this group for PTI reports' },
    { command: 'ptiunregister',description: 'Unregister this group from PTI reports' },
    { command: 'ptigroups',    description: 'List all registered groups' },
  ]
  const cmdRes = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
      cache: 'no-store',
    },
  ).then(r => r.json())

  const info = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`,
    { cache: 'no-store' },
  ).then(r => r.json())
  return NextResponse.json({ webhookUrl, tgUrl, telegram: data, commands: cmdRes, info })
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
            `👋 <b>PTI Check Bot activated in this group!</b>\n\n` +
            `Group ID: <code>${chatId}</code>\n` +
            `Group: <b>${title}</b>\n\n` +
            `✅ This group is now registered to receive PTI inspection reports.\n\n` +
            `<b>Commands:</b>\n` +
            `/pickup — Send pickup inspection link\n` +
            `/dropoff — Send drop-off inspection link\n` +
            `/link — Get a pinnable universal inspection link\n` +
            `/chatid — Show this group's ID\n` +
            `/ptiregister — Re-register this group\n` +
            `/ptiunregister — Remove from report list`,
            'HTML',
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
      await sendMessage(chatId, `Chat ID: <code>${chatId}</code>\nTitle: ${chatTitle}`, 'HTML')
      return NextResponse.json({ ok: true })
    }

    // ── /ptiregister ──────────────────────────────────────────────────
    if (cmd === '/ptiregister') {
      await registerGroup(chatId, chatTitle, chatType)
      const kvNote = isKvConfigured()
        ? '✅ Saved to database — persists across deployments.'
        : '⚠️ No database configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel for persistent auto-registration.'
      await sendMessage(
        chatId,
        `✅ <b>Group registered for PTI reports!</b>\n\nGroup ID: <code>${chatId}</code>\n${kvNote}`,
        'HTML',
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
        await sendMessage(chatId, '📋 No groups currently registered.\nSet TELEGRAM_GROUP_CHAT_IDS in Vercel or add bot to a group to auto-register.', 'HTML')
      } else {
        const lines = groups.map((g, i) =>
          `${i + 1}. <b>${g.title}</b>\n   ID: <code>${g.chatId}</code> (${g.type})`
        )
        await sendMessage(chatId, `📋 <b>Registered PTI groups (${groups.length})</b>\n\n${lines.join('\n\n')}`, 'HTML')
      }
      return NextResponse.json({ ok: true })
    }

    // ── /start / /help ────────────────────────────────────────────────
    if (cmd === '/start' || cmd === '/help') {
      await sendMessage(
        chatId,
        '🚛 <b>PTI Check Bot</b>\n\n' +
        '<b>Quick commands:</b>\n' +
        '<code>/link</code> — Get a pinnable universal inspection link\n' +
        '<code>/pickup</code> — Send pickup inspection link\n' +
        '<code>/dropoff</code> — Send drop-off inspection link\n\n' +
        '<b>Group management:</b>\n' +
        '<code>/ptiregister</code> — Register this group for reports\n' +
        '<code>/ptiunregister</code> — Unregister this group\n' +
        '<code>/ptigroups</code> — List all registered groups\n' +
        '<code>/chatid</code> — Show this group\'s ID\n\n' +
        '<i>Add this bot to any group — it auto-registers and starts sending reports.</i>',
        'HTML',
      )
      return NextResponse.json({ ok: true })
    }

    // ── /link — generate a pinnable universal inspection link ─────────
    if (cmd === '/link') {
      const groupLink = `${APP_URL}/inspection/start?group=${chatId}`
      await sendMessage(
        chatId,
        `📌 <b>Universal Inspection Link</b>\n\n` +
        `Drivers can use this link any time — no command needed.\n\n` +
        `<a href="${groupLink}">Open PTI Inspection</a>\n\n` +
        `<code>${groupLink}</code>\n\n` +
        `<i>Pin this message so drivers can find it easily.</i>`,
        'HTML',
      )
      return NextResponse.json({ ok: true })
    }

    // ── /pickup / /dropoff ────────────────────────────────────────────
    if (cmd === '/pickup' || cmd === '/dropoff') {
      const type      = cmd === '/pickup' ? 'PICKUP' : 'DROP_OFF'
      const typeLabel = type === 'PICKUP' ? '▲ PICKUP' : '▼ DROP-OFF'
      const link      = `${APP_URL}/inspection/start?type=${type}&group=${chatId}`

      await sendMessage(
        chatId,
        `🔗 <b>${typeLabel} Inspection</b>\n\n` +
        `Tap the link to start — driver enters unit number in the app:\n\n` +
        `<a href="${link}">Open PTI Inspection</a>\n\n` +
        `<code>${link}</code>`,
        'HTML',
      )
      return NextResponse.json({ ok: true })
    }

    // ── /status ────────────────────────────────────────────────────────
    if (cmd === '/status') {
      const unit = parts[1]
      if (!unit) {
        await sendMessage(chatId, '⚠️ Usage: <code>/status UNIT</code>', 'HTML')
        return NextResponse.json({ ok: true })
      }
      await sendMessage(chatId, `📊 <b>Unit ${unit}</b>\n<i>No inspections on record yet</i>`, 'HTML')
      return NextResponse.json({ ok: true })
    }

    // ── Unknown command (only reply to commands, ignore plain messages) ─
    if (cmd.startsWith('/')) {
      await sendMessage(chatId, 'Unknown command. Send /help to see what I can do.', 'HTML')
    }
    return NextResponse.json({ ok: true })

  } catch (err) {
    console.error('Bot webhook error:', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
