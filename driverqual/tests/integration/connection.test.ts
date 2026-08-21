import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LOCAL_URL, openDatabase } from '@/db';

describe('database connection', () => {
  it('creates the schema on first open and is safe to reopen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driverqual-conn-'));
    const url = `file:${path.join(dir, 'first.db')}`;

    const first = await openDatabase(url);
    await first.run(`INSERT INTO companies (id, name, status, created_at, updated_at)
                     VALUES (?, ?, 'active', ?, ?)`, ['co_1', 'Reopen Co', 'now', 'now']);
    first.close();

    // Reopening re-runs the schema; every statement is IF NOT EXISTS, so the
    // existing row must survive.
    const second = await openDatabase(url);
    const row = await second.get<{ name: string }>(`SELECT name FROM companies WHERE id = ?`, [
      'co_1',
    ]);
    expect(row?.name).toBe('Reopen Co');
    second.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the parent directory of a local database file', async () => {
    // libSQL opens files but does not create directories, so a fresh checkout
    // using the default path must not fail merely because .data is absent.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driverqual-mkdir-'));
    const nested = path.join(root, 'does', 'not', 'exist', 'app.db');
    expect(fs.existsSync(path.dirname(nested))).toBe(false);

    const db = await openDatabase(`file:${nested}`);
    expect(fs.existsSync(nested)).toBe(true);
    db.close();

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports a malformed database URL with the setting to fix', async () => {
    await expect(openDatabase('not-a-url')).rejects.toThrow(/Could not open the database/);
    await expect(openDatabase('not-a-url')).rejects.toThrow(/TURSO_DATABASE_URL/);
  });

  it('names the path, not the credential, when a local file cannot be opened', async () => {
    // A regular file standing where a directory needs to be: the parent cannot
    // be created, so opening must fail with the path named.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driverqual-blocked-'));
    const blocker = path.join(root, 'not-a-directory');
    fs.writeFileSync(blocker, 'occupied');

    let message = '';
    try {
      await openDatabase(`file:${path.join(blocker, 'app.db')}`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Could not open the database/);
    expect(message).toMatch(/writable/);
    expect(message).not.toMatch(/TURSO_AUTH_TOKEN/);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('defaults to a local file when nothing is configured', () => {
    expect(DEFAULT_LOCAL_URL).toBe('file:.data/driverqual.db');
  });

  it('rolls back a batch when any statement in it fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driverqual-tx-'));
    const db = await openDatabase(`file:${path.join(dir, 'tx.db')}`);

    await expect(
      db.batch([
        {
          sql: `INSERT INTO companies (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`,
          args: ['co_tx', 'Rollback Co', 'now', 'now'],
        },
        { sql: `INSERT INTO companies (id, name) VALUES (?, ?)`, args: ['co_tx', 'Duplicate'] },
      ]),
    ).rejects.toThrow();

    // The first insert must not have survived the failed transaction.
    const row = await db.get(`SELECT id FROM companies WHERE id = ?`, ['co_tx']);
    expect(row).toBeUndefined();

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
