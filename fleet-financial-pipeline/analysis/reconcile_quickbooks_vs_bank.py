"""
Dual-source reconciliation: QuickBooks GL vs. raw bank/card ingestion.

This is NOT a fallback path. Per PROMPT.md both sources run permanently:
QuickBooks is the categorized P&L source of truth, bank/card ingestion is the
independent cash-movement source that can't be miscoded the way a manual GL
entry can. The disagreement between them is itself the signal.

Three mismatch types, reported distinctly and in DOLLARS:

  1. missing_in_qb     — hit a bank/card account, never booked in QuickBooks.
                         Real cash moved and the books don't know about it.
  2. missing_in_bank   — booked in QuickBooks, no matching cash movement.
                         Either booked against the wrong account, duplicated,
                         or entered for something that never actually cleared.
  3. category_mismatch — matched on amount+date, but the two sources disagree
                         on category. Worth a look, not necessarily wrong.

SIGN CONVENTION (both tables): negative = money out, positive = money in.
ingest_quickbooks.py is responsible for normalizing QBO's GL debit/credit
amounts into this convention before insert.

QB GL detail is line-level: one QuickBooks transaction splits into several GL
lines. Cash reconciliation happens against the *cash-facing view* of each QB
transaction (see build_qb_cash_view), not against individual expense lines,
otherwise a 3-way split purchase looks like 3 unmatched bank transactions.

Usage:
    python analysis/reconcile_quickbooks_vs_bank.py --period 2026-01
    python analysis/reconcile_quickbooks_vs_bank.py --period-start 2026-01-01 --period-end 2026-03-31
    python analysis/reconcile_quickbooks_vs_bank.py --entity ZONE --date-tolerance 5
    python analysis/reconcile_quickbooks_vs_bank.py --seed-mock --db /tmp/test.db   # exercise the logic with no real data
"""
import argparse
import csv
import re
import sqlite3
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "db" / "fleet_financials.db"
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"

DEFAULT_DATE_TOLERANCE_DAYS = 3      # PROMPT.md: amount, date (+/-3 days), category
DEFAULT_AMOUNT_TOLERANCE = 0.01      # exact to the cent; loosen for fee-skimmed transfers

# QBO AccountTypes that represent actual cash/credit accounts rather than
# income/expense categorization. These are the lines that mirror a bank feed.
CASH_ACCOUNT_TYPES = {"bank", "credit card", "creditcard"}

# Tokens too generic to signal that two memos describe the same transaction.
_MEMO_STOPWORDS = {
    "the", "and", "for", "inc", "llc", "co", "corp", "payment", "pmt", "purchase",
    "debit", "credit", "card", "ach", "pos", "transaction", "txn", "ref", "invoice",
}


# ---------------------------------------------------------------------------
# Date handling
# ---------------------------------------------------------------------------

