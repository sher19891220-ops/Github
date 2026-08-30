"""
Google Sheets -> finance.pnl_observations / finance.odometer_readings.

The Sheets P&L is where the business has actually been making decisions, so it
is the most important thing to reconcile — and because it is hand-maintained, it
is also the most likely place for the errors this pipeline exists to find. It is
loaded as an OBSERVATION to be tested, never as a source of truth.

STATUS: parsing and normalization implemented and tested offline. Only the API
call needs credentials (`--csv` reads an export instead, no auth required).

TWO LAYOUTS handled, auto-detected:

  wide  — the usual hand-built P&L: categories down the rows, months across
          the columns. Gets unpivoted.
              Category      Jan-24     Feb-24     Mar-24
              Fuel         -45200     -47100     -44300

  tidy  — already one row per observation.
              Entity  Month    Category  Amount

Entity comes from a column when present, otherwise from the tab name via
TAB_TO_ENTITY (a tab per company is the common setup).

Usage:
    python ingest/ingest_gsheets.py pnl  --csv exports/zone_pnl_2024.csv --entity ZONE
    python ingest/ingest_gsheets.py pnl  --sheet-id <id> --tab "Zone P&L"
    python ingest/ingest_gsheets.py odo  --csv exports/odometer.csv
    python ingest/ingest_gsheets.py map  --source gsheets     # show unmapped categories
"""
import argparse
import csv
import io
import json
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parent.parent))
from taxonomy.categorize import categorize

CREDS_PATH = Path(__file__).resolve().parent.parent / "config" / "gsheets_service_account.json"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# Tab name -> entity_id, for the one-tab-per-company layout.
TAB_TO_ENTITY = {}

MONTH_HEADER_FORMATS = [
    "%b-%y", "%b %y", "%B %Y", "%b-%Y", "%m/%Y", "%Y-%m", "%m-%Y", "%b", "%B",
]

# Rows a hand-built P&L carries that are not categories. Summing these back in
# double-counts the entire sheet, so they are dropped and reported, never mapped.
TOTAL_ROW_PATTERNS = [
    r"^total", r"^net\b", r"\btotal$", r"^gross\b", r"^subtotal", r"^sum\b",
    r"^profit", r"^loss\b", r"^ebitda", r"^margin", r"^grand total",
]


# ---------------------------------------------------------------------------
# Sheets API — needs a service account
# ---------------------------------------------------------------------------

def fetch_sheet(sheet_id, tab, creds_path=CREDS_PATH):
    """Read one tab. Requires a service account JSON with the Sheets API enabled,
    and the spreadsheet shared with that service account's client_email —
    sharing is the step people forget; without it this 404s on a sheet that
    plainly exists."""
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError:
        raise SystemExit("pip install google-api-python-client google-auth")
    path = Path(os.environ.get("GSHEETS_CREDENTIALS", creds_path))
    if not path.exists():
        raise SystemExit(
            f"No Google service account credentials at {path}.\n"
            f"Create one in Google Cloud Console (Sheets API enabled), download the JSON,\n"
            f"and share each spreadsheet with its client_email as Viewer."
        )
    creds = service_account.Credentials.from_service_account_file(str(path), scopes=SCOPES)
    svc = build("sheets", "v4", credentials=creds, cache_discovery=False)
    rng = f"'{tab}'" if tab else "A:ZZ"
    resp = svc.spreadsheets().values().get(spreadsheetId=sheet_id, range=rng).execute()
    return resp.get("values", [])


def read_csv_rows(path):
    with Path(path).open(newline="", encoding="utf-8-sig") as fh:
        return [r for r in csv.reader(fh)]


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_money(raw):
    """Sheet cells carry $, commas, parentheses for negatives, and stray spaces."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or s in ("-", "—", "–", "#N/A", "#DIV/0!", "#REF!", "N/A"):
        return None
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()").replace("$", "").replace(",", "").replace("%", "").strip()
    if s.startswith("-"):
        neg, s = True, s[1:]
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def parse_month_header(raw):
    """Turn a column header into the first of that month, or None if it isn't one."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    m = re.match(r"^(\d{4})[-/](\d{1,2})$", s)
    if m:
        return date(int(m.group(1)), int(m.group(2)), 1)
    m = re.match(r"^(\d{1,2})[-/](\d{4})$", s)
    if m:
        return date(int(m.group(2)), int(m.group(1)), 1)
    for fmt in MONTH_HEADER_FORMATS:
        try:
            d = datetime.strptime(s, fmt)
            year = d.year if "%y" in fmt.lower() or "%Y" in fmt else date.today().year
            return date(year, d.month, 1)
        except ValueError:
            continue
    return None


