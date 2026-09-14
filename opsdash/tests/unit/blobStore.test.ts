/**
 * The rules this file exists to enforce, in order of how much damage their
 * absence caused:
 *
 *  1. Production never silently falls back to local disk. That fallback is
 *     what made every uploaded document disappear on deploy while the
 *     upload path reported success.
 *  2. A missing blob is a distinct, explainable condition — not a generic
 *     ENOENT that surfaces as a 500.
 *  3. Keys are content addresses, and anything that is not a sha256 is
 *     refused rather than used as a filename.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BlobNotFoundError,
  BlobStoreNotConfiguredError,
  isNotFound,
  keyFor,
  localBackend,
  resolveBackend,
  s3Backend,
  s3ConfigFromEnv,
  type S3Like,
} from '@/db/repo/blobStore';

const SHA = 'a'.repeat(64);

/** A deliberately partial environment. Every one of these tests is about
 *  what happens when a variable is ABSENT, so building them from a full
 *  ProcessEnv would defeat the point. */
const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as unknown as NodeJS.ProcessEnv;
const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'blobtest-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('keyFor', () => {
  it('turns a digest into a content-addressed key', () => {
    expect(keyFor(SHA)).toBe(`${SHA}.bin`);
  });

  it('refuses anything that is not a sha256 digest', () => {
    // A storage key built from a user-supplied filename is a path traversal
    // waiting to happen, and it also breaks dedupe.
    for (const bad of ['../../etc/passwd', 'invoice.pdf', SHA.toUpperCase(), SHA.slice(0, 63), '']) {
      expect(() => keyFor(bad)).toThrow(/content addresses/);
    }
  });
});

describe('the production refusal', () => {
  it('refuses to use local disk in production when no bucket is configured', async () => {
    await expect(resolveBackend(env({ NODE_ENV: 'production' }))).rejects.toThrow(
      BlobStoreNotConfiguredError,
    );
  });

  it('says what would go wrong, not just that something is unset', async () => {
    const err = await resolveBackend(env({ NODE_ENV: 'production' })).catch((e) => e);
    expect(err.message).toMatch(/deletes on the next deploy/);
    expect(err.message).toMatch(/BLOB_S3_BUCKET/);
  });

  it('allows local disk in production only when someone explicitly accepts the loss', async () => {
    const b = await resolveBackend(env({
      NODE_ENV: 'production',
      OPSDASH_ALLOW_LOCAL_BLOBS: '1',
    }));
    expect(b.kind).toBe('local');
  });

  it('uses local disk outside production without complaint', async () => {
    const b = await resolveBackend(env({ NODE_ENV: 'test' }));
    expect(b.kind).toBe('local');
  });

  it('prefers the object store whenever a bucket is named, production or not', async () => {
    const b = await resolveBackend(env({ NODE_ENV: 'development', BLOB_S3_BUCKET: 'b' }));
    expect(b.kind).toBe('s3');
  });
});

