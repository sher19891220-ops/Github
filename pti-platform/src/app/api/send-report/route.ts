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

    // Use the specific source group if provided, otherwise fall back to all registered groups
    let chatIds: number[]
    if (body.chatId) {
      chatIds = [body.chatId]
    } else {
      chatIds = await getAllTargetChatIds()
      if (chatIds.length === 0) {
        return NextResponse.json({ ok: false, error: 'No target groups configured. Add bot to a group or set TELEGRAM_GROUP_CHAT_IDS.' }, { status: 400 })
      }
    }

    if (body.action === 'text') {
      const results = await Promise.all(chatIds.map((id) => sendMessage(id, body.text ?? '')))
      const failures = results
        .map((r, i) => ({ chatId: chatIds[i], ...r }))
        .filter((r) => !r.ok)

      if (failures.length > 0) {
        console.error('send-report text failures:', JSON.stringify(failures))
      }

      // Only claim success if EVERY target actually accepted the message —
      // previously this returned {ok:true} unconditionally regardless of
      // what Telegram actually reported back.
      return NextResponse.json({
        ok: failures.length === 0,
        sentTo: results.length - failures.length,
        failed: failures.length > 0 ? failures.map((f) => ({ chatId: f.chatId, error: f.error })) : undefined,
      }, { status: failures.length === results.length ? 502 : 200 })
    }

    if (body.action === 'photos') {
      const photos: { dataUrl: string; caption: string }[] = body.photos ?? []
      if (photos.length === 0) return NextResponse.json({ ok: true })

      const allFailures: { chatId: number; error?: string }[] = []
      let batchesAttempted = 0
      let batchesOk = 0

      for (let i = 0; i < photos.length; i += 10) {
        const batch = photos.slice(i, i + 10)
        const results = await Promise.all(chatIds.map((id) => sendMediaGroup(id, batch)))
        batchesAttempted += results.length
        results.forEach((r, idx) => {
          if (r.ok) batchesOk++
          else allFailures.push({ chatId: chatIds[idx], error: r.error })
        })
      }

      if (allFailures.length > 0) {
        console.error('send-report photo failures:', JSON.stringify(allFailures))
      }

      return NextResponse.json({
        ok: allFailures.length === 0,
        sentTo: batchesOk,
        failed: allFailures.length > 0 ? allFailures : undefined,
      }, { status: allFailures.length === batchesAttempted ? 502 : 200 })
    }

    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    console.error('send-report error:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
