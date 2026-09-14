/**
 * Brings the analysis pipeline's findings into the ledger's rate table.
 *
 *   npx tsx scripts/load-facts.ts <pipeline-dir> <recorded-by> [options]
 *
 *     --charges --source-document <uuid>   load the arrangement charge sheet
 *     --costs                              load measured costs from config
 *     --facts <path>                       load from a facts.json build
 *     --apply                              write; otherwise report only
 *
 * WHY THIS EXISTS. Two systems were deriving the same costs from the same
 * business. The pipeline reads the invoices, policies, bank statements and
 * IFTA returns; this application never sees those and had been working from
 * an operator's summary sheet — one blended rate per line, divided out of a
 * stated headcount. The pipeline's numbers are better and they are already
 * computed. Re-deriving them here would be the expensive way to be less
 * accurate.
 *
 * WHAT THIS REFUSES TO DO. It will not net a charge against a cost, and it
 * will not load either one under a name that hides which it is.
 *
 * The operator was explicit that the arrangement figures — $650 a week for
 * an owner-operator, $1,650 for lease-to-walk-away — are what drivers are
 * CHARGED, and that the real costs differ. In a lease-to-own business the
 * gap between those two is the entire economics of the programme. Loaded as
 * one number it is invisible; loaded as two it is a subtraction.
 *
 * So charges go in as `charge.*` and costs as `cost.*`, the database
 * enforces that every rate says which it is, and `--spread` prints the
 * subtraction.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getPool, query } from '../src/db/pool';
import { rateSpread, upsertRateFact, RateFactError, type DriverClass, type RateFactInput } from '../src/db/repo/rateFacts';

/** The pipeline's arrangement names, in this system's vocabulary. */
const ARRANGEMENT_CLASS: Record<string, DriverClass> = {
  owner_operator: 'owner_operator',
  lease_to_purchase: 'lease_to_own',
  lease_to_walk_away: 'ltwa',
};

/** Each component of a weekly arrangement charge, and where the matching
 *  cost will eventually land so the two can be subtracted. */
const CHARGE_COMPONENTS: Record<string, { key: string; category: string | null }> = {
  insurance: { key: 'insurance.per_week', category: 'insurance.liability' },
  trailer_rent: { key: 'trailer_rent.per_week', category: 'trailer.fixed' },
  truck_rent: { key: 'truck_rent.per_week', category: 'lease.truck' },
  truck_payment: { key: 'truck_payment.per_week', category: 'lease.truck' },
  admin_fee: { key: 'admin_fee.per_week', category: 'overhead.software' },
  mileage_charge_cpm: { key: 'mileage_charge.per_mile', category: null },
};

function money(n: number): string {
  return n.toFixed(4);
}

async function entityIdByCode(code: string): Promise<string | null> {
  const rows = await query<{ entity_id: string }>(`SELECT entity_id FROM accounting.entity WHERE code = $1`, [code]);
  return rows[0]?.entity_id ?? null;
}

/* ------------------------- the charge side ------------------------- */

