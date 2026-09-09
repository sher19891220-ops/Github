#!/usr/bin/env bash
# Applies the accounting migration to a throwaway PostgreSQL cluster and runs
# the contract assertions against it. Touches no real database.
#
# Exists because a migration that has only been read is not a migration that
# works, and the assertions are what make CLAUDE.md §8's acceptance criteria
# enforced rather than merely intended.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [[ -z "$PGBIN" ]]; then
  echo "db-verify: no PostgreSQL server binaries found; skipping." >&2
  echo "           install postgresql to run this check." >&2
  exit 0
fi

# postgres refuses to run as root and cannot traverse the agent scratch dirs,
# so the cluster lives somewhere it can actually reach.
DATADIR="${OPSDASH_PGTMP:-/var/lib/opsdash-pgverify}"
PORT="${OPSDASH_PGPORT:-5433}"
id postgres >/dev/null 2>&1 || useradd -r -s /bin/bash postgres

cleanup() {
  su postgres -c "$PGBIN/pg_ctl -D $DATADIR/data -m immediate -w stop" >/dev/null 2>&1 || true
  rm -rf "$DATADIR"
}
trap cleanup EXIT

rm -rf "$DATADIR"
mkdir -p "$DATADIR/data" "$DATADIR/run"
chown -R postgres "$DATADIR"
chmod 750 "$DATADIR"

su postgres -c "$PGBIN/initdb -D $DATADIR/data -U postgres -A trust" >/dev/null
su postgres -c "$PGBIN/pg_ctl -D $DATADIR/data \
  -o '-k $DATADIR/run -p $PORT -h 127.0.0.1' -l $DATADIR/pg.log -w start" >/dev/null

PSQL="psql -h 127.0.0.1 -p $PORT -U postgres -v ON_ERROR_STOP=1 --quiet"
$PSQL -c "CREATE DATABASE aiops_verify;" >/dev/null

echo "db-verify: applying migrations..."
for m in "$ROOT"/db/migrations/*.sql; do
  echo "  $(basename "$m")"
  set +e
  MOUT="$($PSQL -d aiops_verify -f "$m" 2>&1)"; MRC=$?
  set -e
  if [[ $MRC -ne 0 ]]; then
    echo "db-verify: FAILED applying $(basename "$m")" >&2
    echo "$MOUT" >&2
    exit 1
  fi
done

echo "db-verify: running contract assertions..."
# Captured without `set -e` aborting: a failed assertion run must be REPORTED,
# not swallowed. An earlier version exited silently here, which is the worst
# possible behaviour for a gate — it looked like nothing was wrong.
set +e
OUT="$($PSQL -d aiops_verify -f "$ROOT/db/verify/002_contract_assertions.sql" 2>&1)"; ARC=$?
set -e
echo "$OUT" | grep -E '^(NOTICE|psql).*(PASS|FAIL)|PASS:|FAIL:' | sed -E 's/^.*(PASS|FAIL)/  \1/' || true

if [[ $ARC -ne 0 ]] || echo "$OUT" | grep -q 'FAIL'; then
  echo "db-verify: FAILED — the schema does not enforce what the contract claims." >&2
  echo "$OUT" >&2
  exit 1
fi

PASSES=$(echo "$OUT" | grep -c 'PASS' || true)
echo "db-verify: OK — $PASSES assertions passed."
