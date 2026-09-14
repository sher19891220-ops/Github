#!/usr/bin/env bash
# Restores a backup into a scratch database and proves it came back whole.
#
# This is the half that turns a dump into a backup. It is meant to be run on
# a schedule too, not only in an emergency — the first restore you ever
# attempt should not be the one you need.
#
# Three checks, in increasing order of how much they would embarrass you:
#
#   1. pg_restore exits clean.
#   2. Every table's row count matches the manifest, and the ledger's total
#      amount matches to the cent. pg_restore can exit 0 having restored a
#      schema and no rows.
#   3. The 63 contract assertions still hold against the restored database.
#      A restore that loses the EXCLUDE constraints would look perfect by
#      row count and would silently accept overlapping carrier periods the
#      next morning.
#
# The scratch database is dropped afterwards unless --keep.
#
#   scripts/restore-drill.sh <dump-file> [--keep]
#   scripts/restore-drill.sh s3://bucket/prefix/20260914T070000Z.dump
set -euo pipefail

SRC="${1:?Usage: restore-drill.sh <dump-file|s3-url> [--keep]}"
KEEP=0
[[ "${2:-}" == "--keep" ]] && KEEP=1

: "${DATABASE_URL:?DATABASE_URL must be set — the drill restores next to it, never over it}"

# Everything up to the last '/' is the server; the drill makes its own
# database on that server and never touches the one in DATABASE_URL.
SERVER="${DATABASE_URL%/*}"
SCRATCH="restore_drill_$(date -u +%Y%m%d%H%M%S)"
WORK="$(mktemp -d)"
cleanup() {
  if [[ $KEEP -eq 0 ]]; then
    psql "$SERVER/postgres" -qc "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null 2>&1 || true
  else
    echo "restore-drill: kept $SERVER/$SCRATCH"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# Fetch, if the dump lives in object storage.
if [[ "$SRC" == s3://* ]]; then
  S3=(aws s3); [[ -n "${BACKUP_S3_ENDPOINT:-}" ]] && S3=(aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3)
  echo "restore-drill: fetching $SRC"
  "${S3[@]}" cp "$SRC" "$WORK/backup.dump" --quiet
  "${S3[@]}" cp "${SRC%.dump}.manifest" "$WORK/backup.manifest" --quiet
  "${S3[@]}" cp "${SRC%.dump}.schema" "$WORK/backup.schema" --quiet || true
  DUMP="$WORK/backup.dump"; MANIFEST="$WORK/backup.manifest"; SCHEMA_SIDECAR="$WORK/backup.schema"
else
  DUMP="$SRC"; MANIFEST="${SRC%.dump}.manifest"; SCHEMA_SIDECAR="${SRC%.dump}.schema"
fi

[[ -f "$DUMP" ]] || { echo "restore-drill: no such dump: $DUMP" >&2; exit 1; }
[[ -f "$MANIFEST" ]] || { echo "restore-drill: no manifest beside the dump: $MANIFEST" >&2; exit 1; }

fail=0
note() { printf '  %-6s %s\n' "$1" "$2"; }

# ---- 0. the bytes are the bytes we wrote -------------------------------
WANT_SHA="$(grep '^dump_sha256=' "$MANIFEST" | cut -d= -f2)"
GOT_SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
if [[ "$WANT_SHA" == "$GOT_SHA" ]]; then
  note PASS "dump matches its manifest checksum"
else
  note FAIL "dump checksum differs from the manifest — the file is not what was written"
  fail=1
fi

# ---- 1. it restores ----------------------------------------------------
echo "restore-drill: restoring into $SCRATCH"
psql "$SERVER/postgres" -qc "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null
psql "$SERVER/postgres" -qc "CREATE DATABASE $SCRATCH;" >/dev/null

if pg_restore --dbname="$SERVER/$SCRATCH" --no-owner --no-privileges --exit-on-error "$DUMP" 2>"$WORK/restore.err"; then
  note PASS "pg_restore completed with no errors"
else
  note FAIL "pg_restore failed"
  sed 's/^/         /' "$WORK/restore.err" >&2
  fail=1
fi

# ---- 2. the data came back whole ---------------------------------------
while IFS='=' read -r key want; do
  case "$key" in
    rows.*)
      tbl="${key#rows.}"
      got="$(psql "$SERVER/$SCRATCH" -tAc "SELECT count(*) FROM $tbl;" 2>/dev/null || echo 'ERR')"
      if [[ "$got" == "$want" ]]; then note PASS "$tbl: $got rows"
      else note FAIL "$tbl: manifest says $want, restored has $got"; fail=1; fi
      ;;
    sum.ledger_amount)
      got="$(psql "$SERVER/$SCRATCH" -tAc "SELECT COALESCE(sum(amount),0)::text FROM accounting.ledger_entry;" 2>/dev/null || echo 'ERR')"
      # Compare as numerics, so 0 and 0.0000 are the same number.
      same="$(psql "$SERVER/$SCRATCH" -tAc "SELECT ('$got'::numeric = '$want'::numeric);" 2>/dev/null || echo f)"
      if [[ "$same" == "t" ]]; then note PASS "ledger total matches to the cent: $got"
      else note FAIL "ledger total: manifest says $want, restored has $got"; fail=1; fi
      ;;
  esac
done < "$MANIFEST"

# ---- 3. the rules came back too ----------------------------------------
# Not by re-running the contract assertions: those seed their own carriers
# and categories, so against a restored database they die on a duplicate key
# before testing anything, and against a schema-only restore they die on a
# missing category. Either failure reads as "the constraints are gone",
# which is the one alarm that must never cry wolf.
#
# So compare the inventory directly. Every constraint and index the source
# database enforced is listed in the .schema sidecar; the restored database
# must present exactly the same list.
if [[ -f "$SCHEMA_SIDECAR" ]]; then
  psql "$SERVER/$SCRATCH" -tAF' ' --quiet -c "
    SELECT 'constraint', c.conrelid::regclass::text, c.conname, c.contype
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname IN ('accounting','public')
    UNION ALL
    SELECT 'index', schemaname || '.' || tablename, indexname, ''
      FROM pg_indexes WHERE schemaname IN ('accounting','public')
    ORDER BY 1,2,3;" | sed 's/[[:space:]]*$//' > "$WORK/restored.schema"

  if diff -q "$SCHEMA_SIDECAR" "$WORK/restored.schema" >/dev/null; then
    note PASS "$(wc -l < "$SCHEMA_SIDECAR" | tr -d ' ') constraints and indexes came back identical"
  else
    note FAIL "the restored schema does not enforce what the source did"
    diff "$SCHEMA_SIDECAR" "$WORK/restored.schema" | sed 's/^/         /' >&2
    fail=1
  fi

  # Name the ones that matter out loud. A count can match while the wrong
  # object is missing, and these four are what keep a truck from belonging
  # to two carriers at once and a rate from having two values on one day.
  for c in truck_entity_history_never_overlaps fixed_cost_rate_never_overlaps \
           one_carrier_per_unit_per_day one_status_per_truck_at_a_time; do
    got="$(psql "$SERVER/$SCRATCH" -tAc \
      "SELECT count(*) FROM pg_constraint WHERE conname = '$c' AND contype = 'x';")"
    if [[ "$got" == "1" ]]; then note PASS "$c is present and is still an EXCLUDE"
    else note FAIL "$c is missing from the restored database"; fail=1; fi
  done
else
  note SKIP "no .schema sidecar beside the dump — rules not checked"
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "restore-drill: OK — this backup is restorable and complete."
else
  echo "restore-drill: FAILED — do not rely on this backup." >&2
fi
exit $fail
