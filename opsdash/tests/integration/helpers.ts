/**
 * Shared fixtures for the integration suite, run against a real Postgres
 * (`npm run db:local`). Every test file calls `ensureBaseFixtures()` and
 * then works with its own uniquely-generated content — no global TRUNCATE —
 * so the suite is safe to run with test files in parallel (vitest's default
 * for this repo's `pool: 'forks'`).
 */
import { randomUUID } from 'node:crypto';
import { query } from '@/db/pool';

export const ENTITY_ZONE_ID = '00000000-0000-4000-8000-00000000e001';
export const ENTITY_XTRACK_ID = '00000000-0000-4000-8000-00000000e002';
export const ENTITY_AFG_ID = '00000000-0000-4000-8000-00000000e003';

export const CATEGORY_REVENUE = 'revenue.linehaul';
export const CATEGORY_FUEL = 'fuel.diesel';
export const CATEGORY_MAINTENANCE = 'maintenance.repair';

let readyPromise: Promise<void> | null = null;

/** Idempotent (ON CONFLICT DO NOTHING) and safe under concurrent callers —
 *  every test file needs the same handful of dimension/category rows to
 *  exist, and none of them owns the right to delete another file's data. */
export function ensureBaseFixtures(): Promise<void> {
  if (!readyPromise) readyPromise = seed();
  return readyPromise;
}

async function seed(): Promise<void> {
  await query(
    `INSERT INTO accounting.entity (entity_id, code, legal_name) VALUES
       ($1, 'ZONE', 'Zone OH LLC (test fixture)'),
       ($2, 'XTRACK', 'Xtrack LLC (test fixture)'),
       ($3, 'AFG', 'AFG (test fixture)')
     ON CONFLICT (entity_id) DO NOTHING`,
    [ENTITY_ZONE_ID, ENTITY_XTRACK_ID, ENTITY_AFG_ID],
  );

  await query(
    `INSERT INTO accounting.category (category_id, category_group, display_name, sign) VALUES
       ($1, 'revenue', 'Linehaul (test fixture)', 1),
       ($2, 'fuel', 'Diesel (test fixture)', -1),
       ($3, 'maintenance', 'Repair (test fixture)', -1)
     ON CONFLICT (category_id) DO NOTHING`,
    [CATEGORY_REVENUE, CATEGORY_FUEL, CATEGORY_MAINTENANCE],
  );

  // Lets the dispatch parser's raw entity markers (XTRACK/AFG/ZONE) resolve
  // through source_key_map exactly the way insertStagingRows.ts requires.
  await query(
    `INSERT INTO accounting.source_key_map (canonical_kind, canonical_id, source_system, source_key) VALUES
       ('entity', $1, 'dispatch', 'ZONE'),
       ('entity', $2, 'dispatch', 'XTRACK'),
       ('entity', $3, 'dispatch', 'AFG')
     ON CONFLICT (source_system, source_key, canonical_kind) DO NOTHING`,
    [ENTITY_ZONE_ID, ENTITY_XTRACK_ID, ENTITY_AFG_ID],
  );
}

/** Unique content per call, so a content-addressed (sha256) document
 *  upload never collides with another test's. */
export function uniqueText(label: string): string {
  return `${label} :: ${randomUUID()}\n`;
}
