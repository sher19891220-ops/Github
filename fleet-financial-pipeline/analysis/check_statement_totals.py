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


def check_csv(txn_csv, meta_csv, account=None):
    """Run the same control directly on the intake CSVs, before anything is
    loaded into a database.

    This is the gate between parsing and ingestion: it answers "is this parse
    correct?" using only the parser's own output and the balances lifted off
    page 1 of each statement. Joining on source_file means a statement that
    parsed zero rows still appears — as a failure, which is what it is.

    Joined on source_path, not filename: BofA names every statement
    eStmt_<period-end>.pdf, so seven accounts share the same ~60 basenames and
    a basename join silently pools every account's transactions together.

    txn_csv  : source_path, source_file, account_last4, txn_date, amount, ...
    meta_csv : file, path, account_last4, period_start, period_end,
               beginning_balance, ending_balance
    """
    parsed = {}
    rows_by_file = {}
    for r in csv.DictReader(Path(txn_csv).open()):
        f = r["source_path"]
        parsed[f] = parsed.get(f, 0.0) + float(r["amount"])
        rows_by_file[f] = rows_by_file.get(f, 0) + 1

    results = []
    for m in csv.DictReader(Path(meta_csv).open()):
        if not m["beginning_balance"] or not m["ending_balance"]:
            continue
        acct = m["account_last4"]
        if account and acct != account:
            continue
        f = m["path"]
        expected = float(m["ending_balance"]) - float(m["beginning_balance"])
        got = parsed.get(f, 0.0)
        results.append((m["file"], acct, m["period_start"], expected, got,
                        rows_by_file.get(f, 0), classify(got, expected),
                        got - expected))
    return report(results)


def report(results):
    """Shared presentation for the DB and CSV paths."""
    if not results:
        print("Nothing to check — no statement has both a balance pair and a parse.")
        return []

    ok = [r for r in results if r[6] == "ok"]
    bad = [r for r in results if r[6] != "ok"]

    print(f"\nStatement-total control: {len(ok)}/{len(results)} statements reconcile.\n")

    # Per account, because a parser defect is almost always account-shaped:
    # one bank's layout, one card's sign convention.
    accts = sorted({r[1] for r in results})
    print(f"{'account':<10}{'stmts':>7}{'pass':>7}{'fail':>7}{'rows':>9}{'unexplained $':>16}")
    print("-" * 56)
    for a in accts:
        sub = [r for r in results if r[1] == a]
        subok = [r for r in sub if r[6] == "ok"]
        subbad = [r for r in sub if r[6] != "ok"]
        print(f"{a:<10}{len(sub):>7}{len(subok):>7}{len(subbad):>7}"
              f"{sum(r[5] for r in sub):>9,}"
              f"{sum(abs(r[7]) for r in subbad if r[7] is not None):>16,.2f}")
    print()

    if bad:
        print(f"{'file':<28}{'account':<10}{'period':<12}{'expected':>14}{'parsed':>14}{'variance':>14}  status")
        print("-" * 106)
        for f, acct, p0, exp, got, rows, status, var in sorted(
                bad, key=lambda r: (r[1], r[2] or "")):
            e = f"{exp:,.2f}" if exp is not None else "\u2014"
            v = f"{var:,.2f}" if var is not None else "\u2014"
            print(f"{f[:27]:<28}{acct[:9]:<10}{(p0 or '')[:11]:<12}{e:>14}{got:>14,.2f}{v:>14}  {status}")
        print()
        for status in sorted({r[6] for r in bad}):
            n = sum(1 for r in bad if r[6] == status)
            print(f"  {status} ({n}): {DIAGNOSIS.get(status, '')}")
        print()
        exposure = sum(abs(r[7]) for r in bad if r[7] is not None)
        print(f"  Unexplained dollars across failing statements: ${exposure:,.2f}")
        print("  Do not run P&L or reconciliation on this data \u2014 fix the parser first.")
    else:
        print("Every statement reconciles to its balance delta. The parse is verified.")
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

    csvchk = sub.add_parser("check-csv", help="run the control on intake CSVs, pre-database")
    csvchk.add_argument("--txns", required=True, help="parsed transactions CSV")
    csvchk.add_argument("--meta", required=True, help="statement metadata CSV")
    csvchk.add_argument("--account", help="restrict to one account last-4")
    csvchk.add_argument("--strict", action="store_true", help="exit 1 if any statement fails")

    args = p.parse_args()

    if args.cmd == "check-csv":
        bad = check_csv(args.txns, args.meta, args.account)
        if args.strict and bad:
            sys.exit(1)
        return

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
