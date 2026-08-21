import { createClient, type Client, type InArgs } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema';

/**
 * Database access over libSQL.
 *
 * The same code path serves a local file (`file:.data/driverqual.db`) and a
 * hosted Turso database (`libsql://…`), so development, tests and production run
 * against one dialect rather than two.
 *
 * Every call is asynchronous. A hosted database is reached over the network, and
 * pretending otherwise is what forces a synchronous API to be retrofitted later.
 */

export type Args = InArgs;

export interface Statement {
  sql: string;
  args?: Args;
}

export interface Db {
  all<T = Record<string, unknown>>(sql: string, args?: Args): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, args?: Args): Promise<T | undefined>;
  run(sql: string, args?: Args): Promise<void>;
  /** Runs every statement in one write transaction, or none of them. */
  batch(statements: Statement[]): Promise<void>;
  close(): void;
}

export const DEFAULT_LOCAL_URL = 'file:.data/driverqual.db';

function resolveUrl(): string {
  return process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || DEFAULT_LOCAL_URL;
}

function wrap(client: Client): Db {
  return {
    async all<T>(sql: string, args?: Args) {
      const result = await client.execute(args === undefined ? sql : { sql, args });
      return result.rows as unknown as T[];
    },
    async get<T>(sql: string, args?: Args) {
      const result = await client.execute(args === undefined ? sql : { sql, args });
      return result.rows[0] as unknown as T | undefined;
    },
    async run(sql: string, args?: Args) {
      await client.execute(args === undefined ? sql : { sql, args });
    },
    async batch(statements: Statement[]) {
      if (statements.length === 0) return;
      await client.batch(
        statements.map((s) => (s.args === undefined ? s.sql : { sql: s.sql, args: s.args })),
        'write',
      );
    },
    close() {
      client.close();
    },
  };
}

/**
 * Creates the parent directory of a local database file.
 *
 * libSQL opens a file but will not create the directory holding it, so a fresh
 * checkout using the default `file:.data/driverqual.db` fails on first run with
 * a bare "unable to open" until `.data` happens to exist.
 */
function ensureLocalDirectory(url: string): void {
  if (!url.startsWith('file:')) return;
  // Strip the scheme and any `?mode=` style parameters to get the bare path.
  const filePath = url.slice('file:'.length).split('?')[0];
  if (!filePath) return;
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
}

/**
 * Wraps a connection failure with something a person deploying can act on.
 *
 * The underlying errors are accurate but anonymous ("Server returned HTTP status
 * 404"), and by the time one reaches a hosting platform's log there is nothing
 * naming the setting that is wrong. The token is never included.
 */
function connectionError(url: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const hint = url.startsWith('file:')
    ? 'Check that the path is writable by the server process.'
    : 'Check that TURSO_DATABASE_URL is the database URL shown in the Turso dashboard, and that TURSO_AUTH_TOKEN is a current token for that same database.';
  return new Error(
    `Could not open the database at ${url} — ${detail}. ${hint} See DEPLOY.md for the full setup.`,
    { cause },
  );
}

/**
 * Opens a connection and applies the schema. Every statement in the schema is
 * `IF NOT EXISTS`, so this is safe to run on each cold start.
 */
export async function openDatabase(url?: string, authToken?: string): Promise<Db> {
  const resolved = url ?? resolveUrl();
  try {
    ensureLocalDirectory(resolved);
    const client = createClient({
      url: resolved,
      authToken: authToken ?? process.env.TURSO_AUTH_TOKEN,
    });
    await client.executeMultiple(SCHEMA_SQL);
    return wrap(client);
  } catch (cause) {
    throw connectionError(resolved, cause);
  }
}

let cached: Promise<Db> | null = null;

/** Process-wide connection used by route handlers and server components. */
export function getDb(): Promise<Db> {
  if (!cached) {
    cached = openDatabase().catch((error) => {
      // Do not cache a failed connection; the next request should retry.
      cached = null;
      throw error;
    });
  }
  return cached;
}

export async function closeDb(): Promise<void> {
  if (!cached) return;
  const db = await cached.catch(() => null);
  db?.close();
  cached = null;
}
