/**
 * Environment-backed configuration.
 *
 * Everything is read lazily (on access, not at import time) so that serverless
 * cold starts never crash on a missing variable and tests can swap the env.
 */

export class ConfigError extends Error {}

function read(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function requireEnv(name: string): string {
  const value = read(name);
  if (!value) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return read(name) ?? fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = read(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalList(name: string): string[] {
  const raw = read(name);
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export const config = {
  /** Samsara REST base. Use https://api.eu.samsara.com for EU-hosted orgs. */
  get samsaraBaseUrl(): string {
    return optional('SAMSARA_API_BASE', 'https://api.samsara.com').replace(/\/+$/, '');
  },
  get samsaraToken(): string {
    return requireEnv('SAMSARA_API_TOKEN');
  },
  /** Shared secret configured on the Samsara webhook, used for HMAC verification. */
  get samsaraWebhookSecret(): string | undefined {
    return read('SAMSARA_WEBHOOK_SECRET');
  },

  get telegramToken(): string {
    return requireEnv('TELEGRAM_BOT_TOKEN');
  },
  /** Default destination for alerts, digests and PTI reports. */
  get telegramChatId(): string {
    return requireEnv('TELEGRAM_CHAT_ID');
  },
  /**
   * Secret echoed back by Telegram in the X-Telegram-Bot-Api-Secret-Token
   * header. Set it so nobody but Telegram can drive the bot webhook.
   */
  get telegramWebhookSecret(): string | undefined {
    return read('TELEGRAM_WEBHOOK_SECRET');
  },
  /** Telegram user IDs allowed to issue commands. Empty means "anyone". */
  get allowedUserIds(): string[] {
    return optionalList('TELEGRAM_ALLOWED_USER_IDS');
  },

  /** Guards /api/bot/setup and the cron endpoints when called by hand. */
  get adminSecret(): string | undefined {
    return read('ADMIN_SECRET');
  },
  /** Injected by Vercel Cron as `Authorization: Bearer <CRON_SECRET>`. */
  get cronSecret(): string | undefined {
    return read('CRON_SECRET');
  },

  /** IANA timezone used for "today", digest windows and formatted times. */
  get timezone(): string {
    return optional('FLEET_TIMEZONE', 'America/Chicago');
  },

  /**
   * Behaviour keys to alert on (see src/samsara/events.ts). Empty means all.
   * e.g. ALERT_BEHAVIORS="crash,mobileUsage,noSeatbelt,severeSpeeding"
   */
  get alertBehaviors(): string[] {
    return optionalList('ALERT_BEHAVIORS');
  },
  /** Minimum severity that reaches Telegram: low | medium | high | critical. */
  get minSeverity(): string {
    return optional('ALERT_MIN_SEVERITY', 'low');
  },
  /** How far back the safety poller looks, in minutes. */
  get safetyLookbackMinutes(): number {
    return optionalNumber('SAFETY_LOOKBACK_MINUTES', 15);
  },
  /** Seconds an alert fingerprint is remembered, to suppress duplicates. */
  get dedupeTtlSeconds(): number {
    return optionalNumber('ALERT_DEDUPE_TTL_SECONDS', 60 * 60 * 24);
  },

  /** Optional Upstash Redis REST credentials for cross-invocation state. */
  get upstashUrl(): string | undefined {
    return read('UPSTASH_REDIS_REST_URL') ?? read('KV_REST_API_URL');
  },
  get upstashToken(): string | undefined {
    return read('UPSTASH_REDIS_REST_TOKEN') ?? read('KV_REST_API_TOKEN');
  },
};
