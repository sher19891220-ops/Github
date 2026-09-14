/**
 * The rules that decide whether a database is at the revision this
 * repository describes.
 *
 * Each of these was a way the old arrangement could go wrong silently.
 * There was no record of what had been applied, and `db-local.sh` applied
 * every file with `|| true`, so a migration that FAILED was skipped and the
 * loop still reported success.
 */
import { describe, expect, it } from 'vitest';
import {
  checksum,
  describeProblem,
  isMigrationName,
  planMigrations,
  transactionMode,
  type AppliedMigration,
  type MigrationFile,
} from '@/db/migrations';

function file(name: string, sql = `-- ${name}`): MigrationFile {
  return { name, sql, sha256: checksum(sql), mode: transactionMode(sql) };
}
function applied(f: MigrationFile): AppliedMigration {
  return { name: f.name, sha256: f.sha256, appliedAt: '2026-01-01T00:00:00Z' };
}

describe('transactionMode — the file decides, the runner obeys', () => {
  it('leaves a file that opens its own transaction alone', () => {
    // Adding --single-transaction on top of this produces "there is already
    // a transaction in progress", and the file's own COMMIT then closes the
    // outer one early. Migration 001 failed exactly this way.
    expect(transactionMode('BEGIN;\nCREATE TABLE x ();\nCOMMIT;')).toBe('self-managed');
  });

  it('refuses to wrap a file that adds an enum value', () => {
    // Postgres allows ALTER TYPE ... ADD VALUE in a transaction but forbids
    // USING the value until it commits.
    expect(transactionMode("ALTER TYPE t ADD VALUE IF NOT EXISTS 'x';")).toBe('none');
  });

  it('treats a self-managed file as self-managed even when it also adds an enum value', () => {
    // 002 and 007 do both, and split themselves into separate transactions
    // precisely to make it legal. Second-guessing them breaks them.
    expect(transactionMode("BEGIN;\nSELECT 1;\nCOMMIT;\nALTER TYPE t ADD VALUE 'x';")).toBe('self-managed');
  });

  it('honours an explicit opt-out', () => {
    expect(transactionMode('-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY i ON t (c);')).toBe('none');
  });

  it('wraps everything else', () => {
    expect(transactionMode('CREATE TABLE x ();')).toBe('wrapped');
  });
});

describe('isMigrationName', () => {
  it('requires a numeric prefix, because filename order IS apply order', () => {
    expect(isMigrationName('019_add_thing.sql')).toBe(true);
    expect(isMigrationName('add_thing.sql')).toBe(false);
    expect(isMigrationName('7_add_thing.sql')).toBe(false);
    expect(isMigrationName('019_add_thing.txt')).toBe(false);
  });
});

describe('planMigrations', () => {
  const a = file('001_a.sql');
  const b = file('002_b.sql');
  const c = file('003_c.sql');

  it('applies nothing twice', () => {
    const plan = planMigrations([a, b], [applied(a), applied(b)]);
    expect(plan.pending).toEqual([]);
    expect(plan.problems).toEqual([]);
  });

  it('finds what is pending, in filename order', () => {
    const plan = planMigrations([c, a, b], [applied(a)]);
    expect(plan.pending.map((f) => f.name)).toEqual(['002_b.sql', '003_c.sql']);
    expect(plan.problems).toEqual([]);
  });

  it('refuses when an applied migration has been edited', () => {
    // The database has the old version; the repository shows the new one.
    // Two environments diverge from here and nothing says so.
    const edited = file('001_a.sql', '-- 001_a.sql\n-- plus a change');
    const plan = planMigrations([edited], [applied(a)]);
    expect(plan.problems).toEqual([
      { kind: 'drift', name: '001_a.sql', recorded: a.sha256, onDisk: edited.sha256 },
    ]);
  });

  it('refuses when an applied migration has been deleted', () => {
    const plan = planMigrations([b], [applied(a), applied(b)]);
    expect(plan.problems.map((p) => p.kind)).toEqual(['missing']);
  });

  it('refuses a migration numbered below one already applied', () => {
    // Two branches numbered independently. Applying this now runs them in a
    // different order than they ran wherever the other branch was deployed.
    const branchA = file('019_branch_a.sql');
    const branchB = file('019_branch_b.sql');
    const plan = planMigrations([branchA, branchB], [applied(branchB)]);
    expect(plan.problems).toEqual([
      { kind: 'backdated', name: '019_branch_a.sql', afterApplied: '019_branch_b.sql' },
    ]);
  });

  it('does not call a normal new migration backdated', () => {
    const plan = planMigrations([a, b, c], [applied(a), applied(b)]);
    expect(plan.problems).toEqual([]);
    expect(plan.pending.map((f) => f.name)).toEqual(['003_c.sql']);
  });

  it('reports every problem at once rather than one per run', () => {
    const edited = file('001_a.sql', 'changed');
    const plan = planMigrations([edited], [applied(a), applied(b)]);
    expect(plan.problems.map((p) => p.kind).sort()).toEqual(['drift', 'missing']);
  });
});

describe('describeProblem', () => {
  it('says what to do, not just what is wrong', () => {
    const drift = describeProblem({ kind: 'drift', name: 'x.sql', recorded: 'a'.repeat(64), onDisk: 'b'.repeat(64) });
    expect(drift).toMatch(/Never edit an applied migration/);

    const missing = describeProblem({ kind: 'missing', name: 'x.sql', recorded: 'a'.repeat(64) });
    expect(missing).toMatch(/Restore the file/);

    const backdated = describeProblem({ kind: 'backdated', name: 'a.sql', afterApplied: 'b.sql' });
    expect(backdated).toMatch(/Renumber it to sort last/);
  });
});
