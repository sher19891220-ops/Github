/**
 * Minimal content-addressed byte store, standing in for real object storage.
 *
 * `source_document.storage_key` exists precisely so bytes never live in
 * Postgres. This repo has no object-storage client in its dependencies (no
 * S3/GCS SDK) and wiring one up is outside this task's scope — so documents
 * are written to local disk, keyed by sha256 for free dedup, behind this one
 * module. Swapping in a real object store later means changing this file
 * only; nothing else references the filesystem.
 *
 * Not for production as-is: local disk does not survive across instances or
 * deploys. Flagged in the final report as a real gap, not silently hidden.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function blobDir(): string {
  return process.env.OPSDASH_BLOB_DIR ?? path.join(tmpdir(), 'opsdash-blobs');
}

export async function putBlob(sha256: string, bytes: Buffer): Promise<string> {
  const dir = blobDir();
  await mkdir(dir, { recursive: true });
  const key = `${sha256}.bin`;
  await writeFile(path.join(dir, key), bytes);
  return key;
}

export async function getBlob(storageKey: string): Promise<Buffer> {
  return readFile(path.join(blobDir(), storageKey));
}
