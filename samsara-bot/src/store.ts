import { config } from './config';
import { log } from './logger';

/**
 * Tiny key/value store used for alert de-duplication and poll watermarks.
 *
 * Backed by Upstash Redis (the same REST API Vercel KV exposes) when
 * credentials are present. Without them it degrades to a per-instance memory
 * map: still useful locally, but serverless instances come and go, so
 * duplicate alerts become possible. `isPersistent` lets callers say so.
 */
export interface Store {
  readonly isPersistent: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Returns true if the key was free (i.e. this is the first sighting). */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

class MemoryStore implements Store {
  readonly isPersistent = false;
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  private live(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== 0 && entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0,
    });
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.live(key) !== null) return false;
    await this.set(key, '1', ttlSeconds);
    return true;
  }
}

class UpstashStore implements Store {
  readonly isPersistent = true;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async command(args: (string | number)[]): Promise<unknown> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args.map(String)),
    });
    if (!response.ok) {
      throw new Error(`Upstash ${args[0]} failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { result?: unknown; error?: string };
    if (payload.error) throw new Error(`Upstash ${args[0]} failed: ${payload.error}`);
    return payload.result ?? null;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.command(['GET', key]);
    return typeof result === 'string' ? result : null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const args: (string | number)[] = ['SET', key, value];
    if (ttlSeconds) args.push('EX', ttlSeconds);
    await this.command(args);
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.command(['SET', key, '1', 'EX', ttlSeconds, 'NX']);
    return result !== null;
  }
}

let cached: Store | undefined;

export function getStore(): Store {
  if (cached) return cached;
  const url = config.upstashUrl;
  const token = config.upstashToken;
  if (url && token) {
    cached = new UpstashStore(url.replace(/\/+$/, ''), token);
  } else {
    log.warn('No Redis credentials found; alert de-duplication is best-effort only', {
      hint: 'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or the KV_REST_API_* pair)',
    });
    cached = new MemoryStore();
  }
  return cached;
}

/** Test seam. */
export function resetStore(): void {
  cached = undefined;
}

export { MemoryStore, UpstashStore };
