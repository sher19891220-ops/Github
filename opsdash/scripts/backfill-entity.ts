/**
 * Gives a company to staging rows that have none.
 *
 *   npx tsx scripts/backfill-entity.ts <applied-by> [--apply]
 *
 * Nothing posts from here: every row it touches stays `under_review`. See
 * src/db/repo/backfillEntity.ts for why each source is trusted as far as it
 * is and no further.
 */
import { getPool, query } from '../src/db/pool';
import { applyEntityBackfill, planEntityBackfill } from '../src/db/repo/backfillEntity';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const appliedBy = argv.find((a) => !a.startsWith('--'));
  if (!appliedBy) throw new Error('Usage: backfill-entity.ts <applied-by> [--apply]');

  const plan = await planEntityBackfill(query);

  const bySource = new Map<string, number>();
  for (const p of plan.proposals) bySource.set(p.source, (bySource.get(p.source) ?? 0) + 1);

  const total = plan.proposals.length + Object.values(plan.unresolved).reduce((a, b) => a + b, 0);
  console.log(`${total} row(s) with a cost and no company\n`);

  console.log('  resolved');
  for (const [source, n] of [...bySource].sort((a, b) => b[1] - a[1])) {
    const label = source === 'bearer' ? 'the row names the company (stated)' : 'the unit\'s carrier history (inferred)';
    console.log(`    ${String(n).padStart(5)}  ${label}`);
  }
  if (bySource.size === 0) console.log('        none');

  console.log('\n  still unresolved');
  for (const [reason, n] of Object.entries(plan.unresolved).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${reason}`);
  }

  if (!apply) { console.log('\nNothing written. Re-run with --apply.'); return; }
  const updated = await applyEntityBackfill(query, plan.proposals, appliedBy);
  console.log(`\n  APPLIED ${updated} — all left under review, because an inferred company is a proposal.`);
}

main()
  .then(async () => { await getPool().end(); process.exit(0); })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
