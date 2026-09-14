/**
 * Truck Max's own invoice log, posted as the ledger entries it implies.
 *
 *   npx tsx scripts/load-truckmax-invoices.ts <tm.json> <posted-by> [--apply]
 *
 * The JSON comes from the analysis pipeline
 * (`ingest/parse_truckmax_invoices.py --json`). This does NOT re-parse those
 * spreadsheets: two parsers over one source eventually disagree, and then
 * nobody knows which is right.
 *
 * WHO PAYS IS NOT WHO BEARS. The pipeline is explicit and this loader
 * repeats it because it is the thing most likely to be forgotten:
 *
 *   Truck Max invoices Zone for almost everything and the teams redistribute
 *   afterwards. The invoice log has no record of the redistribution.
 *
 * So a charge in the `company` file means ZONE WAS BILLED. It does not mean
 * Zone bore the cost. That distinction survives into the ledger as an
 * allocation note on every such row, and the run reports the total sitting
 * on a billing address rather than a confirmed bearer — because a number
 * nobody has flagged is a number somebody will eventually treat as settled.
 *
 * WHAT IS AND IS NOT INTERCOMPANY:
 *
 *   company     ZONE billed      -> both legs: cost to Zone, revenue to the shop
 *   iron_lease  IRONLEASE billed -> both legs
 *   driver      a driver billed  -> shop revenue only. Nobody in the group
 *   sher_imam   an individual       bears it, so there is no second leg, and
 *                                   inventing one would put a cost on a
 *                                   company that was never billed.
 *
 * A FILE THAT DOES NOT RECONCILE DOES NOT POST. Each payer file carries its
 * own printed total and the pipeline checks the detail against it. Where they
 * disagree the rows are refused, not averaged, not taken on faith.
 */
import { readFileSync } from 'node:fs';
import { getPool, query, withTransaction } from '../src/db/pool';
import { postExternalShopWork, postShopWork } from '../src/db/repo/intercompany';
import {
  decide,
  naturalKey,
  refusedPayers,
  type Charge,
  type Control,
} from '../src/ingest/truckmax/plan';

interface Export { generated_utc: string; controls: Control[]; charges: Charge[] }

async function entityIdByCode(code: string): Promise<string> {
  const rows = await query<{ entity_id: string }>(`SELECT entity_id FROM accounting.entity WHERE code = $1`, [code]);
  const id = rows[0]?.entity_id;
  if (!id) throw new Error(`No entity "${code}". Run scripts/seed-reference.ts first.`);
  return id;
}

async function alreadyPosted(): Promise<Set<string>> {
  const rows = await query<{ memo: string }>(
    `SELECT memo FROM accounting.ledger_entry WHERE memo LIKE 'TM:%'`,
  );
  return new Set(rows.map((r) => r.memo.split(' ')[0]!));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const [path, postedBy] = argv.filter((a) => !a.startsWith('--'));
  if (!path || !postedBy) {
    throw new Error('Usage: load-truckmax-invoices.ts <tm.json> <posted-by> [--apply]');
  }

  const data = JSON.parse(readFileSync(path, 'utf8')) as Export;
  const shopId = await entityIdByCode('TRUCKMAX');

  const seen = await alreadyPosted();
  const refused = refusedPayers(data.controls);
  for (const c of data.controls.filter((x) => !x.ties)) {
    console.log(
      `  REFUSED ${c.payer}: detail ${c.detail_sum.toFixed(2)} does not tie to its printed ` +
        `total ${c.printed_total?.toFixed(2) ?? 'none'}. Those rows will not post.`,
    );
  }
  const decisions = data.charges.map((c) => ({ charge: c, decision: decide(c, refused) }));

  const plan = { pair: 0, external: 0, skipped: 0, held: [] as string[] };
  let pairTotal = 0, externalTotal = 0, billingAddressTotal = 0;

  for (const { charge, decision } of decisions) {
    if (decision.kind === 'refused') continue;
    if (decision.kind === 'held') { plan.held.push(decision.reason); continue; }
    if (seen.has(decision.key)) { plan.skipped++; continue; }
    if (decision.kind === 'external') { plan.external++; externalTotal += charge.amount; continue; }
    plan.pair++;
    pairTotal += charge.amount;
    if (decision.billingAddressOnly) billingAddressTotal += charge.amount;
  }

  const usable = decisions.filter((d) => d.decision.kind !== 'refused');

  console.log(`Truck Max invoice log, generated ${data.generated_utc}`);
  console.log(`  ${data.charges.length} charges read, ${usable.length} from files that reconcile\n`);
  console.log(`  intercompany pairs   ${String(plan.pair).padStart(5)}   ${pairTotal.toFixed(2)}`);
  console.log(`  billed outside group ${String(plan.external).padStart(5)}   ${externalTotal.toFixed(2)}`);
  console.log(`  already posted       ${String(plan.skipped).padStart(5)}`);
  console.log(`  held                 ${String(plan.held.length).padStart(5)}`);
  for (const h of plan.held.slice(0, 8)) console.log(`      ${h}`);
  if (plan.held.length > 8) console.log(`      … and ${plan.held.length - 8} more`);

  if (billingAddressTotal > 0) {
    console.log(
      `\n  ${billingAddressTotal.toFixed(2)} of that is billed to ZONE, which is a BILLING ADDRESS.\n` +
        '  Truck Max invoices Zone for almost everything and the teams redistribute afterwards;\n' +
        '  this source has no record of the redistribution. Every such row carries that caveat,\n' +
        '  and a redistribution later is a reversing entry, not an edit.',
    );
  }

  if (!apply) { console.log('\nNothing written. Re-run with --apply.'); return; }

  let posted = 0;
  await withTransaction(async (q) => {
    for (const { charge, decision } of decisions) {
      if (decision.kind === 'refused' || decision.kind === 'held') continue;
      if (seen.has(decision.key)) continue;

      const memo = `${decision.key} ${charge.issue ?? ''}`.trim();
      const shared = {
        shopEntityId: shopId,
        accrualDate: charge.date!,
        amount: charge.amount.toFixed(2),
        unitNumber: charge.truck ?? charge.trailer ?? null,
        postedBy,
      };

      if (decision.kind === 'external') {
        await postExternalShopWork(q, {
          ...shared,
          memo,
          assertedBasis:
            `Truck Max invoice log, ${charge.payer} file. Billed outside the group, so no company bears it.`,
        });
      } else {
        const rows = await q(`SELECT entity_id FROM accounting.entity WHERE code = $1`, [decision.billedCode]);
        const billedEntityId = (rows[0] as { entity_id: string } | undefined)?.entity_id;
        if (!billedEntityId) throw new Error(`No entity "${decision.billedCode}". Run scripts/seed-reference.ts.`);
        await postShopWork(q, {
          ...shared,
          billedEntityId,
          categoryId: decision.categoryId,
          memo,
          assertedBasis: decision.billingAddressOnly
            ? `Truck Max invoice log, ${charge.payer} file. ${decision.billedCode} was BILLED; this source ` +
              'has no record of the redistribution, so it is not evidence that it bore the cost.'
            : `Truck Max invoice log, ${charge.payer} file.`,
        });
      }
      posted++;
    }
  });

  console.log(`\n  posted ${posted} charge(s) — ${plan.pair} as pairs, ${plan.external} as shop revenue only.`);
}

main()
  .then(async () => { await getPool().end(); process.exit(0); })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
