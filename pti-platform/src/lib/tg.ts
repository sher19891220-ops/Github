// Telegram Bot API helpers — used by both the webhook and send-report API

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

function apiUrl(method: string) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`
}

export interface TgResult {
  ok: boolean
  error?: string
  raw?: unknown
}

// Send a plain-text or Markdown message. Unlike before, this now actually
// checks Telegram's own response — a fetch that "succeeds" at the HTTP
// level can still carry {ok:false, description:"..."} from Telegram
// itself (bad chat_id, bot not a member, blocked, etc.), and that was
// previously being silently discarded.
export async function sendMessage(
  chatId: number,
  text: string,
  parseMode: 'Markdown' | 'MarkdownV2' | 'HTML' = 'Markdown',
): Promise<TgResult> {
  if (!BOT_TOKEN) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' }
  try {
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
    const data = await res.json()
    if (!res.ok || data?.ok === false) {
      return { ok: false, error: data?.description || `HTTP ${res.status}`, raw: data }
    }
    return { ok: true, raw: data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Send a batch of photos as a media group (max 10 per call). Same fix —
// previously returned the raw unchecked fetch Promise with no error
// visibility at all.
export async function sendMediaGroup(
  chatId: number,
  photos: { dataUrl: string; caption: string }[],
): Promise<TgResult> {
  if (!BOT_TOKEN) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' }
  if (photos.length === 0) return { ok: true }

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

  if (media.length === 0) return { ok: false, error: 'No valid photos in batch (bad dataUrl?)' }
  form.append('chat_id', chatId.toString())
  form.append('media', JSON.stringify(media))

  try {
    const res = await fetch(apiUrl('sendMediaGroup'), { method: 'POST', body: form })
    const data = await res.json()
    if (!res.ok || data?.ok === false) {
      return { ok: false, error: data?.description || `HTTP ${res.status}`, raw: data }
    }
    return { ok: true, raw: data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Broadcast a text message to multiple chats
export async function broadcast(chatIds: number[], text: string) {
  return Promise.all(chatIds.map((id) => sendMessage(id, text)))
}

export function escMd(s: string) {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1')
}
