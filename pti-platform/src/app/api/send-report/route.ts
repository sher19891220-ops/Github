import { NextRequest, NextResponse } from 'next/server'

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN
const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID

export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    // body: { action: 'text' | 'photos', text?: string, photos?: {dataUrl: string, caption: string}[] }

    if (!BOT_TOKEN || !GROUP_CHAT_ID) {
      return NextResponse.json({ ok: false, error: 'Telegram not configured' }, { status: 500 })
    }

    if (body.action === 'text') {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: GROUP_CHAT_ID,
          text: body.text,
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
        }),
      })
      const data = await res.json()
      if (!data.ok) return NextResponse.json({ ok: false, error: data.description }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'photos') {
      const photos: { dataUrl: string; caption: string }[] = body.photos ?? []
      if (photos.length === 0) return NextResponse.json({ ok: true })

      // Send in batches of up to 10 (Telegram limit)
      for (let i = 0; i < photos.length; i += 10) {
        const batch = photos.slice(i, i + 10)
        const form = new FormData()
        const media: object[] = []

        for (let j = 0; j < batch.length; j++) {
          const p = batch[j]
          const base64 = p.dataUrl.split(',')[1]
          if (!base64) continue
          const buffer = Buffer.from(base64, 'base64')
          const blob = new Blob([buffer], { type: 'image/jpeg' })
          const fieldName = `photo${j}`
          form.append(fieldName, blob, `${p.caption.replace(/[\s—]+/g, '_')}.jpg`)
          media.push({
            type: 'photo',
            media: `attach://${fieldName}`,
            caption: p.caption,
          })
        }

        if (media.length === 0) continue
        form.append('chat_id', GROUP_CHAT_ID)
        form.append('media', JSON.stringify(media))

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, {
          method: 'POST',
          body: form,
        })
      }

      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    console.error('send-report error:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