describe('s3ConfigFromEnv', () => {
  it('returns null when no bucket is named — never invents one', () => {
    expect(s3ConfigFromEnv(env({}))).toBeNull();
    expect(s3ConfigFromEnv(env({ BLOB_S3_BUCKET: '   ' }))).toBeNull();
  });

  it('keeps documents under their own prefix, apart from backups', () => {
    expect(s3ConfigFromEnv(env({ BLOB_S3_BUCKET: 'b' }))!.prefix).toBe('documents');
  });

  it('strips stray slashes so a key never contains a double slash', () => {
    expect(s3ConfigFromEnv(env({ BLOB_S3_BUCKET: 'b', BLOB_S3_PREFIX: '/docs/' }))!.prefix).toBe('docs');
  });

  it('switches to path-style addressing for non-AWS endpoints, which need it', () => {
    const aws = s3ConfigFromEnv(env({ BLOB_S3_BUCKET: 'b' }));
    const r2 = s3ConfigFromEnv(env({ BLOB_S3_BUCKET: 'b', BLOB_S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com' }));
    expect(aws!.forcePathStyle).toBe(false);
    expect(r2!.forcePathStyle).toBe(true);
  });
});

describe('the local backend', () => {
  it('round-trips bytes', async () => {
    const b = localBackend(await tempDir());
    await b.put(keyFor(SHA), Buffer.from('a fuel statement'));
    expect((await b.get(keyFor(SHA))).toString()).toBe('a fuel statement');
    expect(await b.has(keyFor(SHA))).toBe(true);
  });

  it('reports a missing file as a named condition, not an ENOENT', async () => {
    const b = localBackend(await tempDir());
    await expect(b.get(keyFor(SHA))).rejects.toThrow(BlobNotFoundError);
    expect(await b.has(keyFor(SHA))).toBe(false);
  });

  it('explains what a missing file means for the ledger', async () => {
    const b = localBackend(await tempDir());
    const err = await b.get(keyFor(SHA)).catch((e) => e);
    // An accountant seeing this needs to know the entries are still good.
    expect(err.message).toMatch(/ledger entries are still valid/);
    expect(err.message).toMatch(/re-uploaded/);
  });

  it('overwrites identical content rather than duplicating it', async () => {
    const dir = await tempDir();
    const b = localBackend(dir);
    await b.put(keyFor(SHA), Buffer.from('x'));
    await b.put(keyFor(SHA), Buffer.from('x'));
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toHaveLength(1);
  });
});

describe('the s3 backend', () => {
  /** Records what was sent, so the command shape can be asserted without a
   *  bucket, a network, or credentials. */
  function spy(reply: (name: string, input: Record<string, unknown>) => unknown): { client: S3Like; sent: Array<{ name: string; input: Record<string, unknown> }> } {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    return {
      sent,
      client: {
        async send(cmd: unknown) {
          const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
          sent.push({ name: c.constructor.name, input: c.input });
          return reply(c.constructor.name, c.input);
        },
      },
    };
  }

  const cfg = { bucket: 'ledger-docs', prefix: 'documents', region: 'auto', forcePathStyle: true };

  it('writes under the configured prefix', async () => {
    const s = spy(() => ({}));
    const b = await s3Backend(cfg, s.client);
    await b.put(keyFor(SHA), Buffer.from('bytes'));
    expect(s.sent[0]!.name).toBe('PutObjectCommand');
    expect(s.sent[0]!.input.Key).toBe(`documents/${SHA}.bin`);
    expect(s.sent[0]!.input.Bucket).toBe('ledger-docs');
  });

  it('sends the content hash so a truncated upload is rejected by the store', async () => {
    const s = spy(() => ({}));
    const b = await s3Backend(cfg, s.client);
    await b.put(keyFor(SHA), Buffer.from('bytes'));
    expect(s.sent[0]!.input.ChecksumSHA256).toBe(Buffer.from(SHA, 'hex').toString('base64'));
  });

  it('round-trips bytes back out', async () => {
    const s = spy((name) =>
      name === 'GetObjectCommand'
        ? { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }
        : {},
    );
    const b = await s3Backend(cfg, s.client);
    expect([...(await b.get(keyFor(SHA)))]).toEqual([1, 2, 3]);
  });

  it('turns a NoSuchKey into the same named condition the local backend raises', async () => {
    const s = spy(() => {
      throw Object.assign(new Error('nope'), { name: 'NoSuchKey' });
    });
    const b = await s3Backend(cfg, s.client);
    await expect(b.get(keyFor(SHA))).rejects.toThrow(BlobNotFoundError);
    expect(await b.has(keyFor(SHA))).toBe(false);
  });

  it('lets a real failure through instead of reporting it as "not found"', async () => {
    // Credentials expiring must not look like a missing document — one is an
    // outage, the other means re-upload the statement.
    const s = spy(() => {
      throw Object.assign(new Error('InvalidAccessKeyId'), { name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } });
    });
    const b = await s3Backend(cfg, s.client);
    await expect(b.get(keyFor(SHA))).rejects.toThrow(/InvalidAccessKeyId/);
    await expect(b.has(keyFor(SHA))).rejects.toThrow(/InvalidAccessKeyId/);
  });

  it('describes where bytes go without leaking credentials', async () => {
    const b = await s3Backend({ ...cfg, endpoint: 'https://acct.r2.cloudflarestorage.com' }, spy(() => ({})).client);
    expect(b.describe).toContain('s3://ledger-docs/documents');
    expect(b.describe).not.toMatch(/secret|key|password/i);
  });
});

describe('isNotFound', () => {
  it('recognises the several shapes S3-compatible stores use', () => {
    expect(isNotFound({ name: 'NoSuchKey' })).toBe(true);
    expect(isNotFound({ name: 'NotFound' })).toBe(true);
    expect(isNotFound({ Code: 'NoSuchKey' })).toBe(true);
    expect(isNotFound({ $metadata: { httpStatusCode: 404 } })).toBe(true);
  });

  it('does not mistake an auth or server failure for a missing object', () => {
    expect(isNotFound({ $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isNotFound({ $metadata: { httpStatusCode: 500 } })).toBe(false);
    expect(isNotFound(new Error('socket hang up'))).toBe(false);
  });
});
