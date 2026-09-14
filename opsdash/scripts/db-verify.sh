#!/usr/bin/env bash
# Applies every migration to a throwaway database and runs the contract
# assertions against it. Touches no real database.
#
# Exists because a migration that has only been read is not a migration that
# works, and the assertions are what make the acceptance criteria enforced
# rather than merely intended.
#
# Two ways to get a database to verify against:
#
#   VERIFY_DATABASE_URL set  — make a scratch database on that server.
#   otherwise                — initdb a throwaway cluster locally.
#
# The second needs root, because postgres refuses to run as root and the
# script has to `su postgres`. CI runners and containers usually have a
# PostgreSQL server available but no way to become another user, so there
# the check used to skip itself and exit 0. A verification step that skips
# itself is worse than no step at all: it reports green.
#
# VERIFY_DATABASE_URL must be set EXPLICITLY and is never inherited from
# DATABASE_URL. This script creates and drops databases, and the day it
# picks that up from a production environment is the day it drops something
# that matters.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PSQL=""
VERIFY_URL=""

run_verification() {
  # Through the same runner a deploy uses, not a private loop. Two ways of
  # applying migrations means one of them is eventually wrong, and this is
  # the check whose whole job is to notice that.
  echo "db-verify: applying migrations..."
  if ! DATABASE_URL="$VERIFY_URL" npx tsx "$ROOT/scripts/migrate.ts"; then
    echo "db-verify: FAILED applying migrations" >&2
    exit 1
  fi

  echo "db-verify: running contract assertions..."
  # Captured without `set -e` aborting: a failed assertion run must be
  # REPORTED, not swallowed. An earlier version exited silently here, which
  # is the worst possible behaviour for a gate — it looked like nothing was
  # wrong.
  set +e
  OUT="$($PSQL -f "$ROOT/db/verify/002_contract_assertions.sql" 2>&1)"; ARC=$?
  set -e
  echo "$OUT" | grep -E '^(NOTICE|psql).*(PASS|FAIL)|PASS:|FAIL:' | sed -E 's/^.*(PASS|FAIL)/  \1/' || true

  if [[ $ARC -ne 0 ]] || echo "$OUT" | grep -q 'FAIL'; then
    echo "db-verify: FAILED — the schema does not enforce what the contract claims." >&2
    echo "$OUT" >&2
    exit 1
  fi

  PASSES=$(echo "$OUT" | grep -c 'PASS' || true)
  echo "db-verify: OK — $PASSES assertions passed."
}

# ---------------------------------------------------------------- remote --
if [[ -n "${VERIFY_DATABASE_URL:-}" ]]; then
  SERVER="${VERIFY_DATABASE_URL%/*}"
  SCRATCH="aiops_verify_$$"
  cleanup_remote() {
    psql "$SERVER/postgres" -qc "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null 2>&1 || true
  }
  trap cleanup_remote EXIT

  psql "$SERVER/postgres" -qc "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null
  psql "$SERVER/postgres" -qc "CREATE DATABASE $SCRATCH;" >/dev/null
  PSQL="psql $SERVER/$SCRATCH -v ON_ERROR_STOP=1 --quiet"
  VERIFY_URL="$SERVER/$SCRATCH"

  echo "db-verify: verifying against a scratch database on the supplied server"
  run_verification
  exit 0
fi

# ----------------------------------------------------------------- local --
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [[ -z "$PGBIN" ]]; then
  echo "db-verify: no PostgreSQL server binaries found and VERIFY_DATABASE_URL is unset." >&2
  echo "           This check cannot run, and reporting it as passed would be worse." >&2
  echo "           Install postgresql, or set VERIFY_DATABASE_URL to a server it may" >&2
  echo "           create a scratch database on." >&2
  exit 1
fi

# postgres refuses to run as root and cannot traverse the agent scratch
# dirs, so the cluster lives somewhere it can actually reach.
DATADIR="${OPSDASH_PGTMP:-/var/lib/opsdash-pgverify}"
PORT="${OPSDASH_PGPORT:-5433}"
id postgres >/dev/null 2>&1 || useradd -r -s /bin/bash postgres

cleanup_local() {
  su postgres -c "$PGBIN/pg_ctl -D $DATADIR/data -m immediate -w stop" >/dev/null 2>&1 || true
  rm -rf "$DATADIR"
}
trap cleanup_local EXIT

rm -rf "$DATADIR"
mkdir -p "$DATADIR/data" "$DATADIR/run"
chown -R postgres "$DATADIR"
chmod 750 "$DATADIR"

su postgres -c "$PGBIN/initdb -D $DATADIR/data -U postgres -A trust" >/dev/null
su postgres -c "$PGBIN/pg_ctl -D $DATADIR/data \
  -o '-k $DATADIR/run -p $PORT -h 127.0.0.1' -l $DATADIR/pg.log -w start" >/dev/null

psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 --quiet \
     -c "CREATE DATABASE aiops_verify;" >/dev/null
PSQL="psql -h 127.0.0.1 -p $PORT -U postgres -d aiops_verify -v ON_ERROR_STOP=1 --quiet"
VERIFY_URL="postgresql://postgres@127.0.0.1:$PORT/aiops_verify"

run_verification
