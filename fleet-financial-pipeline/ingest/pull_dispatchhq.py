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

HTTPS REST MODE (--rest), added 2026-09-28. The Claude Code cloud
environment's egress proxy carries HTTPS only -- it does not carry raw-TCP
Postgres at all (/root/.ccr/README.md), so the pooler path above can never
work from there, whatever the network setting. `--rest` runs the same
--whoami / --tables / --describe against Supabase's PostgREST API
(https://<project-ref>.supabase.co/rest/v1/) over 443 instead.

    DISPATCHHQ_SUPABASE_URL   https://<project-ref>.supabase.co
    DISPATCHHQ_SUPABASE_KEY   a key/JWT whose role can only SELECT

(or "supabase_url" / "supabase_key" in the same gitignored credentials file.)

    python3 ingest/pull_dispatchhq.py --rest --check-network
    python3 ingest/pull_dispatchhq.py --rest --whoami
    python3 ingest/pull_dispatchhq.py --rest --tables
    python3 ingest/pull_dispatchhq.py --rest --describe load_entries

READ-ONLY IS ENFORCED THREE WAYS IN THIS MODE, same principle as run_query():
  1. rest_request() refuses every HTTP method except GET and HEAD -- PostgREST
     writes are POST/PATCH/PUT/DELETE, so none can leave this module.
  2. A service_role JWT or an `sb_secret_...` key is REFUSED before any
     request is sent: those bypass row-level security and can write, and a
     read-only pull has no business holding one.
  3. Whatever the key's role is granted in the database itself.

WHICH KEY TO ISSUE -- THE OPERATOR'S DECISION, NOT THIS MODULE'S. PostgREST
does not log in as `board_viewer` by password; it takes the Postgres role
from the JWT's `role` claim. Two options, safer first:
  a. A JWT with `"role": "board_viewer"`, signed with the project's JWT
     secret -- keeps the exact grants board_viewer already has. Also needs
     `GRANT board_viewer TO authenticator;` so PostgREST may switch to it.
  b. The project's anon/publishable key plus SELECT grants/RLS policies for
     the `anon` role. CAUTION: if DispatchHQ's own web app ships that anon
     key to browsers, those grants make the tables (driver PII included)
     readable by anyone who opens the app's dev tools. Do not choose (b)
     unless the anon key is private to this pipeline.
Tables must also be in a schema PostgREST exposes (Settings -> API ->
Exposed schemas; `public` by default).

BOARD API MODE (--board), CONFIRMED LIVE 2026-09-28 -- the path that actually
works. A DispatchHQ-authored serverless function
(https://dispatchhq-opal.vercel.app/api/board-data) sits in front of
Supabase and answers all seven real tables over plain HTTPS with a single
`X-API-Key` header -- not PostgREST's `apikey`/`Authorization: Bearer`, and
not the six-table guess this module started with: there is a 7th,
`driver_row_order` (per-week UI sort order, no financial content). Real
schema per table, confirmed by sampling live data 2026-09-28 (see
CLAUDE.md's DispatchHQ section for the full field list and row counts) --
this replaces every earlier guess in this docstring's history.

    DISPATCHHQ_BOARD_KEY   the X-API-Key value (required; never defaulted)
    DISPATCHHQ_BOARD_URL   the endpoint (optional -- defaults to the URL
                           above; only the key is a secret)

(or "board_api_key" / "board_url" in the same gitignored credentials file.)

    python3 ingest/pull_dispatchhq.py --board --tables
    python3 ingest/pull_dispatchhq.py --board --describe load_entries
    python3 ingest/pull_dispatchhq.py --board --pull weeks --out /tmp/weeks.json

READ-ONLY BY CONSTRUCTION, not just by convention: this API exposes exactly
one verb (a GET with a `table` query parameter) and no write endpoint at
all, so unlike run_query()/rest_request() there is no method to police --
board_request() never builds anything but a GET.
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

REST_URL_VAR = "DISPATCHHQ_SUPABASE_URL"
REST_KEY_VAR = "DISPATCHHQ_SUPABASE_KEY"
REST_READ_METHODS = ("GET", "HEAD")

KNOWN_TABLES = ("load_entries", "drivers", "weeks", "dispatcher_history",
                "sub_truck_periods", "hidden_week_periods")

BOARD_URL_VAR = "DISPATCHHQ_BOARD_URL"
BOARD_KEY_VAR = "DISPATCHHQ_BOARD_KEY"
DEFAULT_BOARD_URL = "https://dispatchhq-opal.vercel.app/api/board-data"
BOARD_TABLES = KNOWN_TABLES + ("driver_row_order",)


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


# ---------------------------------------------------------------- REST mode

def _jwt_role(key):
    """The `role` claim of a JWT-shaped key, or None for a non-JWT key
    (e.g. `sb_publishable_...`). Reads the payload only -- no signature
    check is needed to decide what to REFUSE, and the role name is not
    secret."""
    import base64
    parts = key.split(".")
    if len(parts) != 3:
        return None
    try:
        pad = "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(parts[1] + pad)).get("role")
    except Exception:
        return None


def read_rest_credentials():
    """(base_url, key, where) for REST mode. Environment first, file second,
    same order as read_credentials(). Refuses keys that bypass RLS."""
    url = os.environ.get(REST_URL_VAR, "").strip()
    key = os.environ.get(REST_KEY_VAR, "").strip()
    where = f"${REST_URL_VAR} / ${REST_KEY_VAR}"
    if not (url and key) and CREDS.exists():
        try:
            info = json.loads(CREDS.read_text())
        except json.JSONDecodeError as e:
            raise SystemExit(f"{CREDS} is not valid JSON ({e}). No credential printed.")
        url = url or (info.get("supabase_url") or "").strip()
        key = key or (info.get("supabase_key") or "").strip()
        where = str(CREDS)
    missing = [n for n, v in ((REST_URL_VAR, url), (REST_KEY_VAR, key)) if not v]
    if missing:
        raise SystemExit(
            f"REST mode needs {' and '.join('$' + m for m in missing)} (or "
            f'"supabase_url" / "supabase_key" in {CREDS.name}). See this '
            f"module's docstring, HTTPS REST MODE, for which key to issue.")
    if not url.startswith("https://"):
        raise SystemExit(f"${REST_URL_VAR} must start with https:// "
                         f"(expected https://<project-ref>.supabase.co).")
    if key.startswith("sb_secret_") or _jwt_role(key) == "service_role":
        raise SystemExit(
            "Refusing a service_role / secret key: it bypasses row-level "
            "security and can write. Issue a read-only key instead (see "
            "this module's docstring). The key was not printed or sent.")
    return url.rstrip("/"), key, where


def rest_request(method, path, params=None, headers=None, timeout=30):
    """The one door to PostgREST, and the REST-mode twin of run_query():
    anything but GET/HEAD is refused before it reaches the wire."""
    import requests
    if method.upper() not in REST_READ_METHODS:
        raise ValueError(f"refusing a {method.upper()} against a read-only "
                         f"source: only {REST_READ_METHODS} are allowed")
    base, key, _ = read_rest_credentials()
    h = {"apikey": key, "Accept": "application/json"}
    if key.count(".") == 2:   # JWT-shaped; sb_publishable_ keys go in apikey only
        h["Authorization"] = f"Bearer {key}"
    h.update(headers or {})
    return requests.request(method.upper(), f"{base}/rest/v1/{path.lstrip('/')}",
                            params=params, headers=h, timeout=timeout)


def rest_check_network(timeout=15):
    """HTTPS reachability of the project host, no key sent -- a 401 here is
    GOOD news (the host answered, it only wants a key)."""
    import requests
    base = (os.environ.get(REST_URL_VAR, "").strip().rstrip("/")
            or (json.loads(CREDS.read_text()).get("supabase_url", "")
                if CREDS.exists() else "").strip().rstrip("/"))
    if not base:
        return None, f"${REST_URL_VAR} is not set"
    try:
        r = requests.get(f"{base}/rest/v1/", timeout=timeout)
        return base, f"HTTP {r.status_code} (host reachable)"
    except Exception as exc:
        return base, f"FAILED: {type(exc).__name__}: {exc}"


def rest_openapi():
    """PostgREST's schema document (tables + columns), or None when this
    key's role is not allowed to read it -- newer Supabase projects may
    restrict it, so every caller has a per-table fallback."""
    r = rest_request("GET", "/", headers={"Accept": "application/openapi+json"})
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except ValueError:
        return None


def rest_probe_table(table):
    """(status, row_count_or_None, detail) for one table: a zero-row GET with
    an exact count -- proves read access without pulling any data."""
    r = rest_request("GET", table, params={"select": "*", "limit": "0"},
                     headers={"Prefer": "count=exact"})
    count = None
    cr = r.headers.get("Content-Range", "")
    if "/" in cr and cr.rsplit("/", 1)[1].isdigit():
        count = int(cr.rsplit("/", 1)[1])
    detail = "" if r.ok else r.text[:160]
    return r.status_code, count, detail


def rest_whoami():
    """What role the key maps to, and whether PostgREST answers with it."""
    _, key, where = read_rest_credentials()
    role = _jwt_role(key) or ("publishable key (role: anon)"
                              if key.startswith("sb_publishable_") else "unknown (non-JWT key)")
    r = rest_request("GET", "/", headers={"Accept": "application/openapi+json"})
    return where, role, r.status_code


def rest_list_tables():
    """[(name, how_known, rows_or_None, status)]. From the schema document
    when readable; otherwise each operator-named table is probed directly."""
    spec = rest_openapi()
    names = sorted(p.strip("/") for p in (spec or {}).get("paths", {})
                   if p.strip("/") and not p.startswith("/rpc/"))
    how = "listed by PostgREST" if spec else "probed (schema doc not readable)"
    out = []
    for name in (names or list(KNOWN_TABLES)):
        status, count, _ = rest_probe_table(name)
        out.append((name, how, count, status))
    return out


def rest_describe(table):
    """[(column, type, nullable_or_None)]. From the schema document when
    readable; otherwise inferred from one sample row -- types are then
    Python types of that row's values, and flagged as inferred."""
    spec = rest_openapi()
    d = (spec or {}).get("definitions", {}).get(table)
    if d:
        req = set(d.get("required", []))
        return [(c, v.get("format") or v.get("type", "?"), c not in req)
                for c, v in d.get("properties", {}).items()], "schema"
    r = rest_request("GET", table, params={"select": "*", "limit": "1"})
    if not r.ok:
        raise SystemExit(f"  {table}: HTTP {r.status_code} {r.text[:160]}")
    rows = r.json()
    if not rows:
        return [], "empty"
    return [(c, f"{type(v).__name__} (inferred)", None)
            for c, v in rows[0].items()], "sample"


def main_rest(a):
    if a.check_network:
        base, result = rest_check_network()
        print(f"  {base or '(no URL)'}  {result}")
        return True
    if a.whoami:
        where, role, status = rest_whoami()
        print(f"  credential loaded from {where}")
        print(f"  key role: {role}")
        print(f"  PostgREST schema endpoint: HTTP {status}"
              f"{'' if status == 200 else ' (not readable with this key; --tables will probe instead)'}")
        return True
    if a.tables:
        rows = rest_list_tables()
        for name, _, count, status in rows:
            flag = "  (named by operator)" if name in KNOWN_TABLES else ""
            seen = f"{count} rows" if count is not None else f"HTTP {status}"
            print(f"  {name:<24}{seen:<16}{flag}")
        if rows:
            print(f"  ({rows[0][1]})")
        return True
    if a.describe:
        cols, source = rest_describe(a.describe)
        if not cols:
            print(f"  {a.describe!r}: no columns visible ({source})")
            return True
        for name, dtype, nullable in cols:
            null = "" if nullable is None else ("NULL" if nullable else "NOT NULL")
            print(f"  {name:<30}{dtype:<24}{null}")
        if source == "sample":
            print("  (types inferred from one row; the schema document was not readable)")
        return True
    return False


# --------------------------------------------------------------- board mode

def read_board_credentials():
    """(url, key, where). The URL has a sensible default (it is not a
    secret); the key does not -- it is never defaulted, only ever read from
    the environment or the gitignored file."""
    url = os.environ.get(BOARD_URL_VAR, "").strip() or DEFAULT_BOARD_URL
    key = os.environ.get(BOARD_KEY_VAR, "").strip()
    where = f"${BOARD_KEY_VAR}"
    if not key and CREDS.exists():
        try:
            info = json.loads(CREDS.read_text())
        except json.JSONDecodeError as e:
            raise SystemExit(f"{CREDS} is not valid JSON ({e}). No credential printed.")
        key = (info.get("board_api_key") or "").strip()
        url = os.environ.get(BOARD_URL_VAR, "").strip() or (info.get("board_url") or "").strip() or url
        where = str(CREDS)
    if not key:
        raise SystemExit(
            f"Board API needs ${BOARD_KEY_VAR} (or \"board_api_key\" in "
            f"{CREDS.name}). See this module's docstring, BOARD API MODE, "
            f"for the setup steps. No credential printed.")
    if not url.startswith("https://"):
        raise SystemExit(f"${BOARD_URL_VAR} must start with https://.")
    return url, key, where


def board_request(table, page=0, limit=1000, since=None, timeout=30):
    """The one door to the board API. Always a GET -- this API exposes no
    other verb, so unlike run_query()/rest_request() there is nothing to
    refuse; the guarantee comes from never building anything else."""
    import requests
    if table not in BOARD_TABLES:
        raise ValueError(f"{table!r} is not one of the known board tables: {BOARD_TABLES}")
    url, key, _ = read_board_credentials()
    params = {"table": table, "page": page, "limit": limit}
    if since:
        params["since"] = since
    r = requests.get(url, params=params, headers={"X-API-Key": key}, timeout=timeout)
    r.raise_for_status()
    return r.json()


def board_probe_table(table):
    """(total_rows_or_None, error_or_None) from a one-row page -- proves
    access and gets the real count without pulling the table."""
    try:
        body = board_request(table, page=0, limit=1)
        return body.get("total_rows"), None
    except Exception as exc:
        return None, str(exc)


def board_list_tables():
    return [(t, *board_probe_table(t)) for t in BOARD_TABLES]


def board_describe(table):
    """[(column, python_type)] inferred from one real row -- this API has
    no schema document, only data, so a sample is all there is."""
    body = board_request(table, page=0, limit=1)
    rows = body.get("data") or []
    if not rows:
        return []
    return [(k, type(v).__name__) for k, v in rows[0].items()]


def board_fetch_all(table, since=None, limit=1000):
    """Every row of one table, paginating on has_more. A real pull, not a
    sample -- used by --pull and by any future real ingestion, never by
    --tables/--describe, which only ever look at one page."""
    page, out = 0, []
    while True:
        body = board_request(table, page=page, limit=limit, since=since)
        out.extend(body.get("data") or [])
        if not body.get("has_more"):
            return out
        page += 1


def main_board(a):
    if a.check_network:
        url = os.environ.get(BOARD_URL_VAR, "").strip() or DEFAULT_BOARD_URL
        import requests
        try:
            r = requests.get(url, timeout=15)
            print(f"  {url}  HTTP {r.status_code} (host reachable)")
        except Exception as exc:
            print(f"  {url}  FAILED: {type(exc).__name__}: {exc}")
        return True
    if a.whoami:
        url, _, where = read_board_credentials()
        body = board_request("weeks", limit=1)
        print(f"  credential loaded from {where}")
        print(f"  {url} -> HTTP 200, table={body.get('table')!r}, "
              f"total_rows={body.get('total_rows')}")
        return True
    if a.tables:
        for name, count, err in board_list_tables():
            flag = "" if name in KNOWN_TABLES else "  (not in the operator's original six)"
            print(f"  {name:<24}{count if count is not None else f'ERROR: {err}':<10}{flag}")
        return True
    if a.describe:
        cols = board_describe(a.describe)
        if not cols:
            print(f"  {a.describe!r}: no rows to infer columns from")
            return True
        for name, ptype in cols:
            print(f"  {name:<24}{ptype}")
        print("  (types inferred from one live row; there is no schema document)")
        return True
    if a.pull:
        rows = board_fetch_all(a.pull, since=a.since)
        print(f"  pulled {len(rows)} rows from {a.pull!r}"
              f"{f' since {a.since}' if a.since else ''}")
        if a.out:
            Path(a.out).write_text(json.dumps(rows, indent=1))
            print(f"  wrote {a.out}")
        return True
    return False


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
    ap.add_argument("--rest", action="store_true",
                    help="use Supabase's HTTPS REST API instead of raw Postgres "
                         "(needed where only HTTPS egress exists)")
    ap.add_argument("--board", action="store_true",
                    help="use DispatchHQ's own board-data API -- the path that "
                         "actually works from this environment, confirmed live")
    ap.add_argument("--pull", metavar="TABLE",
                    help="(--board only) fetch every row of TABLE, paginating")
    ap.add_argument("--since", metavar="DATE",
                    help="(--board --pull only) only load_entries/weeks support this")
    ap.add_argument("--out", metavar="FILE",
                    help="(--board --pull only) write the pulled rows as JSON")
    a = ap.parse_args()

    if a.board:
        if not main_board(a):
            ap.print_help()
        return

    if a.rest:
        if not main_rest(a):
            ap.print_help()
        return

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
