import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema';

let cached: Database.Database | null = null;

function resolveDbPath(): string {
  const configured = process.env.DRIVERQUAL_DB;
  if (configured) return configured;
  return path.join(process.cwd(), '.data', 'driverqual.db');
}

export function openDatabase(dbPath?: string): Database.Database {
  const file = dbPath ?? resolveDbPath();
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

/** Process-wide connection used by the route handlers. */
export function getDb(): Database.Database {
  if (!cached) cached = openDatabase();
  return cached;
}

export function closeDb(): void {
  cached?.close();
  cached = null;
}

export type { Database };
