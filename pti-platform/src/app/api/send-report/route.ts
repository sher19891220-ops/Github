import { NextRequest, NextResponse } from 'next/server'
import { sendMessage, sendMediaGroup } from '@/lib/tg'
import { getAllTargetChatIds } from '@/lib/kv'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    // body: { action: 'text' | 'photos', text?: string, photos?: {dataUrl, caption}[] }

    if (!process.env.TELEGRAM_BOT_TOKEN) {
      return NextResponse.json({ ok: false, error: 'Bot token not configured' }, { status: 500 })
    }

    const chatIds = await getAllTargetChatIds()
    if (chatIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'No target groups configured. Add bot to a group or set TELEGRAM_GROUP_CHAT_IDS.' }, { status: 400 })
    }

    if (body.action === 'text') {
      await Promise.allSettled(chatIds.map((id) => sendMessage(id, body.text ?? '')))
      return NextResponse.json({ ok: true, sentTo: chatIds.length })
    }

    if (body.action === 'photos') {
      const photos: { dataUrl: string; caption: string }[] = body.photos ?? []
      if (photos.length === 0) return NextResponse.json({ ok: true })

      // Send in batches of 10 (Telegram limit) to ALL groups
      for (let i = 0; i < photos.length; i += 10) {
        const batch = photos.slice(i, i + 10)
        await Promise.allSettled(chatIds.map((id) => sendMediaGroup(id, batch)))
      }
      return NextResponse.json({ ok: true, sentTo: chatIds.length })
    }

    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    console.error('send-report error:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
