"""
QuickBooks Online -> qb_transactions (GL detail).

STATUS: structurally complete, NOT yet live. Everything except the two network
calls is implemented and testable offline:
  - OAuth2 token refresh flow            -> needs client_id/client_secret/refresh_token
  - GeneralLedger report request         -> needs realm_id + a valid access token
  - report JSON -> flat GL rows          -> IMPLEMENTED, tested (--parse-fixture)
  - QB account -> our taxonomy mapping   -> IMPLEMENTED
  - upsert into qb_transactions          -> IMPLEMENTED

Supply credentials (see README "QuickBooks credentials") and the live path
works without further code changes.

WHY THE GENERALLEDGER REPORT rather than the query API: the report already
carries the posted GL account, Class, and Location per line, which is exactly
the categorization PROMPT.md wants to use instead of re-deriving from memos.
Reconstructing that from Purchase/Bill/JournalEntry queries means reimplementing
QuickBooks' own posting logic — more code, more ways to be subtly wrong.

MULTI-ENTITY: QuickBooks Online scopes everything to a realm (company file).
Two possible setups, both handled:
  a) one company file per entity  -> one realm_id each, entity comes from the realm map
  b) one company file, Classes or Locations per entity -> entity comes from Class/Location
Set ENTITY_RESOLUTION accordingly once we see how the books are actually structured.

Usage:
    python ingest/ingest_quickbooks.py --realm 123456789 --start 2026-01-01 --end 2026-01-31
    python ingest/ingest_quickbooks.py --parse-fixture tests/fixtures/qb_gl_sample.json --realm R1
    python ingest/ingest_quickbooks.py --sync-accounts --realm 123456789
"""
import argparse
import json
import os
import sqlite3
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parent.parent))
from taxonomy.categorize import categorize, classify, extract_unit_number

DB_PATH = Path(__file__).resolve().parent.parent / "db" / "fleet_financials.db"
CREDS_PATH = Path(__file__).resolve().parent.parent / "config" / "quickbooks_credentials.json"
TOKEN_PATH = Path(__file__).resolve().parent.parent / "config" / "quickbooks_tokens.json"

API_BASE = "https://quickbooks.api.intuit.com/v3/company"
TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
MINOR_VERSION = "75"

# realm_id -> entity_id. Fill in once we know which company file is which entity.
REALM_TO_ENTITY = {}

# Used when one company file holds several entities, keyed by Class or Location
# name as it literally appears in QuickBooks.
CLASS_TO_ENTITY = {}

# 'realm' | 'class' | 'location' — how an entity is identified in these books.
ENTITY_RESOLUTION = "realm"

# QBO AccountTypes that are real cash/credit accounts. Their GL amounts already
# express cash direction; income/expense lines are the mirror image and must flip.
CASH_ACCOUNT_TYPES = {"bank", "credit card", "creditcard", "other current asset"}

# QBO AccountSubType -> our taxonomy. The GL account is more reliable than a
# memo keyword, so this takes precedence over categorize() for QB rows.
SUBTYPE_TO_CATEGORY = {
    "fuelexpense": "fuel",
    "repairmaintenance": "maintenance",
    "vehicleleaseexpense": "lease_rent",
    "vehicleloan": "loan_finance",
    "insurance": "insurance_premium",
    "payrollexpenses": "driver_settlement",
    "taxespaid": "registration",
    "vehicleregistration": "registration",
    "vehicletollsexpense": "tolls",
    "duesandsubscriptions": "subscriptions_saas",
    "interestpaid": "loan_finance",
    "vehicle": "capex_truck_trailer",
    "truck": "capex_truck_trailer",
}


# ---------------------------------------------------------------------------
# OAuth2  — needs credentials before it can run
# ---------------------------------------------------------------------------

