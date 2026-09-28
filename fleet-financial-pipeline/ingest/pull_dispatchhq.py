"""Read-only access to the DispatchHQ Postgres database (via Supabase's pooler).

WHAT THIS IS, AND WHAT IT IS NOT. DispatchHQ is a live dispatch/roster
database -- NOT a replacement for Samsara or Motive mileage, and this module
must never be used as one. Operator instruction 2026-09-28: do not replace
the Samsara upload path for non-Motive trucks with this source. What it MAY
add: per-load dispatch detail, driver roster, and truck/driver assignment
history this pipeline cannot currently get from the P&L alone -- see
docs/FINDINGS.md once a real query against it has been run and something is
actually learned from it. Until then, everything about its content below the
six table names is a NAME-BASED GUESS, not a confirmed schema.

THE SIX TABLES NAMED BY THE OPERATOR, 2026-09-28 (unverified until queried):
    load_entries          dispatcher_history
    drivers                sub_truck_periods
    weeks                  hidden_week_periods

CONNECTION IS `board_viewer` -- READ ONLY, AND THIS MODULE ENFORCES IT TOO.
Even though the role itself should already refuse writes, run_query() below
refuses to send anything but a SELECT, as a second, independent guard: a
credential mix-up or a future caller passing the wrong string must not be
the only thing standing between this pipeline and a write to someone else's
production dispatch database.

THE CREDENTIAL LIVES IN AN ENVIRONMENT VARIABLE, NOT A FILE, same reasoning
as pull_sheets.py and pull_relay_fuel.py -- this container is ephemeral and a
key on disk has to be re-uploaded every time a reclaim happens.

    DISPATCHHQ_DATABASE_URL   the full board_viewer pooler connection string

A file at config/dispatchhq_credentials.json (gitignored, see
config/dispatchhq_credentials.example.json for the shape) still works as a
local fallback for a machine that is not this container.

NETWORK: the pooler is reached over a raw Postgres connection (port 6543 or
5432), not HTTPS -- this environment's outbound network policy has to allow
that host specifically, which is a separate setting from what lets HTTPS
proxy calls (Relay, Sheets, Drive) through. probe_reachability() checks this
without ever touching the credential, so a network problem and a bad
credential never look like the same failure.

    python3 ingest/pull_dispatchhq.py --check-network   # reachability only
    python3 ingest/pull_dispatchhq.py --whoami           # proves the credential works
    python3 ingest/pull_dispatchhq.py --tables           # what board_viewer can see
    python3 ingest/pull_dispatchhq.py --describe load_entries
"""
import argparse
import json
import os
import socket
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_VAR = "DISPATCHHQ_DATABASE_URL"
CREDS = ROOT / "config/dispatchhq_credentials.json"

POOLER_HOSTS = [
    ("aws-0-us-east-1.pooler.supabase.com", 6543),
    ("aws-0-us-east-1.pooler.supabase.com", 5432),
]

KNOWN_TABLES = ("load_entries", "drivers", "weeks", "dispatcher_history",
                "sub_truck_periods", "hidden_week_periods")


def probe_reachability(hosts=POOLER_HOSTS, timeout=5):
    """Raw TCP reachability, no credential involved -- so a network-policy
    block and a bad connection string never get confused for each other."""
    out = []
    for host, port in hosts:
        try:
            s = socket.create_connection((host, port), timeout=timeout)
            s.close()
            out.append((host, port, True, None))
        except Exception as exc:
            out.append((host, port, False, str(exc)))
    return out


def read_credentials():
    """The connection string, from the environment first and a file second.
    Never returned alongside anything that gets printed by this module's own
    CLI -- callers that print diagnostics must not include this value."""
    url = os.environ.get(ENV_VAR, "").strip()
    if url:
        return url, f"${ENV_VAR}"

    if not CREDS.exists():
        # relative_to() RAISES when CREDS is not under ROOT (e.g. a test's
        # tmp_path) -- building this message the obvious way would crash the
        # error message itself and hide the real problem. Same fix as
        # pull_sheets.read_credentials().
        try:
            where_file = CREDS.relative_to(ROOT)
        except ValueError:
            where_file = CREDS
        raise SystemExit(
            f"No DispatchHQ connection string: ${ENV_VAR} is unset and there "
            f"is no file at {where_file}.\n"
            f"Set ${ENV_VAR} in this environment's own settings (see this "
            f"module's docstring), or copy "
            f"config/dispatchhq_credentials.example.json to "
            f"{CREDS.name} and fill in a real board_viewer pooler string.")
    try:
        info = json.loads(CREDS.read_text())
    except json.JSONDecodeError as e:
        raise SystemExit(f"{CREDS} is not valid JSON ({e}). No credential printed.")
    url = (info.get("database_url") or "").strip()
    if not url:
        raise SystemExit(f'{CREDS} has no non-empty "database_url" field.')
    return url, str(CREDS)


def connect():
    import psycopg2
    url, _ = read_credentials()
    return psycopg2.connect(url, connect_timeout=10)


def run_query(cur, sql, params=None):
    """The one guard against this module ever writing to DispatchHQ, on top
    of board_viewer's own read-only grant. Not a full SQL parser -- just
    enough to catch an obviously wrong query before it reaches the wire."""
    if not sql.strip().lower().startswith(("select", "with")):
        raise ValueError(f"refusing a non-SELECT query against a read-only "
                         f"source: {sql[:80]!r}")
    cur.execute(sql, params)
    return cur.fetchall()


def whoami():
    with connect() as conn:
        with conn.cursor() as cur:
            rows = run_query(cur, "SELECT current_user, current_database(), NOW();")
    return rows[0]


def list_tables():
    with connect() as conn:
        with conn.cursor() as cur:
            rows = run_query(cur, """
                SELECT table_schema, table_name
                FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                ORDER BY table_schema, table_name;
            """)
    return rows


def describe(table):
    with connect() as conn:
        with conn.cursor() as cur:
            rows = run_query(cur, """
                SELECT column_name, data_type, is_nullable
                FROM information_schema.columns
                WHERE table_name = %s
                ORDER BY ordinal_position;
            """, (table,))
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check-network", action="store_true",
                    help="raw TCP reachability to the pooler, no credential needed")
    ap.add_argument("--whoami", action="store_true",
                    help="prove the credential works; prints user/db/time only")
    ap.add_argument("--tables", action="store_true",
                    help="list every table board_viewer can see")
    ap.add_argument("--describe", metavar="TABLE",
                    help="list a table's columns")
    a = ap.parse_args()

    if a.check_network:
        for host, port, ok, err in probe_reachability():
            print(f"  {host}:{port}  {'reachable' if ok else f'FAILED: {err}'}")
        return

    if a.whoami:
        user, db, now = whoami()
        _, where = read_credentials()
        print(f"  credential loaded from {where}")
        print(f"  connected as {user} to database {db!r} at {now}")
        return

    if a.tables:
        for schema, name in list_tables():
            flag = "  (named by operator)" if name in KNOWN_TABLES else ""
            print(f"  {schema}.{name}{flag}")
        return

    if a.describe:
        cols = describe(a.describe)
        if not cols:
            print(f"  no columns found for {a.describe!r} -- check the name "
                  f"against --tables")
            return
        for name, dtype, nullable in cols:
            print(f"  {name:<30}{dtype:<20}{'NULL' if nullable == 'YES' else 'NOT NULL'}")
        return

    ap.print_help()


if __name__ == "__main__":
    main()
