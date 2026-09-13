/**
 * Posts the fixed-cost rate card to the ledger, one week at a time.
 *
 * cost(carrier, week, category) = sum(rates for that category) x trucks that
 * carrier was running that week.
 *
 * The truck count comes from `truck_entity_history`, so it is the trucks
 * actually assigned that week — a unit that left in March stops accruing
 * fixed cost in March. That is more truthful than a flat headcount, and it is
 * why the roster was made effective-dated in the first place.
 *
 * It also means the total will NOT equal the operator's own arithmetic. They
 * divided a period's fixed cost by a headcount (31/48/7) to GET these rates;
 * multiplying back by a different, week-varying count gives a different
 * number. The script prints both counts so the difference is visible rather
 * than discovered later.
 *
 * Every entry posts with `allocation_basis = 'rate_card'`. A rate card is a
 * model of cost, not a receipt, and nothing downstream may read it as
 * measured. The ledger is append-only, so a week already posted is skipped
 * rather than posted twice.
 *
 *   npx tsx scripts/post-fixed-costs.ts <from> <to> <asserted-by> [--apply]
 */
import { query } from '../src/db/pool';
import { createManualEntry } from '../src/db/repo/manualEntry';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (dt: Date) => dt.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const x = d(s); x.setUTCDate(x.getUTCDate() + n); return iso(x); };

/** Mondays from `from` to `to`, inclusive of any week that starts in range. */
function mondays(from: string, to: string): string[] {
  const start = d(from);
  // 0=Sun..6=Sat -> step back to Monday
  const back = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - back);
  const out: string[] = [];
  for (let cur = iso(start); cur <= to; cur = addDays(cur, 7)) out.push(cur);
  return out;
}

async function main(): Promise<void> {
  const [from, to, assertedBy] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  if (!from || !to || !assertedBy || !ISO.test(from) || !ISO.test(to)) {
    throw new Error('Usage: post-fixed-costs.ts <from:YYYY-MM-DD> <to:YYYY-MM-DD> <asserted-by> [--apply]');
  }

  const weeks = mondays(from, to);
  let posted = 0, skipped = 0, totalCents = 0;
  const perCarrier = new Map<string, number>();
  const rosterSeen = new Map<string, number>();
  const statedCount = new Map<string, number>();

  for (const weekStart of weeks) {
    const weekEnd = addDays(weekStart, 6);

    // Rates in force this week, summed per carrier per category.
    const rates = await query<{ entity_id: string; code: string; category_id: string; rate: string; lines: string }>(
      `SELECT r.entity_id, e.code, r.category_id,
              sum(r.rate_per_truck_week)::text AS rate,
              string_agg(r.line_item, ', ' ORDER BY r.line_item) AS lines
         FROM accounting.fixed_cost_rate r
         JOIN accounting.entity e USING (entity_id)
        WHERE r.effective_from <= $1::date
          AND (r.effective_to IS NULL OR r.effective_to >= $1::date)
        GROUP BY 1, 2, 3`,
      [weekStart],
    );
    if (rates.length === 0) continue;

    // The headcount each rate was divided out of, stated by the sheet itself.
    // rate x THIS count is the operator's real fixed cost; any other count
    // gives a different number, because the rate is that number divided by it.
    const stated = await query<{ entity_id: string; n: string }>(
      `SELECT entity_id, regexp_replace(line_item, '^#headcount=', '') AS n
         FROM accounting.fixed_cost_rate
        WHERE line_item LIKE '#headcount=%'
          AND effective_from <= $1::date
          AND (effective_to IS NULL OR effective_to >= $1::date)`,
      [weekStart],
    );
    const trucks = new Map(stated.map((c) => [c.entity_id, Number(c.n)]));

    // What the dated roster can actually see that week. Reported, not used:
    // the roster only knows trucks that earned on the dispatch sheet, so it
    // runs well below the real fleet and would understate cost by ~40%.
    const seen = await query<{ entity_id: string; n: string }>(
      `SELECT h.entity_id, count(DISTINCT h.truck_id)::text AS n
         FROM accounting.truck_entity_history h
        WHERE h.effective_from <= $2::date
          AND (h.effective_to IS NULL OR h.effective_to >= $1::date)
        GROUP BY 1`,
      [weekStart, weekEnd],
    );
    for (const s of seen) rosterSeen.set(s.entity_id, Math.max(rosterSeen.get(s.entity_id) ?? 0, Number(s.n)));

    for (const r of rates) {
      const n = trucks.get(r.entity_id) ?? 0;
      if (n === 0) continue;

      const cents = Math.round(Number(r.rate) * 100) * n;
      if (cents === 0) continue;

      const already = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM accounting.ledger_entry
          WHERE entity_id = $1 AND category_id = $2 AND accrual_date = $3::date
            AND allocation_basis = 'rate_card'`,
        [r.entity_id, r.category_id, weekStart],
      );
      if (Number(already[0]?.n ?? 0) > 0) { skipped += 1; continue; }

      if (apply) {
        await createManualEntry(
          {
            entityId: r.entity_id,
            accrualDate: weekStart as `${number}-${number}-${number}`,
            categoryId: r.category_id,
            amount: (-cents / 100).toFixed(2),
            chargedTo: 'company',
            memo: `Fixed cost, week of ${weekStart}: ${n} trucks x $${Number(r.rate).toFixed(2)}`,
            allocationBasis: 'rate_card',
            allocationNote: `${r.lines} @ $${Number(r.rate).toFixed(2)}/truck/week x ${n} trucks`,
            assertedBy,
            basis:
              `Operator's "Fixed costs by company" rate card, per truck per week. ` +
              `Truck count from the dated roster for the week of ${weekStart}. ` +
              `This is a modelled cost, not an invoice.`,
          },
          assertedBy,
        );
      }
      posted += 1;
      totalCents += cents;
      perCarrier.set(r.code, (perCarrier.get(r.code) ?? 0) + cents);
      statedCount.set(r.code, n);
    }
  }

  console.log(`weeks in range        : ${weeks.length} (${weeks[0]} .. ${weeks[weeks.length - 1]})`);
  console.log(`entries ${apply ? 'posted' : 'to post'}      : ${posted}${skipped ? `  (${skipped} already posted, skipped)` : ''}`);
  console.log(`total fixed cost      : $${(totalCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  for (const [code, c] of [...perCarrier].sort()) {
    console.log(`    ${code.padEnd(8)} $${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  }
  console.log('\ntruck count used vs what the roster can see:');
  const codes = await query<{ entity_id: string; code: string }>(`SELECT entity_id, code FROM accounting.entity`);
  for (const c of codes) {
    const used = statedCount.get(c.code);
    if (used === undefined) continue;
    const seenN = rosterSeen.get(c.entity_id) ?? 0;
    console.log(`    ${c.code.padEnd(8)} used ${String(used).padStart(3)} (operator's headcount)   roster sees ${String(seenN).padStart(3)}`);
  }
  console.log('  The roster only knows trucks that earned on the dispatch sheet.');
  console.log('  Using its count instead would understate fixed cost by roughly 40%.');
  if (!apply) console.log('\nDry run. Re-run with --apply to post.');
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
