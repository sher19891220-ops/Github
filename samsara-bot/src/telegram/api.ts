import { config } from '../config';
import { log } from '../logger';

const TELEGRAM_API = 'https://api.telegram.org';
/** Telegram rejects messages over 4096 characters. */
export const MAX_MESSAGE_LENGTH = 4096;

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
