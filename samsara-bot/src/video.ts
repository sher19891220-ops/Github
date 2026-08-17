import { config } from './config';
import { log } from './logger';
import type { VideoRef } from './samsara/events';
import {
  MAX_UPLOAD_BYTES,
  MAX_URL_FETCH_BYTES,
  type TelegramClient,
} from './telegram/api';

/**
 * Delivers Samsara clips into a Telegram chat.
 *
 * Three tiers, cheapest first:
 *
 *   1. Hand Telegram the URL and let it fetch (no bytes through us, ~20 MB cap,
 *      and only works if the URL needs no auth header).
 *   2. Download with the Samsara bearer token, then upload the bytes (50 MB cap
 *      on hosted api.telegram.org).
 *   3. Give up on the clip and report the URL so the message can link it.
 *
 * Which tier actually fires depends on whether Samsara's download URLs are
 * pre-signed or bearer-protected, and on how big the clips are — both of which
 * need a real event to establish. The tiering means the bot degrades to a link
 * rather than failing, whichever way that lands.
 */

export interface VideoDelivery {
  label: string;
  url: string;
  status: 'sent-by-url' | 'sent-by-upload' | 'too-large' | 'failed';
  bytes?: number;
  reason?: string;
}

export interface VideoOptions {
  /** Wall-clock budget; serverless functions have a hard ceiling. */
  deadline?: number;
  fetchImpl?: typeof fetch;
  maxUploadBytes?: number;
}

async function download(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array } | { error: string; size?: number }> {
  // Samsara media URLs may be pre-signed; sending the token too is harmless
  // when it is ignored, and necessary when it is not.
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${config.samsaraToken}` },
    signal,
  });
  if (!response.ok) return { error: `HTTP ${response.status}` };

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { error: 'larger than the Telegram upload limit', size: declared };
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    return { error: 'larger than the Telegram upload limit', size: buffer.byteLength };
  }
  return { bytes: buffer };
}

export async function deliverVideos(
  telegram: TelegramClient,
  chatId: string | number,
  videos: VideoRef[],
  caption: string,
  options: VideoOptions = {},
): Promise<VideoDelivery[]> {
  if (!videos.length) return [];

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxUploadBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const deadline = options.deadline ?? Date.now() + 45_000;
  const results: VideoDelivery[] = [];

  for (const video of videos) {
    const label = video.label;
    if (Date.now() > deadline) {
      results.push({ ...video, status: 'failed', reason: 'ran out of time' });
      continue;
    }

    const videoCaption = `${caption}\n<i>${label}</i>`;

    // Tier 1 — let Telegram fetch it.
    try {
      await telegram.sendVideoByUrl(chatId, video.url, videoCaption);
      results.push({ ...video, status: 'sent-by-url' });
      continue;
    } catch (error) {
      log.info('Telegram could not fetch the clip; falling back to upload', {
        label,
        error,
      });
    }

    // Tier 2 — pull the bytes ourselves and upload them.
    if (Date.now() > deadline) {
      results.push({ ...video, status: 'failed', reason: 'ran out of time' });
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, deadline - Date.now()));
    try {
      const downloaded = await download(video.url, fetchImpl, maxUploadBytes, controller.signal);
      if ('error' in downloaded) {
        results.push({
          ...video,
          status: downloaded.size ? 'too-large' : 'failed',
          bytes: downloaded.size,
          reason: downloaded.error,
        });
        continue;
      }
      await telegram.sendVideoUpload(chatId, downloaded.bytes, `${label}.mp4`, videoCaption);
      results.push({ ...video, status: 'sent-by-upload', bytes: downloaded.bytes.byteLength });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn('Clip delivery failed; the alert will link it instead', { label, reason });
      results.push({ ...video, status: 'failed', reason });
    } finally {
      clearTimeout(timer);
    }
  }

  return results;
}

/** Clips that could not be sent, so the alert message can link them instead. */
export function undelivered(results: VideoDelivery[]): VideoDelivery[] {
  return results.filter(
    (result) => result.status !== 'sent-by-url' && result.status !== 'sent-by-upload',
  );
}

export { MAX_URL_FETCH_BYTES };