function readCharges(dir: string, from: string, sourceDocumentId: string, by: string): RateFactInput[] {
  const file = path.join(dir, 'config', 'driver_arrangement_rates.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
  const out: RateFactInput[] = [];

  for (const [arrangement, driverClass] of Object.entries(ARRANGEMENT_CLASS)) {
    const block = raw[arrangement];
    if (!block) continue;

    for (const [field, value] of Object.entries(block)) {
      // `total_fixed` is the operator's own sum of the lines above it.
      // Loading it alongside its own components would double every
      // arrangement, and a total is not a rate.
      if (field === 'total_fixed' || field.startsWith('_')) continue;
      const spec = CHARGE_COMPONENTS[field];
      if (!spec || typeof value !== 'number') continue;

      out.push({
        rateKey: `charge.arrangement.${spec.key}`,
        kind: 'stated',
        amount: money(value),
        basis: field === 'mileage_charge_cpm' ? 'per_mile' : 'per_period',
        effectiveFrom: from,
        driverClass,
        categoryId: spec.category,
        sourceDocumentId,
        note:
          `What a ${arrangement.replace(/_/g, ' ')} driver is charged, from the operator's ` +
          'arrangement sheet. This is the CHARGE side. The matching cost is a separate fact ' +
          'and the two are never netted.',
        recordedBy: by,
      });
    }
  }
  return out;
}

/* -------------------------- the cost side -------------------------- */

interface PerTruckWeek {
  per_truck_week?: number;
  period_start?: string;
  period_end?: string;
  trucks?: number;
  total?: number;
}

async function readCosts(dir: string, calcRunId: string, by: string): Promise<RateFactInput[]> {
  const file = path.join(dir, 'config', 'telematics_costs.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
  const out: RateFactInput[] = [];

  // Only the shapes that already carry a per-truck-week figure and the
  // period it covers. A figure without a period cannot be effective-dated,
  // and a rate that cannot be dated is one this system will not post.
  for (const [group, body] of Object.entries(raw)) {
    if (typeof body !== 'object' || body === null) continue;
    for (const [code, v] of Object.entries(body as Record<string, unknown>)) {
      const entry = v as PerTruckWeek;
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.per_truck_week !== 'number' || !entry.period_start) continue;

      const entityId = await entityIdByCode(code);
      if (!entityId) continue; // not a carrier code — a note or a sub-object

      out.push({
        rateKey: `cost.${group}.per_truck_week`,
        kind: 'measured',
        amount: money(entry.per_truck_week),
        basis: 'per_period',
        effectiveFrom: entry.period_start,
        effectiveTo: entry.period_end ?? null,
        entityId,
        categoryId: group.startsWith('eld') ? 'other_cost.eld' : 'overhead.software',
        calcRunId,
        note:
          `Measured by the analysis pipeline from ${group} invoices: ` +
          `${entry.total ?? '?'} across ${entry.trucks ?? '?'} trucks for the period. ` +
          'This is the COST side.',
        recordedBy: by,
      });
    }
  }
  return out;
}

/* ------------------------------ run ------------------------------- */

async function openCalcRun(dir: string, from: string, to: string): Promise<string> {
  // The hash is over the files the rates were read from, so a re-run with
  // unchanged inputs is recognisable as the same calculation and a changed
  // input is not silently reported as the same measurement.
  const files = ['config/telematics_costs.json', 'config/insurance.json', 'config/driver_arrangement_rates.json'];
  const h = createHash('sha256');
  for (const f of files) {
    try {
      h.update(readFileSync(path.join(dir, f)));
    } catch {
      h.update(`missing:${f}`);
    }
  }
  const rows = await query<{ calc_run_id: string }>(
    `INSERT INTO accounting.calc_run (engine, engine_version, period_start, period_end, inputs_hash, status, finished_at)
     VALUES ('pipeline', 'fleet-financial-pipeline/config', $1::date, $2::date, $3, 'succeeded', now())
     RETURNING calc_run_id`,
    [from, to, h.digest('hex')],
  );
  return rows[0]!.calc_run_id;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Flags that take a value, so their value is never mistaken for a
  // positional argument. Getting this wrong reads the pipeline directory
  // out of a uuid and fails somewhere far from the cause.
  const VALUED = new Set(['source-document', 'from', 'to', 'on']);
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (VALUED.has(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value.`);
      flags.set(name, v);
      i++;
    } else {
      flags.set(name, 'true');
    }
  }
  const flag = (name: string): string | undefined => flags.get(name);

  const apply = flags.has('apply');
  const wantCharges = flags.has('charges');
  const wantCosts = flags.has('costs');
  const spreadOnly = flags.has('spread');
  const [dir, by] = positional;

  if (spreadOnly) {
    const on = flag('on') ?? new Date().toISOString().slice(0, 10);
    const rows = await rateSpread(query, on);
    if (rows.length === 0) {
      console.log('No rates in force on that date.');
      return;
    }
    console.log(`Charge against cost, per week, in force ${on}:\n`);
    console.log('  subject                          class            charge        cost      spread');
    for (const r of rows) {
      const f = (v: string | null) => (v === null ? '        —' : Number(v).toFixed(2).padStart(9));
      console.log(
        `  ${r.subject.padEnd(32)} ${(r.driverClass ?? '—').padEnd(15)} ${f(r.charge)} ${f(r.cost)} ${f(r.spread)}`,
      );
    }
    console.log(
      '\nA blank cost is a charge nobody has priced yet — which is the point of showing it.\n' +
        'A negative spread is a truck that loses money every week it runs.',
    );
    return;
  }

  if (!dir || !by) throw new Error('Usage: load-facts.ts <pipeline-dir> <recorded-by> [--charges --source-document <uuid>] [--costs] [--apply]');
  if (!wantCharges && !wantCosts) throw new Error('Nothing to do: pass --charges, --costs, or both.');

  const from = flag('from') ?? '2026-01-01';
  const to = flag('to') ?? '2026-12-31';
  const rates: RateFactInput[] = [];

  if (wantCharges) {
    const doc = flag('source-document');
    if (!doc) {
      console.error(
        'The arrangement charges are a STATED rate, so they need the document that states them.\n' +
          'Upload the arrangement sheet through the app, then pass its document id as\n' +
          '--source-document <uuid>. A stated rate with no source is a number somebody remembered,\n' +
          'and this table will not hold one.',
      );
      process.exit(2);
    }
    rates.push(...readCharges(dir, from, doc, by));
  }

  if (wantCosts) {
    const calcRunId = apply ? await openCalcRun(dir, from, to) : '00000000-0000-4000-8000-000000000000';
    rates.push(...(await readCosts(dir, calcRunId, by)));
  }

  console.log(`${rates.length} rate(s) read from ${dir}\n`);
  for (const r of rates) {
    const scope = [r.entityId ? 'entity' : null, r.driverClass].filter(Boolean).join(' ');
    console.log(`  ${r.rateKey.padEnd(44)} ${String(r.amount).padStart(10)}  ${r.basis.padEnd(11)} ${scope}`);
  }

  if (!apply) {
    console.log('\nNothing written. Re-run with --apply.');
    return;
  }

  let inserted = 0, unchanged = 0;
  const conflicts: string[] = [];
  for (const r of rates) {
    try {
      const result = await upsertRateFact(query, r);
      if (result === 'inserted') inserted++;
      else if (result === 'unchanged') unchanged++;
      else conflicts.push(r.rateKey);
    } catch (err) {
      if (err instanceof RateFactError) {
        console.error(`\n  refused: ${err.message}`);
        process.exitCode = 1;
        continue;
      }
      throw err;
    }
  }

  console.log(`\n  inserted  ${inserted}`);
  console.log(`  unchanged ${unchanged}`);
  if (conflicts.length > 0) {
    console.log(`  CONFLICT  ${conflicts.length} — a rate already on file for this period has a different amount:`);
    for (const c of conflicts) console.log(`      ${c}`);
    console.log('  A rate that changed needs a new period, not an overwrite. Nothing was altered.');
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await getPool().end();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
