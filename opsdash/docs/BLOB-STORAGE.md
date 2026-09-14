# Where uploaded documents live

Every posted number in this system is supposed to trace back to the file it
came from. That is the claim the dashboard makes and the reason accounting
can defend a figure to a lender, a factor or the IRS.

For a while the claim was only half true. `source_document` recorded the
file name, its sha256 and a storage key, and all of that survived — but the
bytes were written to the container's temp directory, which the platform
wipes on every deploy and does not share between instances. The row pointed
at a file that no longer existed. Uploads reported success; the drill-down
worked until the next release.

Documents now go to S3-compatible object storage, and in production the app
**refuses to start healthy without it.**

## The refusal

If `BLOB_S3_BUCKET` is unset in production, `/api/health` returns 503 with
the reason. The platform's health check fails, the deploy rolls back, and
the logs say exactly what is missing.

That is deliberate. The alternative — falling back to local disk — is what
caused the problem in the first place: a year of uploads that all appear to
have worked and none of which can be produced.

Override with `OPSDASH_ALLOW_LOCAL_BLOBS=1` only if you genuinely accept
losing every document on the next deploy. Outside production, local disk is
the default and needs no configuration.

## Setting it up

Use the same provider as the nightly backup, in a **separate bucket or at
least a separate prefix**. Documents and backups have different lifetimes:
a lifecycle rule that expires backups after 90 days must never reach the
documents those backups refer to.

| Variable | Value |
|---|---|
| `BLOB_S3_BUCKET` | the bucket name |
| `BLOB_S3_PREFIX` | `documents` (default) |
| `BLOB_S3_ENDPOINT` | only for non-AWS: R2, B2, Wasabi, MinIO |
| `BLOB_S3_REGION` | `auto` for R2; the real region for AWS |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | key scoped to that bucket |

The key needs `PutObject`, `GetObject` and `HeadObject`. It does **not**
need `DeleteObject` — nothing in this app ever deletes a document, and a key
that cannot delete is a key that cannot be used to destroy your evidence.

Turn on object versioning and, if the provider offers it, object lock. These
files are the audit trail.

### Checking it from outside

```
GET /api/health          → configuration only, no round trip
GET /api/health?deep=1   → actually touches the store
```

`deep=1` returns `blobStoreReachable` and the bucket it resolved to. Use it
once after a deploy; it is not for the health-check loop.

## Keys are content addresses

A document's storage key is `<sha256>.bin` and nothing else. Consequences
worth knowing:

- Uploading the same statement twice stores one object and creates one
  document. The second upload comes back with `duplicateOf` set.
- A key can be recomputed from the hash on the `source_document` row, so a
  storage key is never the only record of where something is.
- A filename never becomes a path. Filenames come from outside; the only
  thing that reaches the object store is a hex digest.

## Documents already lost

Anything uploaded before this change is gone from disk. The rows are not
wrong — the entries are still valid and still name a file with a known
checksum — but the file has to come back from whoever sent it.

```bash
npm run blobs:check
```

Lists every document with no stored copy, with its date, type, filename,
how many ledger entries depend on it, and its sha256. Exits non-zero if any
are missing, so it can be a scheduled check rather than something somebody
remembers to run.

Re-uploading the identical file restores the copy **without** creating a
second document — the upload path dedupes on the sha256 already on record.
If the re-uploaded file has a different hash, it is a different file, and
that is worth knowing too.

## What this does not do

Presigned URLs. Documents are served through `/api/documents/:id/file`,
which means every retrieval passes the role check in the middleware and the
bytes never become reachable by anyone holding a link. For a 300MB scan
that would be worth revisiting; for statements and invoices it is not.
