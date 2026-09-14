/**
 * Which migrations have run, and whether the files still say what they said
 * when they ran.
 *
 * Before this existed there was no record at all. Migrations were applied by
 * looping over the directory with `psql`, and `db-local.sh` ended each one
 * with `|| true` — so a migration that FAILED was silently skipped and the
 * loop reported success. Production had no way to answer "which of these has
 * been applied here", and the whole arrangement worked only because all
 * eighteen files happen to have been hand-written idempotent. Nothing
 * enforced that for the nineteenth.
 *
 * The planning logic lives here, separate from anything that touches a
 * database, so the rules below can be tested without one.
 *
 * Three things are treated as refusals rather than warnings, because each is
 * a case where continuing would produce a database nobody can reason about:
 *
 *   drift      An already-applied file's contents changed. The database has
 *              the old version; the repository shows the new one. Editing an
 *              applied migration is how two environments silently diverge —
 *              the fix is always a new migration.
 *   missing    An applied file is gone from the repository. The schema
 *              contains changes with no record of what they were.
 *   backdated  A pending file sorts BEFORE one already applied. Two people
 *              branched, both numbered their migration, and applying them in
 *              filename order now would run them in a different order than
 *              they ran somewhere else.
 */
import { createHash } from 'node:crypto';

export interface MigrationFile {
  name: string;
  sha256: string;
  sql: string;
  /** How the file wants to be run — see `transactionMode`. */
  mode: TransactionMode;
}

export interface AppliedMigration {
  name: string;
  sha256: string;
  appliedAt: string;
}

export type MigrationProblem =
  | { kind: 'drift'; name: string; recorded: string; onDisk: string }
  | { kind: 'missing'; name: string; recorded: string }
  | { kind: 'backdated'; name: string; afterApplied: string };

export interface MigrationPlan {
  pending: MigrationFile[];
  alreadyApplied: string[];
  problems: MigrationProblem[];
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * How a migration file wants to be run. The file decides; the runner obeys.
 *
 *   self-managed  The file opens its own BEGIN … COMMIT. Fourteen of the
 *                 eighteen do, and two of those split into MORE than one
 *                 transaction on purpose — 002 brackets its enum additions
 *                 that way. Adding `--single-transaction` on top produces
 *                 "there is already a transaction in progress", then the
 *                 file's own COMMIT closes the outer one early. Measured on
 *                 001, which failed exactly like that.
 *
 *   none          Adds an enum value and does not wrap itself. Postgres
 *                 permits `ALTER TYPE … ADD VALUE` inside a transaction but
 *                 forbids USING the value until it commits, so these have
 *                 to run statement by statement. Detecting whether the file
 *                 also uses what it adds is guesswork on SQL text, and
 *                 guessing wrong means a migration that works locally and
 *                 dies on deploy — so every enum-adding file gets this.
 *
 *   wrapped       Everything else. The runner supplies the transaction, and
 *                 the bookkeeping row commits inside it, so the change and
 *                 the record of it are never out of step.
 *
 * `-- migrate: no-transaction` forces `none` for a file that needs it for
 * some other reason.
 */
export type TransactionMode = 'wrapped' | 'self-managed' | 'none';

export function transactionMode(sql: string): TransactionMode {
  // A file's own BEGIN wins over everything: it has already decided, and the
  // two files that add enum values inside their own transaction blocks split
  // themselves precisely to make that legal.
  if (/^\s*BEGIN\s*;/im.test(sql)) return 'self-managed';
  if (/^\s*--\s*migrate:\s*no-transaction\s*$/im.test(sql)) return 'none';
  if (/ALTER\s+TYPE\s[\s\S]{0,200}?ADD\s+VALUE/i.test(sql)) return 'none';
  return 'wrapped';
}

/** Filename order IS apply order, so the names have to sort meaningfully.
 *  The 3-digit prefix is what makes that true; this rejects anything that
 *  would sort by accident. */
export function isMigrationName(name: string): boolean {
  return /^\d{3,}_[A-Za-z0-9_.-]+\.sql$/.test(name);
}

export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationPlan {
  const onDisk = new Map(files.map((f) => [f.name, f]));
  const appliedByName = new Map(applied.map((a) => [a.name, a]));
  const problems: MigrationProblem[] = [];

  for (const a of applied) {
    const f = onDisk.get(a.name);
    if (!f) {
      problems.push({ kind: 'missing', name: a.name, recorded: a.sha256 });
      continue;
    }
    if (f.sha256 !== a.sha256) {
      problems.push({ kind: 'drift', name: a.name, recorded: a.sha256, onDisk: f.sha256 });
    }
  }

  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const pending = sorted.filter((f) => !appliedByName.has(f.name));

  // The highest-sorting name that has already run. Anything pending below it
  // would be applied out of the order it ran elsewhere.
  const lastApplied = applied
    .map((a) => a.name)
    .sort()
    .at(-1);
  if (lastApplied) {
    for (const p of pending) {
      if (p.name < lastApplied) problems.push({ kind: 'backdated', name: p.name, afterApplied: lastApplied });
    }
  }

  return { pending, alreadyApplied: [...appliedByName.keys()].sort(), problems };
}

export function describeProblem(p: MigrationProblem): string {
  switch (p.kind) {
    case 'drift':
      return (
        `${p.name} has been edited since it was applied here.\n` +
        `      applied: ${p.recorded.slice(0, 16)}…\n` +
        `      on disk: ${p.onDisk.slice(0, 16)}…\n` +
        '      This database has the old version and the repository shows the new one. ' +
        'Never edit an applied migration — add a new one that makes the change.'
      );
    case 'missing':
      return (
        `${p.name} was applied here but is no longer in the repository.\n` +
        '      The schema carries changes nobody can now read. Restore the file, ' +
        'or if it was deliberately removed, record why before going further.'
      );
    case 'backdated':
      return (
        `${p.name} has never been applied here, but ${p.afterApplied} already has — ` +
        'and it sorts earlier.\n' +
        '      Two branches numbered migrations independently. Applying this now runs ' +
        'them in a different order than they ran elsewhere. Renumber it to sort last.'
      );
  }
}
