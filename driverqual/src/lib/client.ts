export async function api<T>(
  url: string,
  init?: RequestInit & { json?: unknown },
): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const { json, ...rest } = init ?? {};
  const response = await fetch(url, {
    ...rest,
    headers: json ? { 'Content-Type': 'application/json', ...(rest.headers ?? {}) } : rest.headers,
    body: json ? JSON.stringify(json) : rest.body,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  return { ok: response.ok, status: response.status, data };
}
