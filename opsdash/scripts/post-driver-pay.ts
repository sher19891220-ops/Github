/**
 * Posts company-driver pay: cents per mile x miles driven.
 *
 * The operator's driver list gives a pay rate per driver. Matching those names
 * against the dispatch sheet covers only 25% of truck-weeks, and unevenly —
 * it matched Xtrack drivers more often than Zone's despite being titled "Zone
 * LLC", so drivers clearly move between carriers and the list is a general
 * roster. Posting per-driver at 25% coverage would understate driver pay AND
 * bias it by carrier, making the carrier with better name coverage look worse.
 *
 * So this uses one blended rate for every CPM truck-week. That is defensible
 * here because the rates barely vary: of 160 drivers, mean 65.03c, median 65,
 * mode 65, and 114 of them are exactly 65. A blended rate loses almost nothing
 * and removes the coverage bias entirely.
 *
 * OWNER-OPERATORS AND LEASE-OPERATORS ARE DELIBERATELY NOT POSTED. Their pay
 * is a revenue share (88%), not a mileage rate, and they also reimburse the
 * carrier for truck rent and insurance through deductions. The fixed-cost rate
 * card already charges the carrier that truck rent and insurance, so posting
 * the 88% without the offsetting deduction would count those costs twice and
 * overstate what an owner-operator truck costs. That needs the deduction side
 * of the OO terms sheet, which is a separate piece of work.
 *
 *   npx tsx scripts/post-driver-pay.ts <from> <to> <cents-per-mile> <asserted-by> [--apply]
 */
import { readFileSync } from 'node:fs';
import { query } from '../src/db/pool';
import { createManualEntry } from '../src/db/repo/manualEntry';
import { resolveEntityFromTruck } from '../src/db/repo/entityResolution';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

interface Week { week: string; truck: string; pay: string; miles: number | null }

