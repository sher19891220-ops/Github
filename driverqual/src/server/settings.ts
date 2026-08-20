import type { Db } from '@/db';
import { nowIso } from '@/db/ids';

/**
 * Integration secrets live server-side only. Nothing in this module ever
 * returns a full secret to a caller — `getSecret` is the single accessor and is
 * used exclusively by server-side request handlers.
 */

export const SETTING_KEYS = {
  openaiApiKey: 'openai_api_key',
  openaiModel: 'openai_model',
  fmcsaApiKey: 'fmcsa_api_key',
} as const;

export const DEFAULT_EXTRACTION_MODEL = 'gpt-4.1-mini';

export interface SecretStatus {
  key: string;
  configured: boolean;
  /** Last four characters only — enough to tell two keys apart, useless alone. */
  hint: string | null;
  source: 'database' | 'environment' | 'none';
  updatedAt: string | null;
}

function envFor(key: string): string | undefined {
  switch (key) {
    case SETTING_KEYS.openaiApiKey:
      return process.env.OPENAI_API_KEY;
    case SETTING_KEYS.fmcsaApiKey:
      return process.env.FMCSA_API_KEY;
    default:
      return undefined;
  }
}

export async function setSetting(db: Db, key: string, value: string | null): Promise<void> {
  await db.run(
    `INSERT INTO integration_settings (key, value, status, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, status = excluded.status, updated_at = excluded.updated_at`,
    [key, value, value ? 'configured' : 'removed', nowIso()],
  );
}

export async function getSecret(db: Db, key: string): Promise<string | null> {
  const row = await db.get<{ value: string | null }>(
    `SELECT value FROM integration_settings WHERE key = ?`,
    [key],
  );
  return row?.value ?? envFor(key) ?? null;
}

/** The only shape a secret is allowed to take when leaving the server. */
export async function secretStatus(db: Db, key: string): Promise<SecretStatus> {
  const row = await db.get<{ value: string | null; updated_at: string }>(
    `SELECT value, updated_at FROM integration_settings WHERE key = ?`,
    [key],
  );

  const stored = row?.value ?? null;
  const fromEnv = envFor(key) ?? null;
  const value = stored ?? fromEnv;

  return {
    key,
    configured: Boolean(value),
    hint: value ? `••••${value.slice(-4)}` : null,
    source: stored ? 'database' : fromEnv ? 'environment' : 'none',
    updatedAt: row?.updated_at ?? null,
  };
}

export async function getExtractionModel(db: Db): Promise<string> {
  const row = await db.get<{ value: string | null }>(
    `SELECT value FROM integration_settings WHERE key = ?`,
    [SETTING_KEYS.openaiModel],
  );
  return row?.value || process.env.OPENAI_MODEL || DEFAULT_EXTRACTION_MODEL;
}

export interface UploadPolicy {
  maxBytes: number;
  acceptedMimeTypes: string[];
  acceptedExtensions: string[];
  maxFilesPerApplicant: number;
}

export const UPLOAD_POLICY: UploadPolicy = {
  maxBytes: 20 * 1024 * 1024,
  acceptedMimeTypes: [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/heic',
    'image/heif',
  ],
  acceptedExtensions: ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif'],
  maxFilesPerApplicant: 8,
};

export interface FileValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Server-side validation. The browser's `accept` attribute is a convenience,
 * never the control — every upload is re-checked here on both extension and
 * declared MIME type.
 */
export function validateUpload(file: {
  name: string;
  type: string;
  size: number;
}): FileValidationResult {
  const errors: string[] = [];
  const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';

  if (!UPLOAD_POLICY.acceptedExtensions.includes(extension)) {
    errors.push(
      `"${file.name}" has an unsupported extension. Accepted formats: ${UPLOAD_POLICY.acceptedExtensions.join(', ')}.`,
    );
  }
  if (file.type && !UPLOAD_POLICY.acceptedMimeTypes.includes(file.type.toLowerCase())) {
    errors.push(`"${file.name}" has an unsupported content type (${file.type}).`);
  }
  if (file.size > UPLOAD_POLICY.maxBytes) {
    errors.push(
      `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${UPLOAD_POLICY.maxBytes / 1024 / 1024} MB limit.`,
    );
  }
  if (file.size === 0) {
    errors.push(`"${file.name}" is empty.`);
  }

  return { ok: errors.length === 0, errors };
}