def is_total_row(label):
    l = (label or "").strip().lower()
    return any(re.search(p, l) for p in TOTAL_ROW_PATTERNS)


def detect_layout(rows):
    """wide if the header has two or more parseable month columns, else tidy."""
    if not rows:
        return "empty", 0
    for i, row in enumerate(rows[:10]):
        months = sum(1 for c in row if parse_month_header(c))
        if months >= 2:
            return "wide", i
        lowered = [str(c).strip().lower() for c in row]
        if "amount" in lowered and any(x in lowered for x in ("category", "account", "line item")):
            return "tidy", i
    return "unknown", 0


def parse_pnl(rows, entity_default=None, source_detail=""):
    """Return (observations, skipped_total_rows, warnings)."""
    layout, hdr_i = detect_layout(rows)
    if layout in ("empty", "unknown"):
        raise SystemExit(
            f"Could not detect a P&L layout in {source_detail or 'input'}.\n"
            f"Expected either month columns across the top, or Category/Amount columns.\n"
            f"First rows seen: {rows[:3]}"
        )

    obs, skipped, warnings = [], [], []
    header = rows[hdr_i]

    if layout == "wide":
        month_cols = {i: m for i, m in ((i, parse_month_header(c)) for i, c in enumerate(header)) if m}
        label_col = next((i for i in range(len(header)) if i not in month_cols), 0)
        entity_col = next((i for i, c in enumerate(header)
                           if str(c).strip().lower() in ("entity", "company", "llc")), None)
        for row in rows[hdr_i + 1:]:
            if not row or label_col >= len(row):
                continue
            label = str(row[label_col]).strip()
            if not label:
                continue
            if is_total_row(label):
                skipped.append(label)
                continue
            ent = (str(row[entity_col]).strip() if entity_col is not None and entity_col < len(row)
                   else entity_default)
            if not ent:
                warnings.append(f"no entity for row '{label}'")
                continue
            for ci, month in month_cols.items():
                if ci >= len(row):
                    continue
                amt = parse_money(row[ci])
                if amt is None or amt == 0:
                    continue
                obs.append({"entity_id": ent, "month": month, "raw_category": label, "amount": amt})
    else:
        idx = {str(c).strip().lower(): i for i, c in enumerate(header)}
        cat_i = next((idx[k] for k in ("category", "account", "line item") if k in idx), None)
        amt_i = idx.get("amount")
        mon_i = next((idx[k] for k in ("month", "period", "date") if k in idx), None)
        ent_i = next((idx[k] for k in ("entity", "company") if k in idx), None)
        for row in rows[hdr_i + 1:]:
            if not row or cat_i is None or amt_i is None or cat_i >= len(row) or amt_i >= len(row):
                continue
            label = str(row[cat_i]).strip()
            if not label:
                continue
            if is_total_row(label):
                skipped.append(label)
                continue
            amt = parse_money(row[amt_i])
            month = parse_month_header(row[mon_i]) if mon_i is not None and mon_i < len(row) else None
            ent = (str(row[ent_i]).strip() if ent_i is not None and ent_i < len(row) else entity_default)
            if amt is None or month is None or not ent:
                continue
            obs.append({"entity_id": ent, "month": month, "raw_category": label, "amount": amt})

    return obs, skipped, warnings


