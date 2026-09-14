/**
 * Loads the QuickManage roster CSV into `truck_entity_history`.
 *
 *   npx tsx scripts/load-quickmanage-roster.ts <roster.csv> [--apply]
 *
 * The CSV comes from `fleet-financial-pipeline`: `pull_quickmanage.py
 * --roster`. opsdash reads the file; it never calls the API itself.
 *
 * Merges, never replaces — see src/db/repo/quickmanageRoster.ts for why, and
 * for the two cases it refuses to decide on its own.
 */
import { readFileSync } from 'node:fs';
import { getPool, query } from '../src/db/pool';
import { applyRosterMerge, planRosterMerge, type RosterRow } from '../src/db/repo/quickmanageRoster';

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

export function rowsFromCsv(text: string): RosterRow[] {
  const cells = parseCsv(text);
  const header = (cells[0] ?? []).map((c) => c.trim().toLowerCase());
  const at = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iUnit = at('unit_number', 'unit');
  const iCo = at('company');
  const iType = at('unit_type');
  const iIn = at('in_service_date');
  const iOut = at('out_service_date');
  const iStatus = at('status');
  if (iUnit === -1 || iCo === -1) {
    throw new Error(`Roster needs unit_number and company columns. Found: ${header.join(', ')}`);
  }
  if (iIn === -1) {
    throw new Error(
      'Roster has no in_service_date column — that is the only reason to load this file. ' +
        'Re-pull with pull_quickmanage.py --roster.',
    );
  }
  const get = (r: string[], i: number) => (i === -1 ? '' : (r[i] ?? '').trim());
  return cells.slice(1).map((r) => ({
    unitNumber: get(r, iUnit),
    company: get(r, iCo),
    unitType: get(r, iType),
    inServiceDate: get(r, iIn),
    outServiceDate: get(r, iOut),
    status: get(r, iStatus),
  }));
}

const SKIP_LABEL: Record<string, string> = {
  no_in_service_date: 'no in-service date on the roster row',
  unknown_company: 'company not in the ledger',
  not_a_truck: 'not a truck (trailer)',
  already_covered: 'history already starts on that date',
  conflict_other_company: 'CONFLICT: roster and dispatch name different companies',
  in_service_after_first_period: 'CONFLICT: in service after it first earned',
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) throw new Error('Usage: load-quickmanage-roster.ts <roster.csv> [--apply]');

  const rows = rowsFromCsv(readFileSync(path, 'utf8'));
  const plan = await planRosterMerge(query, rows);

  const byKind = new Map<string, number>();
  for (const a of plan.actions) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
  const skipBy = new Map<string, number>();
  for (const s of plan.skips) skipBy.set(s.kind, (skipBy.get(s.kind) ?? 0) + 1);

  console.log(`${rows.length} roster row(s)\n`);
  console.log('  would change');
  console.log(`    ${String(byKind.get('new_unit') ?? 0).padStart(5)}  unit not in the roster at all — added with its in-service date`);
  console.log(`    ${String(byKind.get('extend_back') ?? 0).padStart(5)}  period start moved back to the in-service date`);
  console.log('\n  left alone');
  for (const [k, n] of [...skipBy].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${SKIP_LABEL[k] ?? k}`);
  }

  const conflicts = plan.skips.filter(
    (s) => s.kind === 'conflict_other_company' || s.kind === 'in_service_after_first_period',
  );
  if (conflicts.length > 0) {
    console.log(`\n  ${conflicts.length} conflict(s) — nothing was changed for these, they need a person:`);
    for (const c of conflicts.slice(0, 20)) {
      if (c.kind === 'conflict_other_company') {
        console.log(`    unit ${c.unitNumber}: roster says ${c.rosterCompany}, dispatch says ${c.historyCompany} from ${c.historyFrom}`);
      } else {
        console.log(`    unit ${c.unitNumber}: in service ${c.inService} but earned from ${c.historyFrom}`);
      }
    }
    if (conflicts.length > 20) console.log(`    ... and ${conflicts.length - 20} more`);
  }

  if (!apply) { console.log('\nNothing written. Re-run with --apply.'); return; }
  const res = await applyRosterMerge(query, plan);
  console.log(`\n  APPLIED  ${res.unitsCreated} unit(s) added, ${res.periodsExtended} period(s) extended back`);
  console.log(`           ${res.daysOfCoverageGained} truck-day(s) of carrier coverage gained`);
  console.log('\n  Re-run scripts/backfill-entity.ts to attribute the cost rows this now covers.');
}

main()
  .then(async () => { await getPool().end(); process.exit(0); })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
