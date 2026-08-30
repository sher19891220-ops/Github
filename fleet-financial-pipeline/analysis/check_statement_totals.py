"""
Statement-total control — the check that catches a bad parse on the first file
instead of after 36 months.

Every ingested statement must satisfy:

    sum(parsed transactions) == ending_balance - beginning_balance

A statement that fails this is a parsing defect, not a data question. Three
failure modes are self-consistent and otherwise completely silent, so this
names them explicitly:

  double_counted  parsed exactly 2x the expected movement. This is what
                  ingest_pdf.py currently produces — it appends from both
                  extract_tables() and extract_text() on the same page.
  sign_inverted   parsed the exact negative. A credit-card export ingested
                  without negation: charges booked as revenue.
  variance        anything else — dropped page, skipped rows, bad regex.

Works against SQLite (joins on source_file) and Postgres (joins on statement_id).

Usage:
    python analysis/check_statement_totals.py register --manifest statements.csv
    python analysis/check_statement_totals.py check
    python analysis/check_statement_totals.py check --dsn postgresql://aiops@100.77.103.37/aiops
    python analysis/check_statement_totals.py check --strict     # exit 1 on any failure (CI / batch gate)

Manifest CSV columns:
    account_id,period_start,period_end,beginning_balance,ending_balance,source_file

Beginning/ending balance are on page 1 of virtually every statement, and are
downloadable from the bank portal. This is the highest-value 6 numbers per
statement you will ever type.
"""
import argparse
import csv
import hashlib
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "db" / "fleet_financials.db"
TOLERANCE = 0.01


def connect(args):
    """SQLite by default; Postgres when --dsn is given. psycopg2 imported lazily
    so the SQLite path has no new dependency."""
    if args.dsn:
        try:
            import psycopg2
            import psycopg2.extras
        except ImportError:
            raise SystemExit("psycopg2 needed for --dsn: pip install psycopg2-binary")
        conn = psycopg2.connect(args.dsn)
        return conn, "postgres"
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn, "sqlite"


def file_hash(path):
    p = Path(path)
    if not p.exists():
        return None
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def register(conn, flavor, manifest_path, raw_dir):
    """Load statement periods and balances from a manifest CSV."""
    rows = list(csv.DictReader(Path(manifest_path).open()))
    required = {"account_id", "period_start", "period_end", "beginning_balance",
                "ending_balance", "source_file"}
    missing = required - set(rows[0].keys() if rows else [])
    if missing:
        raise SystemExit(f"manifest is missing columns: {', '.join(sorted(missing))}")

    cur = conn.cursor()
    n = 0
    for r in rows:
        h = file_hash(Path(raw_dir) / r["source_file"]) or ""
        vals = (r["account_id"], r["period_start"], r["period_end"],
                float(r["beginning_balance"]), float(r["ending_balance"]),
                r["source_file"], h, datetime.now().isoformat(timespec="seconds"))
        if flavor == "sqlite":
            cur.execute("""INSERT INTO statements
                (account_id, period_start, period_end, beginning_balance, ending_balance,
                 source_file, source_file_hash, ingested_at)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(source_file) DO UPDATE SET
                  period_start=excluded.period_start, period_end=excluded.period_end,
                  beginning_balance=excluded.beginning_balance,
                  ending_balance=excluded.ending_balance,
                  source_file_hash=excluded.source_file_hash""", vals)
        else:
            cur.execute("""INSERT INTO finance.statements
                (account_id, period_start, period_end, beginning_balance, ending_balance,
                 source_file, source_file_hash, ingested_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (source_file_hash) DO UPDATE SET
                  period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end,
                  beginning_balance=EXCLUDED.beginning_balance,
                  ending_balance=EXCLUDED.ending_balance""", vals)
        n += 1
    conn.commit()
    print(f"Registered {n} statements from {manifest_path}.")


def classify(parsed, expected):
    if abs(parsed - expected) <= TOLERANCE:
        return "ok"
    if abs(expected) > TOLERANCE:
        if abs(parsed - 2 * expected) <= TOLERANCE:
            return "double_counted"
        if abs(parsed + expected) <= TOLERANCE:
            return "sign_inverted"
    return "variance"


DIAGNOSIS = {
    "double_counted": "parsed exactly 2x expected — ingest_pdf.py appends from both "
                      "extract_tables() and extract_text(); dedup the two passes",
    "sign_inverted":  "parsed the exact negative — card export ingested without "
                      "negation; set the account's sign convention and re-ingest",
    "variance":       "partial parse — dropped page or unmatched line format; "
                      "inspect page.extract_text() and widen the pattern",
    "no_balances":    "no beginning/ending balance registered — add it to the manifest",
}