def parse_odometer(rows):
    """Columns: unit (unit/truck/unit_number), date (date/reading_date), odometer."""
    if not rows:
        return []
    hdr = [str(c).strip().lower() for c in rows[0]]
    def find(*names):
        for n in names:
            if n in hdr:
                return hdr.index(n)
        for i, h in enumerate(hdr):
            if any(n in h for n in names):
                return i
        return None
    u_i, d_i, o_i = find("unit", "truck", "unit_number"), find("date", "reading_date"), find("odometer", "miles", "hub")
    if None in (u_i, d_i, o_i):
        raise SystemExit(f"odometer export needs unit/date/odometer columns. Header seen: {rows[0]}")
    out = []
    for row in rows[1:]:
        if len(row) <= max(u_i, d_i, o_i):
            continue
        unit = str(row[u_i]).strip()
        odo = parse_money(row[o_i])
        d = None
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y"):
            try:
                d = datetime.strptime(str(row[d_i]).strip().split(" ")[0], fmt).date()
                break
            except ValueError:
                continue
        if unit and odo is not None and d:
            out.append({"unit_number": unit, "reading_date": d, "odometer": odo})
    return out


# ---------------------------------------------------------------------------
# Category mapping
# ---------------------------------------------------------------------------

def normalize_label(s):
    return re.sub(r"[^a-z0-9]+", "_", (s or "").strip().lower()).strip("_")


def map_categories(conn, source, raw_labels, flavor):
    """Map source labels to our taxonomy. Exact match first, then a normalized
    match, then the keyword categorizer. Anything still unmapped is REPORTED,
    not guessed — an unmapped P&L line is dollars silently missing from the
    comparison, which is worse than a visibly wrong one."""
    cur = conn.cursor()
    ph = "%s" if flavor == "postgres" else "?"
    tbl = "finance.source_category_map" if flavor == "postgres" else "source_category_map"
    cur.execute(f"SELECT source_category, category FROM {tbl} WHERE source = {ph}", (source,))
    existing = {r[0]: r[1] for r in cur.fetchall()}
    norm_existing = {normalize_label(k): v for k, v in existing.items()}

    resolved, new_rows, unmapped = {}, [], []
    for label in sorted(set(raw_labels)):
        if label in existing:
            resolved[label] = existing[label]
            continue
        n = normalize_label(label)
        if n in norm_existing:
            resolved[label] = norm_existing[n]
            new_rows.append((source, label, norm_existing[n], "auto_normalized"))
            continue
        guess = categorize(label)
        if guess != "uncategorized":
            resolved[label] = guess
            new_rows.append((source, label, guess, "auto_normalized"))
        else:
            resolved[label] = "uncategorized"
            unmapped.append(label)

    if new_rows:
        stmt = (f"INSERT INTO {tbl} (source, source_category, category, mapped_by) "
                f"VALUES ({ph},{ph},{ph},{ph}) ON CONFLICT (source, source_category) DO NOTHING")
        cur.executemany(stmt, new_rows)
        conn.commit()
    return resolved, unmapped


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def connect(args):
    if args.dsn:
        import psycopg2
        return psycopg2.connect(args.dsn), "postgres"
    import sqlite3
    c = sqlite3.connect(args.db)
    c.execute("PRAGMA foreign_keys = ON")
    return c, "sqlite"


def upsert_pnl(conn, flavor, obs, source, source_detail):
    cur = conn.cursor()
    ph = "%s" if flavor == "postgres" else "?"
    tbl = "finance.pnl_observations" if flavor == "postgres" else "pnl_observations"
    conflict = ("ON CONFLICT (source, source_detail, entity_id, month, category) "
                "DO UPDATE SET amount = EXCLUDED.amount, loaded_at = now()"
                if flavor == "postgres" else
                "ON CONFLICT (source, source_detail, entity_id, month, category) "
                "DO UPDATE SET amount = excluded.amount")
    # Several sheet rows can map to one taxonomy category; sum them before insert
    # so the second one does not overwrite the first.
    agg = {}
    for o in obs:
        key = (o["entity_id"], o["month"], o["category"])
        agg[key] = agg.get(key, 0.0) + o["amount"]
    rows = [(source, source_detail, e, m if flavor == "postgres" else m.isoformat(), c, round(a, 2), True)
            for (e, m, c), a in agg.items()]
    cur.executemany(
        f"INSERT INTO {tbl} (source, source_detail, entity_id, month, category, amount, is_stated) "
        f"VALUES ({ph},{ph},{ph},{ph},{ph},{ph},{ph}) {conflict}", rows)
    conn.commit()
    return len(rows)


