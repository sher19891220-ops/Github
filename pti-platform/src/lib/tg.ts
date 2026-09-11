// Telegram Bot API helpers — used by both the webhook and send-report API

// Sending report messages/photos now uses Observer's own bot token
// (TELEGRAM_SEND_BOT_TOKEN), not @Pti_check_bot's. @Pti_check_bot has been
// found kicked from multiple real groups and forbidden from DMing users
// who never opened a chat with it directly — it simply isn't present
// where reports need to go. Observer is already a live, active member of
// every real group this app needs to reach, so delivery goes through it.
// Falls back to the old token only if the new one isn't configured yet,
// so this doesn't hard-break before the env var is added.
const SEND_BOT_TOKEN = process.env.TELEGRAM_SEND_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN

function apiUrl(method: string) {
  return `https://api.telegram.org/bot${SEND_BOT_TOKEN}/${method}`
}

export interface TgResult {
  ok: boolean
  error?: string
  raw?: unknown
}

// Send a plain-text or Markdown message. Actually checks Telegram's own
// response — a fetch that "succeeds" at the HTTP level can still carry
// {ok:false, description:"..."} from Telegram itself (bad chat_id, bot
// not a member, blocked, etc.), which was previously discarded silently.
export async function sendMessage(
  chatId: number,
  text: string,
  parseMode: 'Markdown' | 'MarkdownV2' | 'HTML' = 'Markdown',
): Promise<TgResult> {
  if (!SEND_BOT_TOKEN) return { ok: false, error: 'No bot token configured (TELEGRAM_SEND_BOT_TOKEN / TELEGRAM_BOT_TOKEN)' }
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

// Send a batch of photos as a media group (max 10 per call).
export async function sendMediaGroup(
  chatId: number,
  photos: { dataUrl: string; caption: string }[],
): Promise<TgResult> {
  if (!SEND_BOT_TOKEN) return { ok: false, error: 'No bot token configured (TELEGRAM_SEND_BOT_TOKEN / TELEGRAM_BOT_TOKEN)' }
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
