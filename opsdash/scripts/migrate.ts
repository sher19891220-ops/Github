/**
 * Applies pending migrations, in order, and records what it did.
 *
 *   npx tsx scripts/migrate.ts             apply everything pending
 *   npx tsx scripts/migrate.ts --status    say what would happen, change nothing
 *   npx tsx scripts/migrate.ts --baseline  adopt a database that already has
 *                                          the schema, without re-running
 *
 * Exit codes matter here: anything other than 0 means the database is not at
 * the revision the repository describes, and a deploy that continues past it
 * is deploying code against a schema it was not written for.
 *
 * `--baseline` exists for the databases that predate this script. They
 * already have every migration applied and no record of it, so running them
 * again would be wrong even though they are idempotent. Baseline records
 * them as applied and executes nothing. It refuses if anything is already
 * recorded, so it can never be used to paper over a real pending migration.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getPool, query } from '../src/db/pool';
import {
  describeProblem,
  isMigrationName,
  planMigrations,
  transactionMode,
  type AppliedMigration,
  type MigrationFile,
} from '../src/db/migrations';

const DIR = path.join(__dirname, '..', 'db', 'migrations');

/** Lives in `public`, not `accounting`: migration 001 is what creates the
 *  `accounting` schema, so the table that tracks it cannot live inside it. */
const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    name        text PRIMARY KEY,
    sha256      text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    applied_by  text NOT NULL DEFAULT current_user,
    duration_ms integer
  )`;

function readMigrations(): MigrationFile[] {
  const names = readdirSync(DIR).filter((n) => n.endsWith('.sql'));
  const bad = names.filter((n) => !isMigrationName(n));
  if (bad.length > 0) {
    throw new Error(
      `These files are in db/migrations but are not named so they sort meaningfully: ${bad.join(', ')}. ` +
        'Filename order is apply order; a name without a numeric prefix runs at an unpredictable point.',
    );
  }
  return names
    .sort()
    .map((name) => {
      const sql = readFileSync(path.join(DIR, name), 'utf8');
      return {
        name,
        sql,
        sha256: createHash('sha256').update(sql, 'utf8').digest('hex'),
        mode: transactionMode(sql),
      };
    });
}

async function readApplied(): Promise<AppliedMigration[]> {
  await query(CREATE_TABLE);
  const rows = await query<{ name: string; sha256: string; applied_at: string }>(
    `SELECT name, sha256, applied_at::text FROM public.schema_migrations ORDER BY name`,
  );
  return rows.map((r) => ({ name: r.name, sha256: r.sha256, appliedAt: r.applied_at }));
}

/**
 * Migrations are applied by `psql`, not by the node driver, and that is not
 * laziness — it is the only way to get the semantics right.
 *
 * node-postgres sends a whole file as ONE query message, and Postgres treats
 * multiple statements in one message as an implicit transaction. So a file
 * that adds an enum value and then uses it fails even when this script has
 * carefully avoided opening a transaction of its own. Measured: migration
 * 010 failed identically with and without an explicit transaction until the
 * statements were sent separately.
 *
 * `psql` sends them one at a time, which is how these files have always been
 * applied and what they are written for. `--single-transaction` gives back
 * the all-or-nothing behaviour for the files that can take it — and because
 * the bookkeeping INSERT runs in the same invocation, the change and the
 * record of it commit together or not at all.
 */
function applyWithPsql(f: MigrationFile, started: number): { ok: true } | { ok: false; error: string } {
  const url = process.env.DATABASE_URL;
  if (!url) return { ok: false, error: 'DATABASE_URL is not set.' };

  // Inlined rather than passed as psql variables: `-c` does not interpolate
  // them, which is how an earlier attempt sent a literal ":'mname'" to the
  // server. Safe to inline because `isMigrationName` restricts the filename
  // charset and the checksum is hex — neither can carry a quote.
  const record =
    'INSERT INTO public.schema_migrations (name, sha256, duration_ms) ' +
    `VALUES ('${f.name}', '${f.sha256}', ${Date.now() - started})`;

  const args = [url, '-v', 'ON_ERROR_STOP=1', '--quiet', '--no-psqlrc'];
  if (f.mode === 'wrapped') args.push('--single-transaction');
  args.push('-f', path.join(DIR, f.name), '-c', record);

  const r = spawnSync('psql', args, { encoding: 'utf8' });
  if (r.error) {
    return { ok: false, error: `could not run psql: ${r.error.message}. It is required to apply migrations.` };
  }
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || '').trim() || `psql exited ${r.status}` };
  }
  return { ok: true };
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');
  const baseline = process.argv.includes('--baseline');

  const files = readMigrations();
  const applied = await readApplied();
  const plan = planMigrations(files, applied);

  if (plan.problems.length > 0) {
    console.error('migrate: REFUSING to continue.\n');
    for (const p of plan.problems) console.error(`  ✗ ${describeProblem(p)}\n`);
    process.exit(2);
  }

  if (statusOnly) {
    console.log(`applied : ${plan.alreadyApplied.length}`);
    console.log(`pending : ${plan.pending.length}`);
    for (const p of plan.pending) console.log(`  → ${p.name}${p.mode === 'wrapped' ? '' : `  (${p.mode})`}`);
    if (plan.pending.length === 0) console.log('\nDatabase is at the revision this repository describes.');
    return;
  }

  if (baseline) {
    if (plan.alreadyApplied.length > 0) {
      console.error(
        `migrate: --baseline refused. ${plan.alreadyApplied.length} migration(s) are already recorded here, ` +
          'so this database is already tracked and baselining would hide whatever is pending.',
      );
      process.exit(2);
    }
    for (const f of files) {
      await query(`INSERT INTO public.schema_migrations (name, sha256, duration_ms) VALUES ($1, $2, 0)`, [
        f.name,
        f.sha256,
      ]);
    }
    console.log(`migrate: baselined ${files.length} migration(s) as already applied. Nothing was executed.`);
    return;
  }

  if (plan.pending.length === 0) {
    console.log(`migrate: nothing to do — ${plan.alreadyApplied.length} migration(s) already applied.`);
    return;
  }

  for (const f of plan.pending) {
    const started = Date.now();
    process.stdout.write(`  ${f.name}${f.mode === 'wrapped' ? '' : ` (${f.mode})`} ... `);
    const result = applyWithPsql(f, started);
    if (result.ok) {
      console.log(`ok (${Date.now() - started}ms)`);
      continue;
    }
    console.log('FAILED');
    console.error(`\nmigrate: ${f.name} failed and was NOT recorded as applied.`);
    console.error(
      f.mode === 'wrapped'
        ? 'Its changes were rolled back. Fix the file and run again.'
        : f.mode === 'self-managed'
          ? 'It manages its own transaction, so whatever it had committed before the failure ' +
            'stands. Check the schema before re-running.'
          : 'It adds an enum value and so runs statement by statement. Part of it may have ' +
            'taken effect. Check the schema before re-running.',
    );
    console.error(`\n${result.error}`);
    process.exit(1);
  }

  console.log(`\nmigrate: applied ${plan.pending.length} migration(s).`);
}

main()
  .then(async () => {
    await getPool().end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
