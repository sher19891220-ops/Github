# Backing up the ledger

The ledger is the only thing here that cannot be rebuilt. Code is in git;
source documents are in Drive and in accounting's inbox; the *review
decisions* — which held rows an accountant cleared, which category they put
a repair under, which carrier they confirmed for an ambiguous unit — exist
only in the database they were made in.

So the database is the system of record, and it needs two independent
backups.

## Layer 1 — Render's own backups

Turn these on in the Render dashboard for `opsdash-db` and confirm the
retention it gives you on the current plan. They are the fastest path back
from an accidental `DELETE`, and they cost nothing to enable.

They are **not** sufficient on their own: they live in the same account as
the database. An account lockout, a billing lapse or a compromised login
takes the backup with the thing it was protecting.

## Layer 2 — the nightly dump (`opsdash-backup`)

A Render cron job, defined in the repo-root `render.yaml`, running
`scripts/backup-db.sh` at 08:00 UTC. It writes three files per night to
S3-compatible object storage **outside** the Render account:

| File | What it is |
|---|---|
| `<stamp>.dump` | `pg_dump` custom format, compressed |
| `<stamp>.manifest` | checksum, row counts, the ledger's total amount |
| `<stamp>.schema` | every constraint and index the database enforces |

The last two are what make the dump checkable. A restore that "succeeded"
having produced an empty ledger, or having lost the EXCLUDE constraints, is
a failure that a plain `pg_dump` cannot detect and this pairing can.

The job **refuses to run** without `BACKUP_S3_BUCKET` set. A backup job that
quietly writes into a container about to be destroyed reports success every
night while protecting nothing; that failure mode is worse than no job at
all.

After uploading, it downloads its own object back and compares checksums. A
truncated upload that returned 200 is a real thing and is cheap to rule out
here rather than during a recovery.

### Setting it up

Create a bucket with any S3-compatible provider (Cloudflare R2, Backblaze
B2, Wasabi and AWS S3 all work), make an access key scoped to that bucket
only, then set these on the `opsdash-backup` service in the Render
dashboard — **never in this repository, which is public:**

```
BACKUP_S3_BUCKET        your-bucket-name
BACKUP_S3_PREFIX        opsdash            (optional)
BACKUP_S3_ENDPOINT      https://...        (only for non-AWS providers)
AWS_ACCESS_KEY_ID       ...
AWS_SECRET_ACCESS_KEY   ...
AWS_DEFAULT_REGION      us-east-1
BACKUP_RETAIN_DAYS      90
```

Give the key `PutObject`, `GetObject`, `ListBucket` and `DeleteObject` on
that bucket and nothing else. `GetObject` is needed for the read-back check
and `DeleteObject` for pruning.

Turn on **object versioning** on the bucket if the provider offers it. It is
the difference between a compromised backup key being able to delete your
history and being able to add to it.

## The part that is still on you: the drill

A dump nobody has restored is a file, not a backup, and you find out which
one you have at the worst possible moment. Run this monthly, against any
machine with PostgreSQL installed:

```bash
export DATABASE_URL=postgresql://localhost/scratch   # any server; the drill
                                                     # makes its own database
npm run db:restore-drill -- s3://your-bucket/opsdash/20260914T080000Z.dump
```

It restores into a throwaway database beside the one you pointed at — never
over it — and checks four things:

1. The dump's bytes match the checksum recorded when it was written.
2. `pg_restore` completes with no errors.
3. Every table's row count matches the manifest, and **the ledger's total
   amount matches to the cent**. A count barely moves if one entry of
   thousands is lost; the total does.
4. Every constraint and index the source enforced is present, with the four
   EXCLUDE constraints named individually — those are what stop a truck
   belonging to two carriers on one day and a rate having two values.

Any failure prints a diff and exits non-zero. It has been mutation-tested:
a flipped byte, a wrong row count, a one-cent discrepancy and a missing
EXCLUDE constraint each make it fail.

## Restoring for real

```bash
# 1. Prove the backup first. Never restore over live data on faith.
npm run db:restore-drill -- s3://bucket/opsdash/<stamp>.dump

# 2. Restore into a new database, then repoint DATABASE_URL at it.
#    Restoring over the damaged one destroys the evidence of what happened.
createdb opsdash_restored
pg_restore --dbname=.../opsdash_restored --no-owner --no-privileges \
           --exit-on-error <stamp>.dump
```

Repointing rather than overwriting matters twice: the broken database is the
only record of how it broke, and if the restore turns out to be wrong you
still have somewhere to go back to.

## What this does not cover

Uploaded source documents in blob storage are backed up by whatever holds
them, not by this job. They are re-uploadable from Drive and from
accounting's mail, so they are a slower loss, not a permanent one — but if
blob storage ever becomes the only copy of a vendor statement, that changes
and this file needs a second section.