/** Reads truck-weeks out of the dispatch export: week, truck, payment type, miles. */
function readDispatch(text: string): Week[] {
  const lines = text.split('\n');
  const rosterStart = lines.findIndex((l) => /Dispatcher Name/.test(l) && /Company Type/.test(l));
  let rosterEnd = rosterStart + 1;
  while (rosterEnd < lines.length && lines[rosterEnd]!.split('|').length >= 6) rosterEnd += 1;

  const dateRe = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/;
  const out: Week[] = [];
  let week: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    if (i >= rosterStart && i < rosterEnd) continue;
    const line = lines[i]!;
    if (/\|\s*Dispatcher\s*\|/.test(line) && /Truck/.test(line)) {
      const m = dateRe.exec(line);
      if (m) {
        week = `${m[3]}-${String(MONTHS[m[1] as string]).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
      }
      continue;
    }
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 6 || week === null) continue;
    const truck = cells[2] ?? '';
    const driver = cells[4] ?? '';
    if (!/^\d+$/.test(truck) || driver === '' || /^(Driver|Cancelled|Rejected)/i.test(driver)) continue;

    // Miles is the last bare integer on the row — the sheet puts Gross, Miles,
    // RPM at the end and Gross always carries decimals.
    let miles: number | null = null;
    for (let j = cells.length - 1; j > 5; j -= 1) {
      const v = (cells[j] ?? '').replace(/[,$]/g, '');
      if (/^\d{2,5}$/.test(v)) { miles = Number(v); break; }
    }
    out.push({ week, truck, pay: (cells[3] ?? '').toUpperCase(), miles });
  }
  return out;
}

async function main(): Promise<void> {
  const [from, to, cpmRaw, assertedBy] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  if (!from || !to || !cpmRaw || !assertedBy || !ISO.test(from) || !ISO.test(to)) {
    throw new Error('Usage: post-driver-pay.ts <from> <to> <cents-per-mile> <asserted-by> [--apply]');
  }
  const cpm = Number(cpmRaw);
  if (!Number.isFinite(cpm) || cpm <= 0 || cpm > 200) throw new Error(`Implausible rate: ${cpmRaw} cents per mile.`);

  const rows = readDispatch(readFileSync('/home/user/opsdash-fixtures/dispatch2026.txt', 'utf8'))
    .filter((r) => r.week >= from && r.week <= to);

  // Aggregate to carrier-week: one entry per carrier per week, not per truck.
  // Driver pay is not a per-truck measurement here, it is a rate applied to
  // miles, and posting it per truck would invite a per-truck cost-per-mile
  // that is really just the rate back again.
  const bucket = new Map<string, { entityId: string; week: string; miles: number; trucks: Set<string> }>();
  let skippedNoMiles = 0, skippedNoCarrier = 0, nonCpm = 0;

  for (const r of rows) {
    if (r.pay !== 'CPM') { nonCpm += 1; continue; }
    if (r.miles === null) { skippedNoMiles += 1; continue; }
    const carrier = await resolveEntityFromTruck(query, r.truck, r.week);
    if (carrier.entityId === null) { skippedNoCarrier += 1; continue; }
    const key = `${carrier.entityId}::${r.week}`;
    const b = bucket.get(key) ?? { entityId: carrier.entityId, week: r.week, miles: 0, trucks: new Set<string>() };
    b.miles += r.miles;
    b.trucks.add(r.truck);
    bucket.set(key, b);
  }

  const codes = new Map(
    (await query<{ entity_id: string; code: string }>(`SELECT entity_id, code FROM accounting.entity`))
      .map((e) => [e.entity_id, e.code]),
  );

  let posted = 0, skippedPosted = 0, totalCents = 0;
  const perCarrier = new Map<string, number>();

  for (const b of [...bucket.values()].sort((x, y) => x.week.localeCompare(y.week))) {
    const cents = Math.round(b.miles * cpm);
    if (cents === 0) continue;

    const already = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting.ledger_entry
        WHERE entity_id = $1 AND category_id = 'driver_pay.settlement'
          AND accrual_date = $2::date AND allocation_basis = 'rate_card'`,
      [b.entityId, b.week],
    );
    if (Number(already[0]?.n ?? 0) > 0) { skippedPosted += 1; continue; }

    if (apply) {
      await createManualEntry(
        {
          entityId: b.entityId,
          accrualDate: b.week as `${number}-${number}-${number}`,
          categoryId: 'driver_pay.settlement',
          amount: (-cents / 100).toFixed(2),
          chargedTo: 'company',
          memo: `Company-driver pay, week of ${b.week}: ${b.miles.toLocaleString()} mi x ${cpm}c across ${b.trucks.size} trucks`,
          allocationBasis: 'rate_card',
          allocationNote: `${b.miles} miles @ ${cpm}c/mile (blended company-driver rate)`,
          assertedBy,
          basis:
            `Company-driver pay at a blended ${cpm}c per mile against miles on the dispatch sheet. ` +
            `The operator's driver list gives 160 rates: mean 65.03c, median 65, mode 65. ` +
            `Owner-operators and lease-operators are excluded — they are paid a revenue share, not a mileage rate.`,
        },
        assertedBy,
      );
    }
    posted += 1;
    totalCents += cents;
    const code = codes.get(b.entityId) ?? '?';
    perCarrier.set(code, (perCarrier.get(code) ?? 0) + cents);
  }

  console.log(`dispatch truck-weeks in range : ${rows.length}`);
  console.log(`  non-CPM (OO/LO/other), excluded : ${nonCpm}`);
  console.log(`  CPM but no miles figure        : ${skippedNoMiles}`);
  console.log(`  CPM but no carrier for that week: ${skippedNoCarrier}`);
  console.log(`\nentries ${apply ? 'posted' : 'to post'} : ${posted}${skippedPosted ? `  (${skippedPosted} already posted)` : ''}`);
  console.log(`company-driver pay @ ${cpm}c/mile : $${(totalCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  for (const [code, c] of [...perCarrier].sort()) {
    console.log(`    ${code.padEnd(8)} $${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  }
  if (!apply) console.log('\nDry run. Re-run with --apply to post.');
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
