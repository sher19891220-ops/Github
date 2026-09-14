/**
 * Applies the categorisation rules to every document with uncategorised
 * staging rows.
 *
 *   npx tsx scripts/bulk-categorise.ts <applied-by> [--document <id>] [--apply]
 *
 * WHY THIS EXISTS AS A SCRIPT. The rules and the screen have been there
 * since the review UI was built, and on the real expenses sheet 1,768
 * maintenance rows are still sitting in staging — 267 rejected outright for
 * want of a category. Every carrier's maintenance cost is therefore zero,
 * and the P&L is wrong in a known direction. Most of that pile needs no
 * human judgement at all; it needs somebody to press the button 267 times,
 * which is not a thing anybody does.
 *
 * WHAT IT WILL NOT DO. The rows no rule recognises are left alone. There is
 * no fallback category and there must not be: `maintenance.repair` would
 * quietly absorb everything nobody thought about, and a chart of accounts
 * that absorbs everything means nothing. Those rows are reported as the
 * tail that genuinely needs reading.
 *
 * A category is not an entity. A row can come out of this fully categorised
 * and still be unable to post because nobody knows which company bore it,
 * so the run says how many are in that state — "you categorised 267 rows
 * and 140 still cannot post" is the thing a person needs to know before
 * they think the job is done.
 */
import { getPool, query } from '../src/db/pool';
import { applyPlan, planDocument } from '../src/db/repo/bulkCategorise';

function money(n: string): string {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function documentsWithWork(only: string | undefined): Promise<Array<{ id: string; name: string; type: string }>> {
  const rows = await query<{ document_id: string; file_name: string; doc_type: string }>(
    `SELECT DISTINCT d.document_id, d.file_name, d.doc_type
       FROM accounting.source_document d
       JOIN accounting.staging_row s USING (document_id)
      WHERE s.category_id IS NULL
        AND s.status <> 'committed'
        ${only ? 'AND d.document_id = $1' : ''}
      ORDER BY d.file_name`,
    only ? [only] : [],
  );
  return rows.map((r) => ({ id: r.document_id, name: r.file_name, type: r.doc_type }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const docIdx = argv.indexOf('--document');
  const only = docIdx >= 0 ? argv[docIdx + 1] : undefined;
  const appliedBy = argv.filter((a) => !a.startsWith('--') && a !== only)[0];

  if (!appliedBy) {
    throw new Error('Usage: bulk-categorise.ts <applied-by> [--document <id>] [--apply]');
  }

  const docs = await documentsWithWork(only);
  if (docs.length === 0) {
    console.log('Nothing uncategorised. Every staging row already has a category.');
    return;
  }

  let totalRecognised = 0, totalUnrecognised = 0, totalApplied = 0, totalStillNoEntity = 0;

  for (const doc of docs) {
    const plan = await planDocument(doc.id);
    if (plan.uncategorisedRows === 0) continue;

    console.log(`\n${doc.name}  (${doc.type})`);
    console.log(`  ${plan.uncategorisedRows} uncategorised row(s)\n`);

    for (const g of plan.recognised) {
      console.log(
        `  ${String(g.rowCount).padStart(5)} rows  ${money(g.totalAmount).padStart(13)}  ${g.suggestedCategoryId}`,
      );
      console.log(`         because it ${g.rule}`);
      if (g.missingEntityCount > 0) {
        console.log(`         ${g.missingEntityCount} of these still have no company, so they cannot post yet`);
      }
      totalRecognised += g.rowCount;
      totalStillNoEntity += g.missingEntityCount;
    }

    if (plan.unrecognised) {
      const u = plan.unrecognised;
      console.log(
        `\n  ${String(u.rowCount).padStart(5)} rows  ${money(u.totalAmount).padStart(13)}  ` +
          'NO RULE RECOGNISES THESE — left alone',
      );
      console.log(`         ${plan.unrecognisedDescriptions} distinct descriptions, e.g.`);
      for (const sample of u.sampleDescriptions.slice(0, 4)) console.log(`           ${sample.slice(0, 72)}`);
      totalUnrecognised += u.rowCount;
    }

    if (!apply) continue;
    totalApplied += (await applyPlan(plan, appliedBy)).applied;
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`  recognised by a rule   ${String(totalRecognised).padStart(6)}`);
  console.log(`  no rule recognises     ${String(totalUnrecognised).padStart(6)}   (left for a person)`);
  if (totalStillNoEntity > 0) {
    console.log(
      `  categorised but stuck  ${String(totalStillNoEntity).padStart(6)}   ` +
        'no company on the row, so still cannot post',
    );
  }
  if (apply) {
    console.log(`  APPLIED                ${String(totalApplied).padStart(6)}`);
  } else {
    console.log('\nNothing written. Re-run with --apply.');
  }
}

main()
  .then(async () => { await getPool().end(); process.exit(0); })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
