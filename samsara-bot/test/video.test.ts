import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverVideos, undelivered } from '../src/video';
import { truncateCaption } from '../src/telegram/api';
import type { TelegramClient } from '../src/telegram/api';

const VIDEOS = [{ label: 'Road-facing', url: 'https://media.samsara.test/clip.mp4' }];

function fakeTelegram(overrides: Partial<TelegramClient> = {}): TelegramClient {
  return {
    sendVideoByUrl: vi.fn(async () => ({}) as never),
    sendVideoUpload: vi.fn(async () => ({}) as never),
    ...overrides,
  } as unknown as TelegramClient;
}

beforeEach(() => {
  process.env['SAMSARA_API_TOKEN'] = 'token';
});

describe('deliverVideos', () => {
  it('does nothing when there are no clips', async () => {
    const telegram = fakeTelegram();
    expect(await deliverVideos(telegram, '-100', [], 'caption')).toEqual([]);
    expect(telegram.sendVideoByUrl).not.toHaveBeenCalled();
  });

  it('prefers letting Telegram fetch the URL', async () => {
    const telegram = fakeTelegram();
    const results = await deliverVideos(telegram, '-100', VIDEOS, 'caption');

    expect(results[0]?.status).toBe('sent-by-url');
    expect(telegram.sendVideoUpload).not.toHaveBeenCalled();
    expect(undelivered(results)).toHaveLength(0);
  });

  it('downloads and uploads when Telegram cannot fetch the URL', async () => {
    const telegram = fakeTelegram({
      sendVideoByUrl: vi.fn(async () => {
        throw new Error('failed to get HTTP URL content');
      }) as never,
    });
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])));

    const results = await deliverVideos(telegram, '-100', VIDEOS, 'caption', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(results[0]?.status).toBe('sent-by-upload');
    expect(results[0]?.bytes).toBe(4);
    expect(telegram.sendVideoUpload).toHaveBeenCalledOnce();
    // The Samsara token must accompany the download.
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer token');
  });

  it('reports a clip that exceeds the upload limit instead of buffering it', async () => {
    const telegram = fakeTelegram({
      sendVideoByUrl: vi.fn(async () => {
        throw new Error('file too big');
      }) as never,
    });
    const fetchImpl = vi.fn(
      async () => new Response('x', { headers: { 'content-length': String(80 * 1024 * 1024) } }),
    );

    const results = await deliverVideos(telegram, '-100', VIDEOS, 'caption', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(results[0]?.status).toBe('too-large');
    expect(telegram.sendVideoUpload).not.toHaveBeenCalled();
    expect(undelivered(results)).toHaveLength(1);
  });

  it('marks a clip failed when the download 404s', async () => {
    const telegram = fakeTelegram({
      sendVideoByUrl: vi.fn(async () => {
        throw new Error('nope');
      }) as never,
    });
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));

    const results = await deliverVideos(telegram, '-100', VIDEOS, 'caption', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.reason).toContain('404');
  });

  it('stops working once the deadline has passed', async () => {
    const telegram = fakeTelegram();
    const results = await deliverVideos(telegram, '-100', VIDEOS, 'caption', {
      deadline: Date.now() - 1,
    });

    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.reason).toBe('ran out of time');
    expect(telegram.sendVideoByUrl).not.toHaveBeenCalled();
  });
});

describe('truncateCaption', () => {
  it('leaves short captions alone', () => {
    expect(truncateCaption('short', 100)).toBe('short');
  });

  it('trims to the limit', () => {
    expect(truncateCaption('x'.repeat(50), 10).length).toBeLessThanOrEqual(10);
  });

  it('never leaves a half-written HTML tag', () => {
    const output = truncateCaption(`${'x'.repeat(15)}<b>bold`, 20);
    expect(output).not.toContain('<b');
    expect(output.endsWith('…')).toBe(true);
  });

  it('closes a tag that survives truncation', () => {
    const output = truncateCaption(`<b>${'x'.repeat(50)}</b>`, 30);
    expect(output.length).toBeLessThanOrEqual(30);
    expect(output).toContain('<b>');
    expect(output.endsWith('</b>')).toBe(true);
  });

  it('closes nested tags in the right order', () => {
    const output = truncateCaption(`<b><i>${'x'.repeat(60)}</i></b>`, 40);
    expect(output.length).toBeLessThanOrEqual(40);
    expect(output.endsWith('</i></b>')).toBe(true);
  });

  it('respects the limit even when the caption is nothing but tags', () => {
    const output = truncateCaption('<b><i><u><s>'.repeat(10), 20);
    expect(output.length).toBeLessThanOrEqual(20);
  });
});
