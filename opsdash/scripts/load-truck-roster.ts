/**
 * Loads the truck-to-carrier roster into `accounting.truck_entity_history`.
 *
 * The dispatch sheet names the company on about 5% of its rows. The truck that
 * ran the load is on all of them, and the operator keeps a roster saying which
 * company runs which truck. This puts that roster where identity resolution
 * can see it.
 *
 * **Every assignment carries a period.** Trucks move between the carriers
 * mid-year, and trucks leave — returned to the vendor, or an owner-operator
 * who quits. A flat unit → carrier map cannot express either, and silently
 * attributes a departed unit's revenue to whoever holds it now. So this writes
 * effective-dated rows into `truck_entity_history` — which has existed since
 * migration 001 for exactly this — and lets the non-overlap constraint added by
 * migration 015 reject any roster claiming two carriers for one truck on one
 * day.
 *
 * The roster's own column is `entity_CONFIRM_THIS`, so rows attributed this
 * way are staged for review rather than posted — see `resolveEntityFromTruck`.
 * This script loads a crosswalk; it does not assert a fact.
 *
 *   npx tsx scripts/load-truck-roster.ts <path-to-roster.csv>
 */
import { readFileSync } from 'node:fs';
import { query } from '../src/db/pool';

/** Quoted fields carry commas — the basis text is a sentence. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 1; } else { quoted = false; }
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function main(): Promise<void> {
  const path = process.argv[2] ?? 'tests/fixtures/real/truck-entity-roster.csv';
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = (rows[0] ?? []).map((c) => c.trim().toLowerCase());

  // By header name, never by column index: SOURCE-DISCOVERY §3 found column
  // order is not stable even inside one sheet.
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const unitIdx = col(/truck|unit/);
  const entityIdx = col(/entity/);
  const fromIdx = col(/effective_from/);
  const toIdx = col(/effective_to/);
  const basisIdx = col(/basis/);
  const confIdx = col(/confidence/);
  if (unitIdx === -1 || entityIdx === -1) {
    throw new Error(`Roster needs a truck/unit column and an entity column. Found: ${header.join(', ')}`);
  }
  if (fromIdx === -1) {
    throw new Error(
      'Roster needs an `effective_from` column. A truck\'s carrier is a fact with a date on it — ' +
        'see migration 015 and SOURCE-DISCOVERY §8.',
    );
  }

  const entities = await query<{ entity_id: string; code: string }>(
    `SELECT entity_id, code FROM accounting.entity`,
  );
  const byCode = new Map(entities.map((e) => [e.code.toLowerCase(), e.entity_id]));

  let mapped = 0;
  let ended = 0;
  let awaitingConfirmation = 0;
  let unmatchedEntity = 0;
  const unknownCodes = new Set<string>();
  const multi = new Map<string, number>();

  // Replacing the roster wholesale: a truck that moved needs its old row gone,
  // or the non-overlap constraint rejects the new one and the load half-applies.
  await query(`DELETE FROM accounting.truck_entity_history`);

  for (const cells of rows.slice(1)) {
    const unit = (cells[unitIdx] ?? '').trim();
    const code = (cells[entityIdx] ?? '').trim().toLowerCase();
    if (unit === '') continue;
    if (code === '') { awaitingConfirmation += 1; continue; }

    const entityId = byCode.get(code);
    if (!entityId) {
      unknownCodes.add(code);
      unmatchedEntity += 1;
      continue;
    }

    const from = (cells[fromIdx] ?? '').trim();
    const to = (cells[toIdx] ?? '').trim();
    if (!ISO_DATE.test(from)) {
      throw new Error(`Unit ${unit}: effective_from must be YYYY-MM-DD, got "${from}".`);
    }
    if (to !== '' && !ISO_DATE.test(to)) {
      throw new Error(`Unit ${unit}: effective_to must be YYYY-MM-DD or blank, got "${to}".`);
    }

    const basis = (cells[basisIdx] ?? '').trim() || 'truck roster, basis not recorded';
    const confidence = (cells[confIdx] ?? '').trim() === 'confirmed' ? 'confirmed' : 'inferred';

    // The truck itself, so a per-truck P&L has something to group by — and so
    // the unit number resolves to a truck_id rather than being matched as a
    // string downstream.
    await query(`INSERT INTO accounting.truck (unit_number) VALUES ($1) ON CONFLICT DO NOTHING`, [unit]);
    await query(
      `INSERT INTO accounting.truck_entity_history
         (truck_id, entity_id, effective_from, effective_to, basis, confidence)
       SELECT t.truck_id, $2, $3::date, NULLIF($4, '')::date, $5, $6
         FROM accounting.truck t WHERE t.unit_number = $1`,
      [unit, entityId, from, to, basis, confidence],
    );
    mapped += 1;
    if (to !== '') ended += 1;
    multi.set(unit, (multi.get(unit) ?? 0) + 1);
  }

  const transferred = [...multi.values()].filter((n) => n > 1).length;
  console.log(`  carrier assignments loaded : ${mapped} across ${multi.size} trucks`);
  console.log(`  periods with an end date   : ${ended} (unit left, or went inactive)`);
  console.log(`  trucks with >1 period      : ${transferred} (transferred mid-year)`);
  if (awaitingConfirmation > 0) {
    console.log(`  rows left blank for the operator : ${awaitingConfirmation}`);
    console.log('  Their revenue stays unattributed until a person answers, by design.');
  }
  if (unmatchedEntity > 0) {
    console.log(`  rows naming an unknown company : ${unmatchedEntity} (${[...unknownCodes].join(', ')})`);
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