def parse_date(raw):
    """Best-effort parse of the date formats the ingest scripts actually produce.

    Bank ingestion stores txn_date as whatever string the statement carried, so
    this has to be forgiving. Returns None when unparseable — those rows are
    reported separately rather than silently matched on amount alone, because a
    date-blind match across a whole period is worse than an honest gap.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or s.lower() in ("nan", "none", "nat"):
        return None
    s = s.split(" ")[0].split("T")[0]
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y", "%Y/%m/%d", "%m-%d-%Y", "%b %d %Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _period_bounds(args):
    if args.period:
        y, m = args.period.split("-")
        start = date(int(y), int(m), 1)
        end = date(int(y) + (int(m) == 12), (int(m) % 12) + 1, 1) - timedelta(days=1)
        return start.isoformat(), end.isoformat()
    return args.period_start, args.period_end


def _in_period(d, start, end):
    if d is None:
        return True          # undated rows are carried through and flagged, not dropped
    if start and d < parse_date(start):
        return False
    if end and d > parse_date(end):
        return False
    return True


# ---------------------------------------------------------------------------
# Loading both sides
# ---------------------------------------------------------------------------

def load_bank_side(conn, start, end, entity=None, include_intercompany=False):
    """Bank/card transactions — the independent cash-movement source."""
    sql = "SELECT * FROM transactions WHERE 1=1"
    params = []
    if entity:
        sql += " AND entity_id = ?"
        params.append(entity)
    if not include_intercompany:
        # Matched intercompany pairs are internal money movement. They do hit the
        # bank, but they net to zero across entities and QuickBooks may book them
        # as a single journal entry, so they generate noise on both sides.
        sql += " AND COALESCE(is_intercompany, 0) = 0"

    rows = []
    for r in conn.execute(sql, params):
        d = parse_date(r["txn_date"])
        if not _in_period(d, start, end):
            continue
        rows.append({
            "txn_id": r["txn_id"],
            "entity_id": r["entity_id"],
            "date": d,
            "raw_date": r["txn_date"],
            "amount": float(r["amount"] or 0.0),
            "category": r["category"] or "uncategorized",
            "memo": r["raw_memo"] or "",
            "counterparty": r["counterparty"] or "",
            "account_id": r["account_id"],
        })
    return rows


def build_qb_cash_view(conn, start, end, entity=None):
    """Collapse line-level QB GL detail into one cash-facing row per transaction.

    For each QuickBooks transaction:
      - cash amount comes from its Bank/Credit Card lines when present (that is
        the leg that mirrors the bank feed), otherwise from the income/expense
        lines, which under our cash-flow sign convention already carry the
        direction cash moved.
      - category comes from the largest-magnitude non-cash line. Splits keep the
        full category set so a mismatch report can say "fuel + maintenance",
        rather than pretending a split was single-category.
    """
    sql = """
        SELECT q.*, a.account_type AS acct_type
        FROM qb_transactions q
        LEFT JOIN qb_accounts a ON a.qb_account_id = q.qb_account_id
        WHERE 1=1
    """
    params = []
    if entity:
        sql += " AND q.entity_id = ?"
        params.append(entity)

    by_txn = defaultdict(list)
    for r in conn.execute(sql, params):
        by_txn[r["qb_txn_id"]].append(r)

    view = []
    for qb_txn_id, lines in by_txn.items():
        d = parse_date(lines[0]["txn_date"])
        if not _in_period(d, start, end):
            continue

        cash_lines, cat_lines = [], []
        for ln in lines:
            t = (ln["acct_type"] or "").strip().lower()
            (cash_lines if t in CASH_ACCOUNT_TYPES else cat_lines).append(ln)

        basis = cash_lines or cat_lines
        cash_amount = sum(float(ln["amount"] or 0.0) for ln in basis)

        ranked = sorted(cat_lines or lines, key=lambda ln: abs(float(ln["amount"] or 0.0)), reverse=True)
        dominant = ranked[0] if ranked else lines[0]
        categories = sorted({(ln["category"] or "uncategorized") for ln in (cat_lines or lines)})

        view.append({
            "qb_txn_id": qb_txn_id,
            "qb_line_id": dominant["qb_line_id"],
            "entity_id": next((ln["entity_id"] for ln in lines if ln["entity_id"]), None),
            "date": d,
            "raw_date": lines[0]["txn_date"],
            "amount": cash_amount,
            "category": dominant["category"] or "uncategorized",
            "all_categories": categories,
            "is_split": len(cat_lines) > 1,
            "memo": dominant["memo"] or "",
            "vendor": dominant["vendor_name"] or "",
            "txn_type": lines[0]["txn_type"],
            "line_count": len(lines),
        })
    return view


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def _tokens(*texts):
    out = set()
    for t in texts:
        for tok in re.findall(r"[a-z0-9]+", (t or "").lower()):
            if len(tok) >= 3 and tok not in _MEMO_STOPWORDS:
                out.add(tok)
    return out


def _text_similarity(bank, qb):
    a = _tokens(bank["memo"], bank["counterparty"])
    b = _tokens(qb["memo"], qb["vendor"])
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _score(bank, qb, date_tolerance):
    """Higher is better. Date proximity dominates; memo overlap breaks ties."""
    if bank["date"] is None or qb["date"] is None:
        delta = None
        date_score = 0.3                       # undated: matchable but never preferred
    else:
        delta = abs((bank["date"] - qb["date"]).days)
        if delta > date_tolerance:
            return None, None
        date_score = 1.0 - (delta / (date_tolerance + 1))
    amount_score = 1.0 if abs(bank["amount"] - qb["amount"]) < 0.005 else 0.5
    return (date_score * 2.0) + _text_similarity(bank, qb) + amount_score, delta


def match(bank_rows, qb_rows, date_tolerance, amount_tolerance):
    """Globally greedy one-to-one matching: best-scoring pairs claim first.

    Bucketed on amount in cents so this stays near-linear instead of comparing
    every bank row against every QB row — at 7 entities and a few years of
    statements the quadratic version gets slow enough to discourage re-running,
    and this report is only useful if it's cheap to re-run after every ingest.
    """
    buckets = defaultdict(list)
    for qb in qb_rows:
        buckets[round(qb["amount"] * 100)].append(qb)

    window = int(round(amount_tolerance * 100))
    pairs = []
    for bank in bank_rows:
        key = round(bank["amount"] * 100)
        seen = set()
        for offset in range(-window, window + 1):
            for qb in buckets.get(key + offset, ()):
                if id(qb) in seen:
                    continue
                seen.add(id(qb))
                if abs(bank["amount"] - qb["amount"]) > amount_tolerance + 1e-9:
                    continue
                if bank["entity_id"] and qb["entity_id"] and bank["entity_id"] != qb["entity_id"]:
                    continue
                score, delta = _score(bank, qb, date_tolerance)
                if score is not None:
                    pairs.append((score, delta, bank, qb))

    pairs.sort(key=lambda p: -p[0])
    used_bank, used_qb, matched = set(), set(), []
    for score, delta, bank, qb in pairs:
        if bank["txn_id"] in used_bank or qb["qb_txn_id"] in used_qb:
            continue
        used_bank.add(bank["txn_id"])
        used_qb.add(qb["qb_txn_id"])
        matched.append({"bank": bank, "qb": qb, "score": score, "date_delta_days": delta})

    unmatched_bank = [b for b in bank_rows if b["txn_id"] not in used_bank]
    unmatched_qb = [q for q in qb_rows if q["qb_txn_id"] not in used_qb]
    return matched, unmatched_bank, unmatched_qb


def classify(matched, unmatched_bank, unmatched_qb):
    """Turn match results into the three PROMPT.md mismatch types."""
    findings = []

    for m in matched:
        b, q = m["bank"], m["qb"]
        if b["category"] == q["category"]:
            continue
        if q["is_split"] and b["category"] in q["all_categories"]:
            continue     # bank matched one leg of a split — not a disagreement
        note = "bank side uncategorized: taxonomy gap, not a QuickBooks disagreement" \
            if b["category"] == "uncategorized" else \
            ("QB transaction is a split across " + ", ".join(q["all_categories"]) if q["is_split"] else "")
        findings.append({
            "mismatch_type": "category_mismatch",
            "entity_id": b["entity_id"] or q["entity_id"],
            "amount": b["amount"],
            "txn_id": b["txn_id"], "qb_txn_id": q["qb_txn_id"], "qb_line_id": q["qb_line_id"],
            "bank_date": b["raw_date"], "qb_date": q["raw_date"],
            "date_delta_days": m["date_delta_days"],
            "bank_category": b["category"], "qb_category": q["category"],
            "bank_memo": b["memo"], "qb_memo": q["memo"] or q["vendor"],
            "notes": note,
        })

    for b in unmatched_bank:
        findings.append({
            "mismatch_type": "missing_in_qb",
            "entity_id": b["entity_id"], "amount": b["amount"],
            "txn_id": b["txn_id"], "qb_txn_id": None, "qb_line_id": None,
            "bank_date": b["raw_date"], "qb_date": None, "date_delta_days": None,
            "bank_category": b["category"], "qb_category": None,
            "bank_memo": b["memo"], "qb_memo": None,
            "notes": "cash moved, never booked" + ("" if b["date"] else " (unparseable bank date — verify before acting)"),
        })

    for q in unmatched_qb:
        findings.append({
            "mismatch_type": "missing_in_bank",
            "entity_id": q["entity_id"], "amount": q["amount"],
            "txn_id": None, "qb_txn_id": q["qb_txn_id"], "qb_line_id": q["qb_line_id"],
            "bank_date": None, "qb_date": q["raw_date"], "date_delta_days": None,
            "bank_category": None, "qb_category": q["category"],
            "bank_memo": None, "qb_memo": q["memo"] or q["vendor"],
            "notes": f"booked ({q['txn_type']}), no matching cash movement",
        })

    return findings


# ---------------------------------------------------------------------------
# Persistence + reporting
# ---------------------------------------------------------------------------

def persist(conn, findings, run_id, start, end):
    """Write findings, carrying forward resolved=1 for findings seen before.

    Without carry-forward, every re-run resurrects everything already
    investigated and the report becomes noise you learn to ignore.
    """
    resolved = {
        (r["mismatch_type"], r["txn_id"], r["qb_txn_id"], r["qb_line_id"])
        for r in conn.execute("SELECT mismatch_type, txn_id, qb_txn_id, qb_line_id "
                              "FROM reconciliation_results WHERE resolved = 1")
    }
    now = datetime.now().isoformat(timespec="seconds")
    conn.executemany("""
        INSERT INTO reconciliation_results
        (run_id, run_date, period_start, period_end, mismatch_type, entity_id, amount,
         txn_id, qb_txn_id, qb_line_id, bank_date, qb_date, date_delta_days,
         bank_category, qb_category, bank_memo, qb_memo, resolved, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, [(
        run_id, now, start, end, f["mismatch_type"], f["entity_id"], f["amount"],
        f["txn_id"], f["qb_txn_id"], f["qb_line_id"], f["bank_date"], f["qb_date"],
        f["date_delta_days"], f["bank_category"], f["qb_category"], f["bank_memo"],
        f["qb_memo"],
        1 if (f["mismatch_type"], f["txn_id"], f["qb_txn_id"], f["qb_line_id"]) in resolved else 0,
        f["notes"],
    ) for f in findings])
    conn.commit()


