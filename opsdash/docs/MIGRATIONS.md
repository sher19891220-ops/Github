# Changing the schema

Every migration that has run against a database is recorded in
`public.schema_migrations` with its filename, a checksum of its contents,
when it ran and how long it took.

Before that existed there was no record at all. Migrations were applied by
looping over the directory with `psql`, and the development script ended
each one with `|| true` — so a migration that **failed** was skipped and the
script still printed a ready-to-use database URL. Production had no way to
answer "which of these has run here". The whole arrangement worked only
because all eighteen files happen to have been hand-written idempotent, and
nothing enforced that for the nineteenth.

## Day to day

```bash
npm run db:migrate          # apply anything pending
npm run db:migrate:status   # say what would happen, change nothing
```

Both need `DATABASE_URL`, and `psql` on the PATH. Exit codes are meaningful:
anything other than 0 means the database is not at the revision this
repository describes, and deploying code against it is deploying against a
schema that code was not written for.

## Three refusals

The runner stops rather than warns in three cases, because each leaves a
database nobody can reason about.

**An applied migration was edited.** The database has the old version and
the repository shows the new one. Two environments have silently diverged.
The fix is never to edit the file back — it is a new migration that makes
the change.

**An applied migration is gone from the repository.** The schema carries
changes with no record of what they were.

**A pending migration sorts before one already applied.** Two branches both
numbered a migration; applying it now runs them in a different order than
they ran wherever the other branch was deployed. Renumber it to sort last.

## Adopting a database that predates this

```bash
npm run db:migrate -- --baseline
```

Records every file as applied without executing any of them. For databases
that already have the full schema and no tracking table. It refuses if
anything is already recorded, so it cannot be used to skip a real pending
migration.

## Writing a migration

Name it `NNN_short_description.sql` with a three-digit prefix. **Filename
order is apply order** — a name without a numeric prefix is rejected,
because it would run at an unpredictable point.

Then decide nothing about transactions; the runner reads what the file
already does:

| The file… | runs… |
|---|---|
| opens its own `BEGIN … COMMIT` | as written — the runner adds nothing |
| contains `ALTER TYPE … ADD VALUE` | statement by statement, no wrapper |
| neither | wrapped in one transaction by the runner |

Those two exceptions are not theoretical. Fourteen of the current files open
their own transaction, and adding `--single-transaction` on top produces
*"there is already a transaction in progress"*, after which the file's own
`COMMIT` closes the outer one early — migration 001 failed exactly that way.
And Postgres permits `ALTER TYPE … ADD VALUE` inside a transaction but
forbids *using* the new value until it commits, so migration 010 failed with
*"unsafe use of new value"* until it was run unwrapped.

Force the unwrapped path for any other reason with `-- migrate: no-transaction`
on a line of its own. `CREATE INDEX CONCURRENTLY` needs it.

**Still write migrations to be idempotent** (`IF NOT EXISTS`, `DROP
CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`). A file that manages its own
transaction, or that runs unwrapped, can fail with part of its work
committed — and the runner will not have recorded it, so the next run tries
again. Idempotence is what makes that retry safe rather than a second
problem.

## Deploying

Migrations do not run themselves on deploy, and that is deliberate: this
database holds a ledger, and a schema change should be a decision rather
than a consequence of a push. The order is

1. `npm run db:migrate:status` against production — see what is pending.
2. Take a backup (`docs/BACKUP.md`) and confirm the restore drill passes.
3. `npm run db:migrate`.
4. Deploy the code.

Backwards-compatible migrations first, in their own step, so the running
version keeps working between 3 and 4.
