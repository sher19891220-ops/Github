import { config } from '../config';
import { log } from '../logger';

const TELEGRAM_API = 'https://api.telegram.org';
/** Telegram rejects messages over 4096 characters. */
export const MAX_MESSAGE_LENGTH = 4096;
/** Captions attached to a video are capped well below the message limit. */
export const MAX_CAPTION_LENGTH = 1024;
/**
 * Bot API limits. These are the *hosted* api.telegram.org limits — a
 * self-hosted Bot API server raises the upload ceiling to 2000 MB.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** When Telegram fetches the file itself, the ceiling is far lower. */
export const MAX_URL_FETCH_BYTES = 20 * 1024 * 1024;

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
    readonly description?: string,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    data?: string;
    from?: TelegramUser;
    message?: TelegramMessage;
  };
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number | string; type: string; title?: string };
  date: number;
  text?: string;
  entities?: { offset: number; length: number; type: string }[];
}

export interface SendOptions {
  parseMode?: 'HTML' | 'MarkdownV2';
  disableWebPagePreview?: boolean;
  disableNotification?: boolean;
  replyToMessageId?: number;
}

export class TelegramClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { token?: string; fetchImpl?: typeof fetch } = {}) {
    this.token = options.token ?? config.telegramToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
    };

    if (!response.ok || !payload.ok) {
      throw new TelegramError(
        `Telegram ${method} failed: ${payload.description ?? response.status}`,
        payload.error_code,
        payload.description,
      );
    }
    return payload.result as T;
  }

  /**
   * Sends text, splitting on line boundaries when it exceeds Telegram's limit
   * so long digests arrive intact instead of being rejected.
   */
  async sendMessage(
    chatId: string | number,
    text: string,
    options: SendOptions = {},
  ): Promise<TelegramMessage[]> {
    const chunks = splitMessage(text);
    const sent: TelegramMessage[] = [];
    for (const [index, chunk] of chunks.entries()) {
      sent.push(
        await this.call<TelegramMessage>('sendMessage', {
          chat_id: chatId,
          text: chunk,
          parse_mode: options.parseMode ?? 'HTML',
          disable_web_page_preview: options.disableWebPagePreview ?? true,
          disable_notification: options.disableNotification ?? false,
          ...(index === 0 && options.replyToMessageId
            ? { reply_to_message_id: options.replyToMessageId }
            : {}),
        }),
      );
    }
    return sent;
  }

  /**
   * Asks Telegram to fetch the video itself. Free and fast, but only works
   * when the URL needs no auth header and is under ~20 MB.
   */
  async sendVideoByUrl(
    chatId: string | number,
    url: string,
    caption: string,
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendVideo', {
      chat_id: chatId,
      video: url,
      caption: truncateCaption(caption),
      parse_mode: 'HTML',
      supports_streaming: true,
    });
  }

  /** Uploads the bytes directly. Needed when the source URL requires auth. */
  async sendVideoUpload(
    chatId: string | number,
    bytes: Uint8Array,
    filename: string,
    caption: string,
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', truncateCaption(caption));
    form.append('parse_mode', 'HTML');
    form.append('supports_streaming', 'true');
    form.append('video', new Blob([bytes], { type: 'video/mp4' }), filename);

    const response = await this.fetchImpl(`${TELEGRAM_API}/bot${this.token}/sendVideo`, {
      method: 'POST',
      body: form,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: TelegramMessage;
      error_code?: number;
      description?: string;
    };
    if (!response.ok || !payload.ok) {
      throw new TelegramError(
        `Telegram sendVideo (upload) failed: ${payload.description ?? response.status}`,
        payload.error_code,
        payload.description,
      );
    }
    return payload.result as TelegramMessage;
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
  }

  async setWebhook(url: string, secretToken?: string): Promise<boolean> {
    return this.call<boolean>('setWebhook', {
      url,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: true,
      ...(secretToken ? { secret_token: secretToken } : {}),
    });
  }

  async deleteWebhook(): Promise<boolean> {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: false });
  }

  async getWebhookInfo(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>('getWebhookInfo', {});
  }

  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {});
  }
}

/** Tag names left open in a fragment, outermost first. */
function unclosedTags(html: string): string[] {
  const stack: string[] = [];
  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const name = (match[2] ?? '').toLowerCase();
    if (match[1]) {
      const index = stack.lastIndexOf(name);
      if (index !== -1) stack.splice(index, 1);
    } else {
      stack.push(name);
    }
  }
  return stack;
}

/**
 * Trims a caption to Telegram's limit while keeping the HTML valid.
 *
 * Two ways a naive slice breaks `parse_mode: HTML`: it can cut a tag in half
 * (`<b`), and it can leave one open (`<b>text`). Telegram rejects both with
 * "can't parse entities", losing the whole clip. This drops a partial tag,
 * closes anything still open, and re-trims if the closers push it back over.
 */
export function truncateCaption(caption: string, limit = MAX_CAPTION_LENGTH): string {
  if (caption.length <= limit) return caption;

  let budget = limit - 1;
  for (let attempt = 0; attempt < 4 && budget > 0; attempt += 1) {
    let cut = caption.slice(0, budget);
    const lastOpen = cut.lastIndexOf('<');
    const lastClose = cut.lastIndexOf('>');
    if (lastOpen > lastClose) cut = cut.slice(0, lastOpen);

    const closers = unclosedTags(cut)
      .reverse()
      .map((name) => `</${name}>`)
      .join('');
    const result = `${cut.trimEnd()}…${closers}`;
    if (result.length <= limit) return result;
    budget -= closers.length + 1;
  }
  return caption.slice(0, limit);
}

/** Splits on newlines, falling back to hard slices for pathological input. */
export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

let cached: TelegramClient | undefined;

export function getTelegramClient(): TelegramClient {
  if (!cached) cached = new TelegramClient();
  return cached;
}

/** Test seam. */
export function resetTelegramClient(): void {
  cached = undefined;
}

/** Sends to the default channel, logging rather than throwing on failure. */
export async function notifyDefaultChat(text: string, options?: SendOptions): Promise<boolean> {
  try {
    await getTelegramClient().sendMessage(config.telegramChatId, text, options);
    return true;
  } catch (error) {
    log.error('Failed to deliver Telegram message', { error });
    return false;
  }
}
