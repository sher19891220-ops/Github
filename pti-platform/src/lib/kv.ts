// Upstash Redis REST client — pure fetch, no packages required.
// Falls back gracefully when env vars are not set.

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

async function redis<T = unknown>(...args: (string | number)[]): Promise<T | null> {
  if (!REDIS_URL || !REDIS_TOKEN) return null
  try {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      // Vercel edge: ensure no caching
      cache: 'no-store',
    })
    const json = await res.json()
    return json.result as T
  } catch {
    return null
  }
}

export const isKvConfigured = () => !!(REDIS_URL && REDIS_TOKEN)

// ── Group registry ──────────────────────────────────────────

export interface RegisteredGroup {
  chatId: number
  title: string
  type: string
  registeredAt: number
}

export async function registerGroup(chatId: number, title: string, type = 'group') {
  const key = `pti:group:${chatId}`
  await redis('HSET', key, 'chatId', chatId, 'title', title, 'type', type, 'registeredAt', Date.now())
  await redis('SADD', 'pti:groups', chatId.toString())
}

export async function unregisterGroup(chatId: number) {
  await redis('DEL', `pti:group:${chatId}`)
  await redis('SREM', 'pti:groups', chatId.toString())
}

export async function getRegisteredGroups(): Promise<RegisteredGroup[]> {
  const members = await redis<string[]>('SMEMBERS', 'pti:groups')
  if (!members || members.length === 0) return []

  const groups: RegisteredGroup[] = []
  for (const id of members) {
    const fields = await redis<string[]>('HGETALL', `pti:group:${id}`)
    if (!fields) continue
    // HGETALL returns [field, value, field, value, ...]
    const obj: Record<string, string> = {}
    for (let i = 0; i < fields.length - 1; i += 2) obj[fields[i]] = fields[i + 1]
    if (obj.chatId) {
      groups.push({
        chatId: Number(obj.chatId),
        title: obj.title ?? 'Unknown',
        type: obj.type ?? 'group',
        registeredAt: Number(obj.registeredAt ?? 0),
      })
    }
  }
  return groups
}

// Return the flat list of chat IDs to broadcast to.
// Priority: Redis → TELEGRAM_GROUP_CHAT_IDS env var → TELEGRAM_GROUP_CHAT_ID env var
export async function getAllTargetChatIds(): Promise<number[]> {
  const seen = new Set<number>()

  // 1. Redis-registered groups
  const redisGroups = await getRegisteredGroups()
  redisGroups.forEach((g) => seen.add(g.chatId))

  // 2. Static env var list (comma or pipe separated)
  const envList = process.env.TELEGRAM_GROUP_CHAT_IDS ?? ''
  envList.split(/[,|]/).map((s) => s.trim()).filter(Boolean).forEach((s) => {
    const n = Number(s)
    if (!isNaN(n)) seen.add(n)
  })

  // 3. Legacy single env var
  const single = process.env.TELEGRAM_GROUP_CHAT_ID
  if (single) {
    const n = Number(single)
    if (!isNaN(n)) seen.add(n)
  }

  return Array.from(seen)
}
