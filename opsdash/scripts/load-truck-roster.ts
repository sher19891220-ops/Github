/**
 * Loads the truck-to-entity roster into `source_key_map` and `truck`.
 *
 * The dispatch sheet names the company on about 5% of its rows. The truck
 * that ran the load is on all of them, and the operator keeps a roster
 * saying which company runs which truck. This puts that roster where
 * identity resolution can see it.
 *
 * The roster's own column is `entity_CONFIRM_THIS`, so rows attributed
 * this way are staged for review rather than posted — see
 * `resolveEntityFromTruck`. This script loads a crosswalk; it does not
 * assert a fact.
 *
 *   npx tsx scripts/load-truck-roster.ts <path-to-roster.csv>
 */
import { readFileSync } from 'node:fs';
import { query } from '../src/db/pool';
import { TRUCK_ROSTER_SOURCE } from '../src/db/repo/entityResolution';

async function main(): Promise<void> {
  const path = process.argv[2] ?? 'tests/fixtures/real/truck-entity-roster.csv';
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0]!.split(',').map((c) => c.trim().toLowerCase());

  // By header name, never by column index: SOURCE-DISCOVERY §3 found
  // column order is not stable even inside one sheet.
  const unitIdx = header.findIndex((h) => /truck|unit/.test(h));
  const entityIdx = header.findIndex((h) => /entity/.test(h));
  if (unitIdx === -1 || entityIdx === -1) {
    throw new Error(`Roster needs a truck/unit column and an entity column. Found: ${header.join(', ')}`);
  }

  const entities = await query<{ entity_id: string; code: string }>(
    `SELECT entity_id, code FROM accounting.entity`,
  );
  const byCode = new Map(entities.map((e) => [e.code.toLowerCase(), e.entity_id]));

  let mapped = 0;
  let unmatchedEntity = 0;
  const unknownCodes = new Set<string>();

  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const unit = (cells[unitIdx] ?? '').trim();
    const code = (cells[entityIdx] ?? '').trim().toLowerCase();
    if (unit === '' || code === '') continue;

    const entityId = byCode.get(code);
    if (!entityId) {
      unknownCodes.add(code);
      unmatchedEntity += 1;
      continue;
    }

    // The truck itself, so a per-truck P&L has something to group by.
    await query(
      `INSERT INTO accounting.truck (unit_number) VALUES ($1) ON CONFLICT DO NOTHING`,
      [unit],
    );
    await query(
      `INSERT INTO accounting.source_key_map (canonical_kind, canonical_id, source_system, source_key)
       VALUES ('entity', $1, $2, $3)
       ON CONFLICT (source_system, source_key, canonical_kind) DO UPDATE SET canonical_id = EXCLUDED.canonical_id`,
      [entityId, TRUCK_ROSTER_SOURCE, unit],
    );
    mapped += 1;
  }

  console.log(`  trucks mapped to an entity : ${mapped}`);
  if (unmatchedEntity > 0) {
    console.log(`  rows naming an unknown company : ${unmatchedEntity} (${[...unknownCodes].join(', ')})`);
    console.log('  Those trucks resolve to nothing and their revenue stays unattributed, by design.');
  }
  console.log('\n  Rows attributed through this roster stage as `under_review`, never posted directly.\n');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
