/**
 * Consolidates the trailer cost the expenses sheet leaves unattributed.
 *
 * Trailers are pooled between the carriers (migration 016), so a trailer row
 * with no company on it is genuinely shared cost, not a labelling accident.
 * This splits that pool across the carriers by TRUCK COUNT and posts one
 * manual entry each, every one carrying a named asserter and a stated basis.
 *
 * Truck count, not revenue and not each carrier's already-attributed trailer
 * cost — see migration 017 for why. The staging rows it consolidates are
 * marked `rejected` with a note pointing at the entries, so the same money can
 * never post twice if someone later assigns those rows a company.
 *
 *   npx tsx scripts/consolidate-trailer-cost.ts <from> <to> <asserted-by> [--apply]
 */
import { query, withTransaction } from '../src/db/pool';
import { createManualEntry } from '../src/db/repo/manualEntry';
import { shareByCount } from '../src/engines/allocate/shareByCount';
import { TRAILER_FIXED_CATEGORY } from '../src/db/repo/categorise';

const centsOf = (d: string) => Math.round(Number(d) * 100);
const decOf = (c: number) => (c / 100).toFixed(2);

async function main(): Promise<void> {
  const [from, to, assertedBy] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  if (!from || !to || !assertedBy) {
    throw new Error('Usage: consolidate-trailer-cost.ts <from> <to> <asserted-by> [--apply]');
  }

  const pool = await query<{ n: string; amt: string }>(
    `SELECT count(*)::text n, coalesce(sum(amount), 0)::text amt
       FROM accounting.staging_row
      WHERE category_id = $1 AND entity_id IS NULL AND status <> 'committed'
        AND accrual_date >= $2::date AND accrual_date <= $3::date`,
    [TRAILER_FIXED_CATEGORY, from, to],
  );
  const rowCount = Number(pool[0]?.n ?? 0);
  const totalCents = centsOf(pool[0]?.amt ?? '0');
  if (rowCount === 0 || totalCents === 0) {
    console.log('Nothing to consolidate in this period.');
    return;
  }

  // Weight = trucks with a carrier period overlapping the window. A truck
  // that left in March pulled trailers until March, so it counts.
  const weights = await query<{ entity_id: string; code: string; n: string }>(
    `SELECT e.entity_id, e.code, count(DISTINCT h.truck_id)::text n
       FROM accounting.entity e
       JOIN accounting.truck_entity_history h USING (entity_id)
      WHERE h.effective_from <= $2::date
        AND (h.effective_to IS NULL OR h.effective_to >= $1::date)
      GROUP BY 1, 2 ORDER BY 2`,
    [from, to],
  );
  if (weights.length === 0) throw new Error('No carrier has a truck in this period; cannot split.');

  const shares = shareByCount(
    totalCents,
    weights.map((w) => ({ key: w.code, weight: Number(w.n) })),
  );
  const byCode = new Map(weights.map((w) => [w.code, w]));
  const totalTrucks = weights.reduce((s, w) => s + Number(w.n), 0);

  console.log(`Unattributed trailer cost ${from}..${to}: ${rowCount} rows, $${decOf(Math.abs(totalCents))}`);
  console.log(`Split by truck count across ${totalTrucks} trucks:\n`);
  for (const s of shares) {
    const w = byCode.get(s.key)!;
    const pct = ((100 * Number(w.n)) / totalTrucks).toFixed(1);
    console.log(`  ${s.key.padEnd(8)} ${String(w.n).padStart(3)} trucks (${pct.padStart(5)}%)  $${decOf(Math.abs(s.cents))}`);
  }
  if (!apply) {
    console.log('\nDry run. Re-run with --apply to post these entries.');
    return;
  }

  const basis =
    `Consolidated share of trailer cost the expenses sheet left without a company ` +
    `(${rowCount} rows, $${decOf(Math.abs(totalCents))}, ${from}..${to}). ` +
    `Trailers are pooled between the carriers, so this is shared cost. ` +
    `Split by truck count (${totalTrucks} trucks in the period) — not by revenue, and not by ` +
    `each carrier's already-attributed trailer cost, which measures which rows happened to be labelled. ` +
    `This is an allocation, not a measured per-carrier amount.`;

  for (const s of shares) {
    if (s.cents === 0) continue;
    const w = byCode.get(s.key)!;
    await createManualEntry(
      {
        entityId: w.entity_id,
        accrualDate: to as `${number}-${number}-${number}`,
        categoryId: TRAILER_FIXED_CATEGORY,
        amount: decOf(s.cents),
        unitType: 'trailer',
        chargedTo: 'company',
        memo: `Consolidated trailer cost — ${w.n} of ${totalTrucks} trucks`,
        // Without this the row posts as `actual` and the P&L cannot tell an
        // allocation from a measured amount — migration 003's whole point.
        allocationBasis: 'by_truck_count',
        allocationNote:
          `${w.n} of ${totalTrucks} trucks in ${from}..${to}; ` +
          `pool $${decOf(Math.abs(totalCents))} over ${rowCount} rows with no company stated`,
        assertedBy,
        basis,
      },
      assertedBy,
    );
  }

  // Close the source rows so this money cannot post a second time.
  const closed = await withTransaction(async (q) => {
    const r = (await q(
      `UPDATE accounting.staging_row
          SET status = 'rejected',
              review_notes = coalesce(review_notes || ' ', '') ||
                'CONSOLIDATED: no company on this row; its value is included in the truck-count ' ||
                'split of shared trailer cost posted for this period. Not posted individually, so it is counted once.',
              reviewed_by = $4, reviewed_at = now()
        WHERE category_id = $1 AND entity_id IS NULL AND status <> 'committed'
          AND accrual_date >= $2::date AND accrual_date <= $3::date
        RETURNING 1`,
      [TRAILER_FIXED_CATEGORY, from, to, assertedBy],
    )) as unknown[];
    return r.length;
  });

  console.log(`\nPosted ${shares.filter((s) => s.cents !== 0).length} allocation entries.`);
  console.log(`Closed ${closed} source rows so the same money cannot post twice.`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
