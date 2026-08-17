import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, UpstashStore } from '../src/store';

describe('MemoryStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('claims a key once', async () => {
    const store = new MemoryStore();
    expect(await store.claim('k', 60)).toBe(true);
    expect(await store.claim('k', 60)).toBe(false);
  });

  it('lets a claim expire', async () => {
    const store = new MemoryStore();
    await store.claim('k', 60);
    vi.advanceTimersByTime(61_000);
    expect(await store.claim('k', 60)).toBe(true);
  });

  it('round-trips values and expires them', async () => {
    const store = new MemoryStore();
    await store.set('a', 'value', 10);
    expect(await store.get('a')).toBe('value');
    vi.advanceTimersByTime(11_000);
    expect(await store.get('a')).toBeNull();
  });

  it('keeps values with no TTL', async () => {
    const store = new MemoryStore();
    await store.set('a', 'value');
    vi.advanceTimersByTime(10 ** 7);
    expect(await store.get('a')).toBe('value');
  });
});

describe('UpstashStore', () => {
  it('issues SET ... NX and reads the null result as "already claimed"', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: 'OK' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: null })));
    vi.stubGlobal('fetch', fetchImpl);

    const store = new UpstashStore('https://redis.test', 'token');
    expect(await store.claim('k', 60)).toBe(true);
    expect(await store.claim('k', 60)).toBe(false);

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual(['SET', 'k', '1', 'EX', '60', 'NX']);

    vi.unstubAllGlobals();
  });

  it('surfaces transport failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const store = new UpstashStore('https://redis.test', 'token');
    await expect(store.get('k')).rejects.toThrow(/Upstash GET failed/);
    vi.unstubAllGlobals();
  });
});
