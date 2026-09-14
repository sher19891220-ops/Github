/**
 * Where an uploaded document's original bytes actually live.
 *
 * This module is the one seam between the ledger and durable storage, and
 * it was previously a lie in production. It wrote to `os.tmpdir()`, which
 * on a container platform is wiped on every deploy and is not shared
 * between instances. The `source_document` row survived with a
 * `storage_key` pointing at a file that no longer existed, so the promise
 * the whole build rests on — every posted number traces back to the
 * document it came from — held in the schema and failed on disk. The
 * drill-down worked until the first redeploy.
 *
 * Two backends now, chosen by configuration, never by guesswork:
 *
 *   s3    — any S3-compatible object store (AWS, Cloudflare R2, Backblaze
 *           B2, Wasabi, MinIO). Durable, shared across instances, and the
 *           same bucket family the nightly backup already uses.
 *   local — a directory on disk, for development and tests only.
 *
 * In production the local backend is REFUSED rather than used as a
 * fallback. A fallback here is how you get a year of uploads that appear to
 * have worked and cannot be produced when somebody asks for the invoice.
 *
 * Keys stay `<sha256>.bin`, exactly as before, so existing
 * `source_document.storage_key` values remain valid the moment their bytes
 * are put somewhere durable. Content addressing also means re-uploading the
 * same statement overwrites itself with identical bytes instead of
 * duplicating.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class BlobNotFoundError extends Error {
  constructor(storageKey: string) {
    super(
      `The stored copy of this document is missing (key ${storageKey}). ` +
        'Its ledger entries are still valid, but the original file has to be re-uploaded ' +
        'before anyone can open it. Run `npm run blobs:check` to list every document in this state.',
    );
    this.name = 'BlobNotFoundError';
  }
}

export class BlobStoreNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobStoreNotConfiguredError';
  }
}

export interface BlobBackend {
  readonly kind: 'local' | 's3';
  readonly describe: string;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  has(key: string): Promise<boolean>;
}

export function keyFor(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Not a sha256 hex digest: "${sha256}". Storage keys are content addresses, not names.`);
  }
  return `${sha256}.bin`;
}

/* ------------------------------- local ------------------------------- */

function localDir(): string {
  return process.env.OPSDASH_BLOB_DIR ?? path.join(tmpdir(), 'opsdash-blobs');
}

export function localBackend(dir: string = localDir()): BlobBackend {
  return {
    kind: 'local',
    describe: `local directory ${dir}`,
    async put(key, bytes) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, key), bytes);
    },
    async get(key) {
      try {
        return await readFile(path.join(dir, key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new BlobNotFoundError(key);
        throw err;
      }
    },
    async has(key) {
      try {
        await readFile(path.join(dir, key));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/* --------------------------------- s3 -------------------------------- */

export interface S3Config {
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
}

/** Reads S3 settings from the environment, or returns null if no bucket is
 *  named. Never invents a bucket: an unset bucket means "not configured",
 *  which the caller turns into a refusal, not a default. */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const bucket = env.BLOB_S3_BUCKET?.trim();
  if (!bucket) return null;
  return {
    bucket,
    // Kept separate from the backup's prefix so a lifecycle rule that expires
    // old backups can never expire the documents those backups refer to.
    prefix: (env.BLOB_S3_PREFIX ?? 'documents').replace(/^\/+|\/+$/g, ''),
    region: env.BLOB_S3_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1',
    endpoint: env.BLOB_S3_ENDPOINT?.trim() || undefined,
    // R2, B2 and MinIO need path-style addressing; AWS does not care.
    forcePathStyle: Boolean(env.BLOB_S3_ENDPOINT?.trim()),
  };
}

/** The bits of the S3 client this module uses. Narrow on purpose: it is
 *  what makes the backend testable without a network or a real bucket. */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export async function s3Backend(cfg: S3Config, client?: S3Like): Promise<BlobBackend> {
  const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const s3: S3Like =
    client ??
    new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
    });

  const full = (key: string) => (cfg.prefix ? `${cfg.prefix}/${key}` : key);

  return {
    kind: 's3',
    describe: `s3://${cfg.bucket}/${cfg.prefix}${cfg.endpoint ? ` via ${cfg.endpoint}` : ''}`,
    async put(key, bytes) {
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: full(key),
          Body: bytes,
          // The bytes are already content-addressed by sha256; this is the
          // integrity check the transfer itself gets, so a truncated PUT is
          // rejected by the store rather than accepted and discovered later.
          ChecksumSHA256: Buffer.from(key.replace(/\.bin$/, ''), 'hex').toString('base64'),
          ContentType: 'application/octet-stream',
        }),
      );
    },
    async get(key) {
      try {
        const out = (await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: full(key) }))) as {
          Body?: { transformToByteArray?: () => Promise<Uint8Array> };
        };
        const body = out.Body;
        if (!body?.transformToByteArray) throw new BlobNotFoundError(key);
        return Buffer.from(await body.transformToByteArray());
      } catch (err) {
        if (isNotFound(err)) throw new BlobNotFoundError(key);
        throw err;
      }
    },
    async has(key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: full(key) }));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
  };
}

export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.Code === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/* ------------------------------ selection ----------------------------- */

/**
 * Picks a backend from the environment.
 *
 * The production refusal is the important line in this file. Without it a
 * missing bucket silently degrades to a directory that is deleted on the
 * next deploy, and every upload in between looks like it worked.
 */
export async function resolveBackend(env: NodeJS.ProcessEnv = process.env): Promise<BlobBackend> {
  const cfg = s3ConfigFromEnv(env);
  if (cfg) return s3Backend(cfg);

  if (env.NODE_ENV === 'production' && env.OPSDASH_ALLOW_LOCAL_BLOBS !== '1') {
    throw new BlobStoreNotConfiguredError(
      'BLOB_S3_BUCKET is not set, so uploaded documents would be written to a directory that ' +
        'this platform deletes on the next deploy and does not share between instances. ' +
        'Every document would look stored and be unrecoverable. ' +
        'Set BLOB_S3_BUCKET (see docs/BLOB-STORAGE.md), or set OPSDASH_ALLOW_LOCAL_BLOBS=1 if you ' +
        'genuinely accept losing them.',
    );
  }
  return localBackend();
}

let cached: Promise<BlobBackend> | null = null;
function backend(): Promise<BlobBackend> {
  if (!cached) cached = resolveBackend();
  return cached;
}

/** TEST ONLY — forget the memoised backend so a test can change the env. */
export function __resetBackendForTests(): void {
  cached = null;
}

/* ------------------------------- public ------------------------------- */

export async function putBlob(sha256: string, bytes: Buffer): Promise<string> {
  const key = keyFor(sha256);
  await (await backend()).put(key, bytes);
  return key;
}

export async function getBlob(storageKey: string): Promise<Buffer> {
  return (await backend()).get(storageKey);
}

export async function hasBlob(storageKey: string): Promise<boolean> {
  return (await backend()).has(storageKey);
}

/** For the health check and the startup banner: says where bytes are going
 *  without revealing credentials. */
export async function describeBlobStore(): Promise<{ kind: 'local' | 's3'; describe: string }> {
  const b = await backend();
  return { kind: b.kind, describe: b.describe };
}