def load_credentials():
    """client_id / client_secret / refresh_token, from env or config file.

    Env wins so CI and the Mac Mini can inject without a file on disk. The file
    lives in config/ which is gitignored — these are live financial credentials
    and must never reach the repo.
    """
    env = {k: os.environ.get(f"QB_{k.upper()}") for k in ("client_id", "client_secret", "refresh_token")}
    if all(env.values()):
        return env
    if CREDS_PATH.exists():
        return json.loads(CREDS_PATH.read_text())
    raise SystemExit(
        f"No QuickBooks credentials. Provide either:\n"
        f"  env: QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REFRESH_TOKEN\n"
        f"  or file: {CREDS_PATH}\n"
        f"See README 'QuickBooks credentials' for the exact shape."
    )


def refresh_access_token(creds=None):
    """Exchange the refresh token for an access token.

    QBO refresh tokens rotate on every use and expire after 100 days of
    inactivity, so the new one is written back immediately — losing it means
    re-doing the browser consent flow by hand.
    """
    import base64
    creds = creds or load_credentials()
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": creds["refresh_token"],
    }).encode()
    basic = base64.b64encode(f"{creds['client_id']}:{creds['client_secret']}".encode()).decode()
    req = urllib.request.Request(TOKEN_URL, data=body, method="POST", headers={
        "Authorization": f"Basic {basic}",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.load(resp)

    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(json.dumps({**payload, "obtained_at": datetime.now().isoformat()}, indent=2))
    if payload.get("refresh_token") and payload["refresh_token"] != creds["refresh_token"]:
        print("NOTE: QuickBooks rotated the refresh token — update your stored credential.")
    return payload["access_token"]


def _api_get(path, realm_id, access_token, params=None):
    params = {**(params or {}), "minorversion": MINOR_VERSION}
    url = f"{API_BASE}/{realm_id}/{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

def fetch_gl_report(realm_id, start_date, end_date, access_token):
    """GeneralLedger report for a date range. Returns raw QBO report JSON."""
    return _api_get("reports/GeneralLedger", realm_id, access_token, {
        "start_date": start_date,
        "end_date": end_date,
        "columns": ("tx_date,txn_type,doc_num,name,memo,split_acc,"
                    "subt_nat_amount,account_name,klass_name,dept_name"),
        "accounting_method": "Accrual",
    })


def fetch_accounts(realm_id, access_token):
    """Chart of accounts, for the GL-account -> taxonomy mapping."""
    return _api_get("query", realm_id, access_token,
                    {"query": "SELECT * FROM Account MAXRESULTS 1000"})


# ---------------------------------------------------------------------------
# Parse  — implemented and offline-testable
# ---------------------------------------------------------------------------

def _col_index(report):
    """Map QBO ColType -> position. Column order is not guaranteed stable across
    report variants, so never index by hard-coded position."""
    cols = report.get("Columns", {}).get("Column", [])
    idx = {}
    for i, c in enumerate(cols):
        key = (c.get("ColType") or c.get("ColTitle") or f"col{i}").strip()
        idx[key] = i
    return idx


def _cell(row_data, idx, key, default=""):
    i = idx.get(key)
    if i is None or i >= len(row_data):
        return default
    cell = row_data[i] or {}
    return (cell.get("value") or default), (cell.get("id") or None)


def parse_gl_report(report, realm_id, source_label="quickbooks_gl"):
    """Flatten QBO's nested report JSON into GL line dicts.

    The report nests Rows inside Rows inside Section headers (grouped by
    account), so this walks recursively and carries the enclosing section's
    account name down to leaf rows — leaf Data rows don't always repeat it.
    """
    idx = _col_index(report)
    out = []

    def walk(rows, section_account=None, section_account_id=None):
        for row in rows or []:
            if row.get("type") == "Section" or "Header" in row or "Rows" in row:
                acct, acct_id = section_account, section_account_id
                header = (row.get("Header") or {}).get("ColData") or []
                if header:
                    hv = (header[0] or {}).get("value")
                    hid = (header[0] or {}).get("id")
                    if hv:
                        acct, acct_id = hv, (hid or acct_id)
                walk((row.get("Rows") or {}).get("Row"), acct, acct_id)
                continue

            data = row.get("ColData")
            if not data:
                continue

            amount_raw, _ = _cell(data, idx, "subt_nat_amount", "0")
            try:
                amount = float(str(amount_raw).replace(",", "").replace("$", "") or 0)
            except ValueError:
                continue
            if amount == 0:
                continue    # running-balance and subtotal artifacts

            tx_date, _ = _cell(data, idx, "tx_date")
            txn_type, txn_id = _cell(data, idx, "txn_type")
            name, _ = _cell(data, idx, "name")
            memo, _ = _cell(data, idx, "memo")
            acct_name, acct_id = _cell(data, idx, "account_name")
            klass, _ = _cell(data, idx, "klass_name")
            dept, _ = _cell(data, idx, "dept_name")

            out.append({
                "qb_txn_id": txn_id or f"{tx_date}:{txn_type}:{abs(amount)}",
                "realm_id": realm_id,
                "txn_type": txn_type,
                "txn_date": _normalize_date(tx_date),
                # Raw GL amount: debit positive, credit negative. Normalizing to our
                # cash-flow sign needs the account type, which lives in qb_accounts,
                # so it happens in upsert_qb_transactions() — not here.
                "gl_amount": amount,
                "qb_account_id": acct_id,
                "qb_account_name": acct_name or section_account,
                "class_name": klass,
                "location_name": dept,
                "vendor_name": name,
                "memo": memo,
                "source_report": source_label,
            })

    walk((report.get("Rows") or {}).get("Row"))

    # QBO does not give a stable per-line id in report output, so number lines
    # within each transaction in report order. Stable across re-pulls of the
    # same period, which is what the upsert primary key needs.
    seen = {}
    for row in out:
        n = seen.get(row["qb_txn_id"], 0) + 1
        seen[row["qb_txn_id"]] = n
        row["qb_line_id"] = str(n)
    return out


def _normalize_date(raw):
    if not raw:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(str(raw).strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return str(raw)


# ---------------------------------------------------------------------------
# Enrich
# ---------------------------------------------------------------------------

def resolve_entity(row):
    if ENTITY_RESOLUTION == "class":
        return CLASS_TO_ENTITY.get((row.get("class_name") or "").strip())
    if ENTITY_RESOLUTION == "location":
        return CLASS_TO_ENTITY.get((row.get("location_name") or "").strip())
    return REALM_TO_ENTITY.get(row.get("realm_id"))


def resolve_category(row, account_map, account_type=None, amount=None):
    """GL account first, then keyword fallback.

    A booked GL account beats a memo keyword — that's the whole reason
    QuickBooks is the categorized source of truth. categorize() only fills gaps
    for accounts nobody has mapped yet.
    """
    if (account_type or "").strip().lower() in CASH_ACCOUNT_TYPES:
        return None      # the cash leg is money movement, not a spend category
    if row.get("qb_account_id") and row["qb_account_id"] in account_map:
        return account_map[row["qb_account_id"]]
    return categorize(
        f"{row.get('qb_account_name','')} {row.get('vendor_name','')} {row.get('memo','')}",
        amount)


def load_account_map(conn):
    return {r[0]: r[1] for r in conn.execute("SELECT qb_account_id, category FROM qb_account_category_map")}


def auto_map_accounts(conn, realm_id):
    """Seed qb_account_category_map from AccountSubType. Anything unmapped gets
    reported so it can be mapped by hand rather than silently guessed."""
    rows, unmapped = [], []
    for r in conn.execute("SELECT qb_account_id, name, account_type, account_subtype "
                          "FROM qb_accounts WHERE realm_id = ?", (realm_id,)):
        sub = (r[3] or "").strip().lower()
        cat = SUBTYPE_TO_CATEGORY.get(sub)
        if not cat:
            cat = categorize(r[1] or "")
            if cat == "uncategorized":
                unmapped.append((r[0], r[1], r[3]))
                continue
        rows.append((r[0], cat, "auto_subtype" if sub in SUBTYPE_TO_CATEGORY else "auto_name",
                     datetime.now().date().isoformat()))
    conn.executemany("INSERT OR REPLACE INTO qb_account_category_map "
                     "(qb_account_id, category, mapped_by, mapped_date) VALUES (?,?,?,?)", rows)
    conn.commit()
    print(f"Auto-mapped {len(rows)} GL accounts to taxonomy categories.")
    if unmapped:
        print(f"{len(unmapped)} accounts need a manual mapping — these will fall back to memo keywords:")
        for acct_id, name, sub in unmapped[:25]:
            print(f"   {acct_id:<8} {name:<40} subtype={sub}")
    return len(rows), len(unmapped)


# ---------------------------------------------------------------------------
# Persist
# ---------------------------------------------------------------------------

def normalize_amount(gl_amount, account_type):
    """GL debit/credit -> our cash-flow sign (negative = money out).

    A $1,240 fuel purchase posts as a +1240 debit to Fuel and a -1240 credit to
    Chase. Cash actually left in both views, so the bank line passes through
    unchanged and the expense line flips. Flipping both would put the bank leg
    at +1240 and it would never match the bank statement's -1240.
    """
    t = (account_type or "").strip().lower()
    return gl_amount if t in CASH_ACCOUNT_TYPES else -gl_amount


def register_discovered_units(conn, unit_numbers, rows_by_unit):
    """Add unit numbers seen in QuickBooks but absent from the `units` roster.

    Dropping them would silently lose per-unit attribution; failing the insert
    would block the whole ingest on a roster gap. Registering them as stubs
    keeps the data and turns the gap into a visible to-do — README already asks
    for the real roster to be loaded, and this shows exactly what's missing.
    """
    known = {r[0] for r in conn.execute("SELECT unit_number FROM units")}
    new = sorted(u for u in unit_numbers if u and u not in known)
    if not new:
        return []
    conn.executemany(
        "INSERT OR IGNORE INTO units (unit_number, unit_type, entity_id) VALUES (?, NULL, ?)",
        [(u, rows_by_unit.get(u)) for u in new])
    conn.commit()
    return new


def upsert_qb_transactions(conn, rows):
    """Idempotent on (qb_txn_id, qb_line_id) — re-pulling a period corrects
    rows in place instead of duplicating them. Edits in QuickBooks are common,
    so re-pulling a closed month has to be safe."""
    account_map = load_account_map(conn)
    account_types = {r[0]: r[1] for r in conn.execute(
        "SELECT qb_account_id, account_type FROM qb_accounts")}
    unknown_type = 0
    payload = []
    discovered, discovered_entity = set(), {}
    for r in rows:
        acct_type = account_types.get(r.get("qb_account_id"))
        if acct_type is None:
            unknown_type += 1
        amount = normalize_amount(r["gl_amount"], acct_type)
        memo_blob = f"{r.get('memo','')} {r.get('vendor_name','')} {r.get('class_name','')}"
        unit = extract_unit_number(memo_blob)
        if unit:
            discovered.add(unit)
            discovered_entity.setdefault(unit, resolve_entity(r))
        payload.append((
            r["qb_txn_id"], r["qb_line_id"], r["realm_id"], r["txn_type"], r["txn_date"],
            amount, r["qb_account_id"], r["qb_account_name"], resolve_entity(r),
            r.get("class_name"), r.get("location_name"), unit,
            r.get("vendor_name"), r.get("memo"), resolve_category(r, account_map, acct_type, amount),
            r.get("bank_account_ref"), r["source_report"],
            datetime.now().isoformat(timespec="seconds"),
        ))
    new_units = register_discovered_units(conn, discovered, discovered_entity)

    conn.executemany("""
        INSERT INTO qb_transactions
        (qb_txn_id, qb_line_id, realm_id, txn_type, txn_date, amount, qb_account_id,
         qb_account_name, entity_id, class_name, location_name, unit_number,
         vendor_name, memo, category, bank_account_ref, source_report, ingested_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(qb_txn_id, qb_line_id) DO UPDATE SET
            txn_date=excluded.txn_date, amount=excluded.amount,
            qb_account_id=excluded.qb_account_id, qb_account_name=excluded.qb_account_name,
            entity_id=excluded.entity_id, class_name=excluded.class_name,
            location_name=excluded.location_name, unit_number=excluded.unit_number,
            vendor_name=excluded.vendor_name, memo=excluded.memo,
            category=excluded.category, ingested_at=excluded.ingested_at
    """, payload)
    conn.commit()

    uncategorized = sum(1 for p in payload if p[14] == "uncategorized")
    unassigned = sum(1 for p in payload if p[8] is None)
    print(f"Upserted {len(payload)} QuickBooks GL lines.")
    if uncategorized:
        print(f"   {uncategorized} lines uncategorized — map their GL accounts in qb_account_category_map.")
    if unassigned:
        print(f"   {unassigned} lines have no entity_id — populate REALM_TO_ENTITY / CLASS_TO_ENTITY.")
    if new_units:
        print(f"   {len(new_units)} unit numbers appeared in QuickBooks but are not in your "
              f"`units` roster — registered as stubs, fill in type/VIN/service dates: "
              f"{', '.join(new_units[:15])}")
    if unknown_type:
        print(f"   WARNING: {unknown_type} lines hit GL accounts not in qb_accounts, so their "
              f"account type is unknown and their sign was assumed to be income/expense. "
              f"Run --sync-accounts first to remove this guess.")
    return len(payload)


def upsert_accounts(conn, query_response, realm_id):
    accounts = (query_response.get("QueryResponse") or {}).get("Account", [])
    conn.executemany("""
        INSERT INTO qb_accounts (qb_account_id, realm_id, name, fully_qualified_name,
                                  account_type, account_subtype, active)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(qb_account_id) DO UPDATE SET
            name=excluded.name, fully_qualified_name=excluded.fully_qualified_name,
            account_type=excluded.account_type, account_subtype=excluded.account_subtype,
            active=excluded.active
    """, [(a.get("Id"), realm_id, a.get("Name"), a.get("FullyQualifiedName"),
           a.get("AccountType"), a.get("AccountSubType"), 1 if a.get("Active", True) else 0)
          for a in accounts])
    conn.commit()
    print(f"Synced {len(accounts)} GL accounts from realm {realm_id}.")
    return len(accounts)


# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=str(DB_PATH))
    p.add_argument("--realm", help="QuickBooks realm/company id")
    p.add_argument("--start", help="period start YYYY-MM-DD")
    p.add_argument("--end", help="period end YYYY-MM-DD")
    p.add_argument("--sync-accounts", action="store_true", help="pull chart of accounts and auto-map")
    p.add_argument("--parse-fixture", help="parse a saved report JSON instead of calling the API (offline test)")
    args = p.parse_args()

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA foreign_keys = ON")

    if args.parse_fixture:
        report = json.loads(Path(args.parse_fixture).read_text())
        rows = parse_gl_report(report, args.realm or "FIXTURE", source_label=Path(args.parse_fixture).name)
        print(f"Parsed {len(rows)} GL lines from fixture.")
        upsert_qb_transactions(conn, rows)
        conn.close()
        return

    if not args.realm:
        raise SystemExit("--realm is required for live pulls.")

    token = refresh_access_token()

    if args.sync_accounts:
        upsert_accounts(conn, fetch_accounts(args.realm, token), args.realm)
        auto_map_accounts(conn, args.realm)
        conn.close()
        return

    if not (args.start and args.end):
        raise SystemExit("--start and --end are required (YYYY-MM-DD).")

    report = fetch_gl_report(args.realm, args.start, args.end, token)
    rows = parse_gl_report(report, args.realm, f"GL {args.start}..{args.end}")
    print(f"Fetched {len(rows)} GL lines for {args.start}..{args.end}.")
    upsert_qb_transactions(conn, rows)
    conn.close()


if __name__ == "__main__":
    main()
