import { Pool, types } from 'pg';

/**
 * Database access for the accounting app.
 *
 * The one thing in this file that matters more than the rest: NUMERIC must
 * come back as a string. node-postgres does that by default, but "by default"
 * is not a guarantee anyone can see, and a single `parseFloat` in a driver
 * upgrade would silently turn an exact ledger into an approximate one. So the
 * parser is pinned explicitly and asserted in a test.
 *
 * 1700 = NUMERIC. 20 = INT8. Both stay strings.
 */
types.setTypeParser(1700, (v) => v);
types.setTypeParser(20, (v) => v);

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Run `npm run db:local` for a throwaway ' +
        'database, or point it at a real one.',
    );
  }
  pool = new Pool({
    connectionString,
    // The app is read-mostly; a small pool is plenty and keeps a runaway
    // query from exhausting connections the ingest jobs also need.
    max: 10,
    idleTimeoutMillis: 30_000,
    // Everything this app writes is money. A silent hang is worse than a
    // loud failure, because a half-applied commit is what breaks a ledger.
    statement_timeout: 30_000,
  });
  return pool;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: readonly unknown[],
): Promise<T[]> {
  const res = await getPool().query(text, params as unknown[]);
  return res.rows as T[];
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 *
 * Committing a reviewed document is all-or-nothing: a half-committed batch
 * leaves staging rows marked done with no ledger entries behind them, and
 * nothing in the UI would reveal it.
 */
export async function withTransaction<T>(
  fn: (q: (text: string, params?: readonly unknown[]) => Promise<unknown[]>) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(async (text, params) => {
      const r = await client.query(text, params as unknown[]);
      return r.rows;
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