def write_csv(findings, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "qb_bank_reconciliation.csv"
    cols = ["mismatch_type", "entity_id", "amount", "txn_id", "qb_txn_id", "bank_date",
            "qb_date", "date_delta_days", "bank_category", "qb_category",
            "bank_memo", "qb_memo", "notes"]
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for f in sorted(findings, key=lambda x: -abs(x["amount"] or 0)):
            w.writerow(f)
    return path


def report(findings, matched_count, bank_count, qb_count):
    """Dollars, not row counts — per PROMPT.md."""
    print(f"\nReconciliation: {bank_count} bank/card transactions vs "
          f"{qb_count} QuickBooks transactions — {matched_count} matched.\n")

    labels = {
        "missing_in_qb": "1. IN BANK, NOT IN QUICKBOOKS  (cash moved, never booked)",
        "missing_in_bank": "2. IN QUICKBOOKS, NOT IN BANK  (booked, no cash movement)",
        "category_mismatch": "3. MATCHED, CATEGORIZED DIFFERENTLY",
    }
    for mtype, label in labels.items():
        group = [f for f in findings if f["mismatch_type"] == mtype]
        total = sum(abs(f["amount"] or 0) for f in group)
        print(f"{label}")
        print(f"   ${total:,.2f} across {len(group)} transactions")
        by_entity = defaultdict(float)
        for f in group:
            by_entity[f["entity_id"] or "(unassigned)"] += abs(f["amount"] or 0)
        for ent, amt in sorted(by_entity.items(), key=lambda kv: -kv[1]):
            print(f"      {ent:<16} ${amt:>14,.2f}")
        for f in sorted(group, key=lambda x: -abs(x["amount"] or 0))[:5]:
            memo = (f["bank_memo"] or f["qb_memo"] or "")[:52]
            print(f"      ${abs(f['amount'] or 0):>12,.2f}  {f['bank_date'] or f['qb_date']}  {memo}")
        print()


# ---------------------------------------------------------------------------
# Mock seeding — exercises the matching logic before real data lands
# ---------------------------------------------------------------------------

def seed_mock(conn):
    """Plant a controlled scenario with one defect of each type, so the matching
    logic can be verified now and re-verified after any change to it."""
    conn.executescript((Path(__file__).resolve().parent.parent / "db" / "schema.sql").read_text())
    for t in ("transactions", "qb_transactions", "qb_accounts", "reconciliation_results",
              "accounts", "entities"):
        conn.execute(f"DELETE FROM {t}")

    conn.executemany("INSERT INTO entities (entity_id, legal_name, dot_number) VALUES (?,?,?)",
                     [("ZONE", "Zone LLC", "3456354"), ("XTRACK", "Xtrack LLC", "4086204")])
    conn.executemany("INSERT INTO accounts (account_id, entity_id, account_type, institution, last4) VALUES (?,?,?,?,?)",
                     [("ZONE_CHASE_OP", "ZONE", "checking", "Chase", "1122"),
                      ("XTRACK_CHASE_OP", "XTRACK", "checking", "Chase", "3344")])
    conn.executemany("INSERT INTO qb_accounts (qb_account_id, realm_id, name, account_type, account_subtype) VALUES (?,?,?,?,?)",
                     [("60", "R1", "Chase Operating", "Bank", "Checking"),
                      ("81", "R1", "Fuel", "Expense", "FuelExpense"),
                      ("82", "R1", "Truck Repairs", "Expense", "RepairMaintenance"),
                      ("83", "R1", "Tolls", "Expense", "TravelExpense")])

    bank = [
        # (date, amount, memo, category, entity)  -- expected: clean match
        ("2026-01-05", -1240.50, "PILOT TRAVEL CTR 442 FUEL", "fuel", "ZONE"),
        # expected: match with a 2-day date drift
        ("2026-01-09", -3800.00, "MIDWEST TRUCK REPAIR UNIT 214", "maintenance", "ZONE"),
        # expected: category_mismatch (bank says tolls, QB booked to fuel)
        ("2026-01-12", -286.75, "PREPASS TOLL CHARGES", "tolls", "ZONE"),
        # expected: missing_in_qb — cash moved, nothing booked
        ("2026-01-18", -9500.00, "WIRE OUT REF 88213", "uncategorized", "ZONE"),
        # expected: clean match on the other entity
        ("2026-01-22", -1875.25, "LOVES TRAVEL STOP 318", "fuel", "XTRACK"),
    ]
    conn.executemany("""INSERT INTO transactions
        (source_file, account_id, entity_id, txn_date, amount, raw_memo, counterparty, category, is_intercompany)
        VALUES (?,?,?,?,?,?,?,?,0)""",
        [("mock.csv", f"{e}_CHASE_OP", e, d, a, m, m, c) for d, a, m, c, e in bank])

    # QB side: each line pair is (expense line, bank line) for one transaction.
    qb = [
        ("QB1001", "2026-01-05", -1240.50, "81", "Fuel", "fuel", "ZONE", "Pilot Travel Centers", "Purchase"),
        ("QB1002", "2026-01-07", -3800.00, "82", "Truck Repairs", "maintenance", "ZONE", "Midwest Truck Repair", "Bill"),
        ("QB1003", "2026-01-12", -286.75, "81", "Fuel", "fuel", "ZONE", "PrePass", "Purchase"),
        ("QB1004", "2026-01-22", -1875.25, "81", "Fuel", "fuel", "XTRACK", "Loves Travel Stop", "Purchase"),
        # expected: missing_in_bank — booked, but no cash ever moved
        ("QB1005", "2026-01-25", -4400.00, "82", "Truck Repairs", "maintenance", "ZONE", "Diesel Doctor LLC", "Bill"),
    ]
    rows = []
    for txn_id, d, amt, acct, acct_name, cat, ent, vendor, ttype in qb:
        rows.append((txn_id, "1", "R1", ttype, d, amt, acct, acct_name, ent, cat, vendor, f"{vendor} invoice"))
        rows.append((txn_id, "2", "R1", ttype, d, amt, "60", "Chase Operating", ent, None, vendor, "cash leg"))
    conn.executemany("""INSERT INTO qb_transactions
        (qb_txn_id, qb_line_id, realm_id, txn_type, txn_date, amount, qb_account_id,
         qb_account_name, entity_id, category, vendor_name, memo, source_report, ingested_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'mock',datetime('now'))""", rows)
    conn.commit()
    print("Seeded mock scenario: 5 bank transactions, 5 QuickBooks transactions (10 GL lines).")
    print("Expected findings: 1 missing_in_qb, 1 missing_in_bank, 1 category_mismatch, 3 clean matches.\n")


# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=str(DB_PATH))
    p.add_argument("--period", help="single month, YYYY-MM")
    p.add_argument("--period-start")
    p.add_argument("--period-end")
    p.add_argument("--entity", help="restrict to one entity_id")
    p.add_argument("--date-tolerance", type=int, default=DEFAULT_DATE_TOLERANCE_DAYS)
    p.add_argument("--amount-tolerance", type=float, default=DEFAULT_AMOUNT_TOLERANCE)
    p.add_argument("--include-intercompany", action="store_true",
                   help="include matched intercompany transfers (excluded by default)")
    p.add_argument("--seed-mock", action="store_true",
                   help="wipe the target db and plant a known scenario to verify matching logic")
    p.add_argument("--out-dir", default=str(OUT_DIR))
    args = p.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    if args.seed_mock:
        seed_mock(conn)

    start, end = _period_bounds(args)
    bank_rows = load_bank_side(conn, start, end, args.entity, args.include_intercompany)
    qb_rows = build_qb_cash_view(conn, start, end, args.entity)

    if not qb_rows:
        print("No QuickBooks data in qb_transactions — run ingest_quickbooks.py first "
              "(or --seed-mock to exercise the matching logic without real data).")
        if not bank_rows:
            conn.close()
            return
        print(f"Bank side has {len(bank_rows)} transactions waiting to reconcile.")
        conn.close()
        return

    matched, unmatched_bank, unmatched_qb = match(
        bank_rows, qb_rows, args.date_tolerance, args.amount_tolerance)
    findings = classify(matched, unmatched_bank, unmatched_qb)

    run_id = uuid.uuid4().hex[:12]
    persist(conn, findings, run_id, start, end)
    path = write_csv(findings, Path(args.out_dir))
    report(findings, len(matched), len(bank_rows), len(qb_rows))
    print(f"Run {run_id} — {len(findings)} findings written to {path}")
    print("Mark a finding investigated with: "
          "UPDATE reconciliation_results SET resolved=1 WHERE recon_id=<id>;")
    conn.close()


if __name__ == "__main__":
    main()