def upsert_odometer(conn, flavor, readings, source, source_detail):
    cur = conn.cursor()
    ph = "%s" if flavor == "postgres" else "?"
    tbl = "finance.odometer_readings" if flavor == "postgres" else "odometer_readings"
    conflict = ("ON CONFLICT (source, unit_number, reading_date) DO UPDATE SET odometer = EXCLUDED.odometer"
                if flavor == "postgres" else
                "ON CONFLICT (source, unit_number, reading_date) DO UPDATE SET odometer = excluded.odometer")
    rows = [(source, r["unit_number"],
             r["reading_date"] if flavor == "postgres" else r["reading_date"].isoformat(),
             r["odometer"], source_detail) for r in readings]
    cur.executemany(f"INSERT INTO {tbl} (source, unit_number, reading_date, odometer, source_detail) "
                    f"VALUES ({ph},{ph},{ph},{ph},{ph}) {conflict}", rows)
    conn.commit()
    return len(rows)


# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", default=str(Path(__file__).resolve().parent.parent / "db" / "fleet_financials.db"))
    common.add_argument("--dsn")
    common.add_argument("--csv", help="read a CSV export instead of calling the Sheets API")
    common.add_argument("--sheet-id")
    common.add_argument("--tab")

    pn = sub.add_parser("pnl", parents=[common])
    pn.add_argument("--entity", help="entity_id when the sheet has no entity column")
    sub.add_parser("odo", parents=[common])
    mp = sub.add_parser("map", parents=[common])
    mp.add_argument("--source", default="gsheets")

    args = p.parse_args()
    conn, flavor = connect(args)

    if args.cmd == "map":
        cur = conn.cursor()
        tbl = "finance.source_category_map" if flavor == "postgres" else "source_category_map"
        ph = "%s" if flavor == "postgres" else "?"
        cur.execute(f"SELECT source_category, category, mapped_by FROM {tbl} WHERE source={ph} "
                    f"ORDER BY category, source_category", (args.source,))
        for r in cur.fetchall():
            print(f"  {r[0]:<44} -> {r[1]:<24} ({r[2]})")
        conn.close()
        return

    rows = read_csv_rows(args.csv) if args.csv else fetch_sheet(args.sheet_id, args.tab)
    detail = args.csv or f"{args.sheet_id}:{args.tab}"

    if args.cmd == "odo":
        readings = parse_odometer(rows)
        n = upsert_odometer(conn, flavor, readings, "gsheets", detail)
        print(f"Loaded {n} odometer readings from {detail}.")
        units = sorted({r['unit_number'] for r in readings})
        print(f"  {len(units)} units: {', '.join(units[:20])}{' ...' if len(units) > 20 else ''}")
        conn.close()
        return

    entity = args.entity or TAB_TO_ENTITY.get(args.tab or "")
    obs, skipped, warnings = parse_pnl(rows, entity, detail)
    resolved, unmapped = map_categories(conn, "gsheets", [o["raw_category"] for o in obs], flavor)
    for o in obs:
        o["category"] = resolved[o["raw_category"]]

    n = upsert_pnl(conn, flavor, obs, "gsheets", detail)
    print(f"Loaded {n} P&L observations from {detail} ({len(obs)} sheet cells).")
    if skipped:
        print(f"  Skipped {len(skipped)} total/subtotal rows (summing these would double-count "
              f"the sheet): {', '.join(sorted(set(skipped))[:8])}")
    if unmapped:
        total = sum(abs(o["amount"]) for o in obs if o["raw_category"] in set(unmapped))
        print(f"  {len(unmapped)} categories unmapped, ${total:,.2f} of sheet value. These will "
              f"compare as 'uncategorized' until mapped:")
        for label in unmapped[:20]:
            print(f"      {label}")
        print(f"  Map them: INSERT INTO source_category_map VALUES ('gsheets','<label>','<category>','manual',...)")
    for w in warnings[:10]:
        print(f"  WARNING: {w}")
    conn.close()


if __name__ == "__main__":
    main()
