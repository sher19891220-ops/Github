// Telegram Bot API helpers — used by both the webhook and send-report API

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

function apiUrl(method: string) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`
}

// Send a plain-text or Markdown message
export async function sendMessage(
  chatId: number,
  text: string,
  parseMode: 'Markdown' | 'MarkdownV2' | 'HTML' = 'Markdown',
) {
  if (!BOT_TOKEN) return null
  const res = await fetch(apiUrl('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      link_preview_options: { is_disabled: true },
    }),
  })
  return res.json()
}

// Send a batch of photos as a media group (max 10 per call)
export async function sendMediaGroup(
  chatId: number,
  photos: { dataUrl: string; caption: string }[],
) {
  if (!BOT_TOKEN || photos.length === 0) return

  const form = new FormData()
  const media: object[] = []

  for (let j = 0; j < photos.length; j++) {
    const p = photos[j]
    const base64 = p.dataUrl.split(',')[1]
    if (!base64) continue
    const buffer = Buffer.from(base64, 'base64')
    const blob = new Blob([buffer], { type: 'image/jpeg' })
    const fieldName = `photo${j}`
    form.append(fieldName, blob, `${p.caption.replace(/[\s—\/]+/g, '_')}.jpg`)
    media.push({ type: 'photo', media: `attach://${fieldName}`, caption: p.caption })
  }

  if (media.length === 0) return
  form.append('chat_id', chatId.toString())
  form.append('media', JSON.stringify(media))

  return fetch(apiUrl('sendMediaGroup'), { method: 'POST', body: form })
}

// Broadcast a text message to multiple chats
export async function broadcast(chatIds: number[], text: string) {
  await Promise.allSettled(chatIds.map((id) => sendMessage(id, text)))
}

export function escMd(s: string) {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1')
}
