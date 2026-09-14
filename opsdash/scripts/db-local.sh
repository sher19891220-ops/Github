#!/usr/bin/env bash
# Starts a local PostgreSQL for development and applies every migration.
# Prints the DATABASE_URL to export. Not for production; production points
# DATABASE_URL at a real database and runs the same migrations.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
D="${OPSDASH_DEV_PGDIR:-/var/lib/opsdash-dev}"
PORT="${OPSDASH_DEV_PGPORT:-5460}"

id postgres >/dev/null 2>&1 || useradd -r -s /bin/bash postgres

if ! su postgres -c "$PGBIN/pg_ctl -D $D/data status" >/dev/null 2>&1; then
  rm -rf "$D"; mkdir -p "$D/data" "$D/run"; chown -R postgres "$D"; chmod 750 "$D"
  su postgres -c "$PGBIN/initdb -D $D/data -U postgres -A trust" >/dev/null
  su postgres -c "$PGBIN/pg_ctl -D $D/data \
    -o '-k $D/run -p $PORT -h 127.0.0.1' -l $D/pg.log -w start" >/dev/null
  psql -h 127.0.0.1 -p "$PORT" -U postgres -qc "CREATE DATABASE opsdash;" >/dev/null
fi

URL="postgresql://postgres@127.0.0.1:$PORT/opsdash"

# This used to be a loop over the directory ending in `|| true`, which meant
# a migration that FAILED was skipped and the script still printed a URL as
# though the database were ready. The runner records what it applied, refuses
# to continue on drift, and fails loudly — and its output goes to stderr so
# this script still prints nothing but the URL on stdout.
DATABASE_URL="$URL" npx tsx "$ROOT/scripts/migrate.ts" >&2

echo "$URL"
