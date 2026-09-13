/**
 * Loads the operator's "Fixed costs by company" rate card.
 *
 * The sheet states a cost per truck per week per carrier — truck payments,
 * salaries, insurance, telematics, permits, weight-distance taxes. It is the
 * cost side the ledger was missing: 46% of weekly revenue before fuel.
 *
 * A rate card is not a receipt. Nothing here posts; this only records the
 * rates. `post-fixed-costs.ts` turns them into ledger entries, every one
 * marked `allocation_basis = 'rate_card'` so a modelled cost can never be
 * read back as a measured one.
 *
 *   npx tsx scripts/load-fixed-cost-rates.ts <csv> <effective-from> [effective-to]
 */
import { readFileSync } from 'node:fs';
import { query } from '../src/db/pool';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => l.split(','));
}

/** The `#headcount` line: the truck count each rate was divided out of. */
function readHeadcount(text: string): Map<number, number> {
  const line = text.split(/\r?\n/).find((l) => l.startsWith('#headcount'));
  const out = new Map<number, number>();
  if (!line) return out;
  line.split(',').forEach((cell, i) => {
    const n = Number(cell.trim());
    if (Number.isInteger(n) && n > 0) out.set(i, n);
  });
  return out;
}

async function main(): Promise<void> {
  const [path, from, to] = process.argv.slice(2);
  if (!path || !from) throw new Error('Usage: load-fixed-cost-rates.ts <csv> <effective-from> [effective-to]');
  if (!ISO.test(from)) throw new Error(`effective-from must be YYYY-MM-DD, got "${from}"`);
  if (to !== undefined && !ISO.test(to)) throw new Error(`effective-to must be YYYY-MM-DD, got "${to}"`);

  const text = readFileSync(path, 'utf8');
  const rows = parseCsv(text);
  const headcount = readHeadcount(text);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const iLine = header.indexOf('line_item');
  const iCat = header.indexOf('category_id');
  if (iLine === -1 || iCat === -1) {
    throw new Error(`Rate card needs line_item and category_id columns. Found: ${header.join(', ')}`);
  }
  // Every other column is a carrier, read by NAME — the sheet's column order
  // is not a contract and a carrier may be added.
  const carriers = header
    .map((h, i) => ({ code: h.toUpperCase(), i }))
    .filter((c) => c.i !== iLine && c.i !== iCat && c.code !== '');

  const entities = await query<{ entity_id: string; code: string }>(
    `SELECT entity_id, code FROM accounting.entity`,
  );
  const byCode = new Map(entities.map((e) => [e.code.toUpperCase(), e.entity_id]));
  for (const c of carriers) {
    if (!byCode.has(c.code)) throw new Error(`Rate card column "${c.code}" is not a known carrier.`);
  }

  const cats = await query<{ category_id: string }>(`SELECT category_id FROM accounting.category`);
  const known = new Set(cats.map((c) => c.category_id));

  // Replace this period wholesale: a partial reload would leave a stale rate
  // beside a new one and the exclusion constraint would reject it anyway.
  await query(`DELETE FROM accounting.fixed_cost_rate WHERE effective_from = $1::date`, [from]);

  let loaded = 0;
  const totals = new Map<string, number>();
  for (const cells of rows.slice(1)) {
    const lineItem = (cells[iLine] ?? '').trim();
    const categoryId = (cells[iCat] ?? '').trim();
    if (lineItem === '') continue;
    if (!known.has(categoryId)) {
      throw new Error(`Line "${lineItem}" maps to category "${categoryId}", which the chart of accounts does not define.`);
    }
    for (const c of carriers) {
      const raw = (cells[c.i] ?? '').trim();
      // Blank is "not applied to this carrier" — AFG pays no IFTA line, and a
      // zero would claim it costs nothing rather than that it does not apply.
      if (raw === '') continue;
      const rate = Number(raw);
      if (!Number.isFinite(rate) || rate < 0) throw new Error(`Bad rate for ${lineItem}/${c.code}: "${raw}"`);
      await query(
        `INSERT INTO accounting.fixed_cost_rate
           (entity_id, category_id, line_item, rate_per_truck_week, effective_from, effective_to, source)
         VALUES ($1, $2, $3, $4, $5::date, NULLIF($6,'')::date, $7)`,
        [byCode.get(c.code), categoryId, lineItem, raw, from, to ?? '', 'Google Sheets "Fixed costs by company"'],
      );
      totals.set(c.code, (totals.get(c.code) ?? 0) + rate);
      loaded += 1;
    }
  }

  // Persist the headcount alongside the rates: rate x THIS count is the
  // operator's real fixed cost, and the posting step needs to know it.
  for (const c of carriers) {
    const n = headcount.get(c.i);
    if (n === undefined) continue;
    await query(
      `INSERT INTO accounting.fixed_cost_rate
         (entity_id, category_id, line_item, rate_per_truck_week, effective_from, effective_to, source)
       VALUES ($1, $2, $3, 0, $4::date, NULLIF($5,'')::date, $6)`,
      [byCode.get(c.code), 'overhead.salaries', `#headcount=${n}`, from, to ?? '',
       'Google Sheets "Fixed costs by company" header row'],
    );
  }

  console.log(`  rates loaded : ${loaded} across ${carriers.length} carriers, effective ${from}${to ? ` to ${to}` : ' onward'}`);
  for (const [code, t] of [...totals].sort()) {
    const c = carriers.find((x) => x.code === code)!;
    const n = headcount.get(c.i);
    console.log(`    ${code.padEnd(8)} $${t.toFixed(2)} per truck per week` +
      (n ? `  x ${n} trucks = $${(t * n).toFixed(2)}/week` : ''));
  }
  console.log('\n  Nothing posted. `post-fixed-costs.ts` turns these into ledger entries.\n');
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
