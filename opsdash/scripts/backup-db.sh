#!/usr/bin/env bash
# Nightly dump of the ledger, with a manifest that makes the restore
# checkable.
#
# The dump alone is not the deliverable. A dump nobody has restored is a
# file, not a backup, and the way you find out which one you have is at the
# worst possible moment. So this writes two things:
#
#   <stamp>.dump      pg_dump custom format — compressed, restorable
#                     selectively, the format pg_restore actually wants
#   <stamp>.manifest  sha256 of the dump, plus a row count for every table
#                     that holds money or the dimensions money resolves
#                     through
#
# `restore-drill.sh` restores the first and checks it against the second.
# That pairing is the whole point: a restore that "succeeded" but came back
# with 0 ledger entries has not succeeded.
#
#   scripts/backup-db.sh [--local-only]
#
# Environment:
#   DATABASE_URL           required — what to dump
#   BACKUP_DIR             where to write locally (default ./backups)
#   BACKUP_S3_BUCKET       upload target; without it, --local-only is required
#   BACKUP_S3_PREFIX       key prefix (default opsdash)
#   BACKUP_S3_ENDPOINT     for S3-compatible storage (R2, B2, Wasabi, MinIO)
#   BACKUP_RETAIN_DAYS     prune uploads older than this (default 90)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set — there is nothing to back up without it}"
LOCAL_ONLY=0
[[ "${1:-}" == "--local-only" ]] && LOCAL_ONLY=1

BACKUP_DIR="${BACKUP_DIR:-./backups}"
PREFIX="${BACKUP_S3_PREFIX:-opsdash}"
RETAIN="${BACKUP_RETAIN_DAYS:-90}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_DIR/$STAMP.dump"
MANIFEST="$BACKUP_DIR/$STAMP.manifest"
SCHEMA="$BACKUP_DIR/$STAMP.schema"

# Refuse silence. A backup job that finds no destination and writes a file
# into a container's ephemeral filesystem has done nothing, and will report
# success every night while doing it.
if [[ $LOCAL_ONLY -eq 0 && -z "${BACKUP_S3_BUCKET:-}" ]]; then
  echo "backup-db: BACKUP_S3_BUCKET is not set, so this dump would go nowhere." >&2
  echo "           Set it, or pass --local-only if you really mean a local file." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# --no-owner/--no-privileges: the restore target is a scratch database owned
# by whoever is restoring, not by the production role. Without these a drill
# fails on role grants that have nothing to do with whether the data is
# intact.
echo "backup-db: dumping..."
pg_dump "$DATABASE_URL" \
  --format=custom --compress=9 --no-owner --no-privileges \
  --file="$DUMP"

SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
BYTES="$(stat -c %s "$DUMP")"

# The tables worth counting: every one that holds money, and every dimension
# a money row resolves through. If one of these comes back short, the restore
# is wrong even if pg_restore exited 0.
COUNTED=(
  accounting.ledger_entry
  accounting.staging_row
  accounting.source_document
  accounting.entity
  accounting.truck
  accounting.truck_entity_history
  accounting.fixed_cost_rate
  accounting.source_key_map
)

# The rule inventory: every constraint and index the schema enforces.
#
# Row counts prove the DATA came back. They say nothing about whether the
# RULES came back, and those are the half that stops tomorrow's bad write.
# A dump restored without `truck_entity_history_never_overlaps` would pass
# every count above and then quietly accept a truck belonging to two
# carriers on the same day.
#
# Written as a sorted list rather than only a hash, so a mismatch can be
# diffed instead of merely announced.
psql "$DATABASE_URL" -tAF' ' --quiet -c "
  SELECT 'constraint', c.conrelid::regclass::text, c.conname, c.contype
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE n.nspname IN ('accounting','public')
  UNION ALL
  SELECT 'index', schemaname || '.' || tablename, indexname, ''
    FROM pg_indexes WHERE schemaname IN ('accounting','public')
  ORDER BY 1,2,3;" | sed 's/[[:space:]]*$//' > "$SCHEMA"

SCHEMA_SHA="$(sha256sum "$SCHEMA" | cut -d' ' -f1)"
SCHEMA_N="$(wc -l < "$SCHEMA" | tr -d ' ')"

{
  echo "# opsdash backup manifest"
  echo "created_utc=$STAMP"
  echo "dump_file=$(basename "$DUMP")"
  echo "dump_sha256=$SHA"
  echo "dump_bytes=$BYTES"
  echo "schema_file=$(basename "$SCHEMA")"
  echo "schema_sha256=$SCHEMA_SHA"
  echo "schema_objects=$SCHEMA_N"
  echo "pg_dump_version=$(pg_dump --version | awk '{print $3}')"
  echo "server_version=$(psql "$DATABASE_URL" -tAc 'show server_version;')"
  for t in "${COUNTED[@]}"; do
    n="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM $t;" 2>/dev/null || echo 'ERR')"
    echo "rows.$t=$n"
  done
  # Not a row count but the number that matters most: does the money add up
  # to what it added up to. A restore that loses one entry of many thousands
  # would not move a count much; it moves this.
  echo "sum.ledger_amount=$(psql "$DATABASE_URL" -tAc \
    "SELECT COALESCE(sum(amount),0)::text FROM accounting.ledger_entry;" 2>/dev/null || echo 'ERR')"
} > "$MANIFEST"

echo "backup-db: $DUMP"
echo "           $BYTES bytes, sha256 ${SHA:0:16}..."
echo "           $SCHEMA_N constraints and indexes recorded"
grep -E '^rows\.|^sum\.' "$MANIFEST" | sed 's/^/           /'

if [[ $LOCAL_ONLY -eq 1 ]]; then
  echo "backup-db: local only — not uploaded."
  exit 0
fi

S3=(aws s3)
[[ -n "${BACKUP_S3_ENDPOINT:-}" ]] && S3=(aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3)
DEST="s3://$BACKUP_S3_BUCKET/$PREFIX"

echo "backup-db: uploading to $DEST/"
"${S3[@]}" cp "$DUMP" "$DEST/$(basename "$DUMP")"
"${S3[@]}" cp "$MANIFEST" "$DEST/$(basename "$MANIFEST")"
"${S3[@]}" cp "$SCHEMA" "$DEST/$(basename "$SCHEMA")"

# Read it back and compare hashes. An upload that reported success and
# stored a truncated object is a real failure mode, and it is cheap to rule
# out here rather than discover during a restore.
echo "backup-db: verifying the uploaded copy..."
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
"${S3[@]}" cp "$DEST/$(basename "$DUMP")" "$TMP" --quiet
REMOTE_SHA="$(sha256sum "$TMP" | cut -d' ' -f1)"
if [[ "$REMOTE_SHA" != "$SHA" ]]; then
  echo "backup-db: FAILED — the uploaded copy does not match what was dumped." >&2
  echo "           local  $SHA" >&2
  echo "           remote $REMOTE_SHA" >&2
  exit 1
fi
echo "backup-db: uploaded copy matches."

CUTOFF="$(date -u -d "$RETAIN days ago" +%Y%m%d)"
echo "backup-db: pruning anything older than $CUTOFF ($RETAIN days)"
"${S3[@]}" ls "$DEST/" | awk '{print $4}' | grep -E '^[0-9]{8}T[0-9]{6}Z\.(dump|manifest|schema)$' | while read -r key; do
  if [[ "${key:0:8}" < "$CUTOFF" ]]; then
    "${S3[@]}" rm "$DEST/$key"
  fi
done

echo "backup-db: done."