def check(conn, flavor, account=None):
    cur = conn.cursor()
    if flavor == "sqlite":
        sql = """
            SELECT s.source_file, s.account_id, s.period_start, s.period_end,
                   s.beginning_balance, s.ending_balance,
                   COALESCE(SUM(t.amount), 0) AS parsed_net,
                   COUNT(t.txn_id) AS parsed_rows
            FROM statements s
            LEFT JOIN transactions t ON t.source_file = s.source_file
            {where}
            GROUP BY s.source_file, s.account_id, s.period_start, s.period_end,
                     s.beginning_balance, s.ending_balance
            ORDER BY s.account_id, s.period_start
        """
        where = "WHERE s.account_id = ?" if account else ""
        cur.execute(sql.format(where=where), (account,) if account else ())
    else:
        sql = """
            SELECT s.source_file, s.account_id, s.period_start, s.period_end,
                   s.beginning_balance, s.ending_balance,
                   COALESCE(SUM(t.amount), 0) AS parsed_net,
                   COUNT(t.txn_id) AS parsed_rows
            FROM finance.statements s
            LEFT JOIN finance.transactions t ON t.statement_id = s.statement_id
            {where}
            GROUP BY s.source_file, s.account_id, s.period_start, s.period_end,
                     s.beginning_balance, s.ending_balance
            ORDER BY s.account_id, s.period_start
        """
        where = "WHERE s.account_id = %s" if account else ""
        cur.execute(sql.format(where=where), (account,) if account else ())

    results = []
    for r in cur.fetchall():
        src, acct, p0, p1, begin, end, parsed, rows = (r[0], r[1], r[2], r[3],
                                                       r[4], r[5], r[6], r[7])
        if begin is None or end is None:
            results.append((src, acct, p0, None, float(parsed), rows, "no_balances", None))
            continue
        expected = float(end) - float(begin)
        parsed = float(parsed)
        results.append((src, acct, p0, expected, parsed, rows,
                        classify(parsed, expected), parsed - expected))

    if not results:
        print("No statements registered. Run `register --manifest <file>` first.")
        print("Until statements are registered this control cannot run, and a bad "
              "parse will not be detected.")
        return []

    ok = [r for r in results if r[6] == "ok"]
    bad = [r for r in results if r[6] != "ok"]

    print(f"\nStatement-total control: {len(ok)}/{len(results)} statements reconcile.\n")
    if bad:
        print(f"{'file':<34}{'account':<18}{'expected':>13}{'parsed':>13}{'variance':>13}  status")
        print("-" * 106)
        for src, acct, p0, exp, parsed, rows, status, var in sorted(bad, key=lambda r: r[6]):
            e = f"{exp:,.2f}" if exp is not None else "—"
            v = f"{var:,.2f}" if var is not None else "—"
            print(f"{src[:33]:<34}{acct[:17]:<18}{e:>13}{parsed:>13,.2f}{v:>13}  {status}")
        print()
        for status in sorted({r[6] for r in bad}):
            n = sum(1 for r in bad if r[6] == status)
            print(f"  {status} ({n}): {DIAGNOSIS.get(status, '')}")
        print()
        exposure = sum(abs(r[7]) for r in bad if r[7] is not None)
        print(f"  Unexplained dollars across failing statements: ${exposure:,.2f}")
        print("  Do not run P&L or reconciliation on this data — fix the parsers first.")
    else:
        print("All registered statements reconcile to their balance delta.")
    return bad


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", default=str(DB_PATH))
    common.add_argument("--dsn", help="Postgres DSN; omit to use SQLite")

    reg = sub.add_parser("register", parents=[common], help="load statement balances from a manifest CSV")
    reg.add_argument("--manifest", required=True)
    reg.add_argument("--raw-dir", default=str(Path(__file__).resolve().parent.parent / "data" / "raw"))

    chk = sub.add_parser("check", parents=[common], help="run the control")
    chk.add_argument("--account", help="restrict to one account_id")
    chk.add_argument("--strict", action="store_true", help="exit 1 if any statement fails")

    args = p.parse_args()
    conn, flavor = connect(args)

    if args.cmd == "register":
        register(conn, flavor, args.manifest, args.raw_dir)
    else:
        bad = check(conn, flavor, args.account)
        conn.close()
        if args.strict and bad:
            sys.exit(1)
        return
    conn.close()


if __name__ == "__main__":
    main()
