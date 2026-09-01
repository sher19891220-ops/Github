"""
QuickBooks bank-feed exports (the "Bank_of_America*.csv" files).

These are NOT bank statements, and treating them as one is the mistake this
module exists to prevent. They are the QuickBooks *banking feed* view exported
to CSV, which makes them a genuinely different source with a different meaning:

  * they carry QuickBooks' CATEGORY for each transaction, which the PDF
    statements do not. That is the QB side of the dual-source reconciliation,
    already sitting in the intake.
  * they carry the POSTING STATE. A file whose last column is
    "Transaction Posted" holds rows QuickBooks has accepted into the ledger
    ("Added to: ..." / "Matched to: ..."). A file whose last column is
    "Match/Categorize" holds the FOR REVIEW queue -- the bank saw the money
    move, the books have not recorded it. Those rows ARE the missing_in_qb
    population; they are not a parse defect and must not be merged in as
    though they were posted.
  * they have NO beginning/ending balance and no running balance, so the
    statement-total control cannot run on them. Nothing here is verified in
    the sense the 147 parsed PDFs are verified, and every row is stamped
    accordingly rather than quietly mixed in.
  * an export of exactly 300 rows hit the UI's page cap. The file is a
    truncated view of the account, not the account. Summing it gives a
    number that looks like a total and is not one.

Three header shapes appear across the corpus:

    date, Bank description, Spent, Received, From/To, Transaction Posted
    Date, Bank description, Spent, Received, From/To, Match/Categorize
    date, Bank description, Amount,          From/To, Transaction Posted

Spent/Received are unsigned and the COLUMN carries the sign. The Amount
variant prints the sign already ("-$93.51"). Same trap as the PDFs: multiply
the two and a debit comes back as income.

Usage:
    python ingest/ingest_qb_bankfeed.py <folder> --out qb_bankfeed.csv
"""
import argparse
import csv
import re
from datetime import datetime
from pathlib import Path

PAGE_CAP = 300          # QuickBooks' export page size; exactly this many rows
                        # means the export was cut off, not that the account
                        # holds exactly 300 transactions.

# "Added to:  Expense: Travel:Taxis or shared rides 12/06/2024 $74.84"
POSTED = re.compile(
    r"^\s*(Added|Matched)\s+to:\s*(.+?)\s+\d{1,2}/\d{1,2}/\d{4}\s+-?\$[\d,]+\.\d{2}\s*$",
    re.I)
# counterparty account when QuickBooks names a transfer target
TRANSFER_ACCT = re.compile(r"-\s*(\d{4})\s*-")


def money(s):
    s = (s or "").strip().replace("$", "").replace(",", "")
    if not s:
        return None
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def parse_posting(cell, pending):
    """Return (qb_status, qb_action, qb_account_path).

    In a pending file the cell is the bare suggested category, or empty when
    QuickBooks has no suggestion at all -- the least-known state in the corpus
    and the one most likely to be a real leak."""
    cell = (cell or "").strip()
    if pending:
        return ("for_review", "", cell)
    m = POSTED.match(cell)
    if m:
        return ("posted", m.group(1).lower(), m.group(2).strip())
    return ("unknown", "", cell)


def load(path: Path):
    with path.open(encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        return [], {}
    cols = {c.lower(): c for c in rows[0]}
    date_c = cols.get("date")
    desc_c = cols.get("bank description")
    last_c = cols.get("transaction posted") or cols.get("match/categorize")
    pending = "match/categorize" in cols
    amt_c = cols.get("amount")
    spent_c, recv_c = cols.get("spent"), cols.get("received")

    out = []
    for r in rows:
        raw_date = (r.get(date_c) or "").strip()
        try:
            d = datetime.strptime(raw_date, "%m/%d/%Y").date().isoformat()
        except ValueError:
            continue

        if amt_c:
            # sign is printed; trust it
            amount = money(r.get(amt_c))
        else:
            spent, recv = money(r.get(spent_c)), money(r.get(recv_c))
            # the column is the sign. abs() so a source that also prints a
            # minus in the Spent column cannot double-negate into income.
            amount = -abs(spent) if spent else (abs(recv) if recv else None)
        if amount is None:
            continue

        status, action, acct_path = parse_posting(r.get(last_c), pending)
        desc = (r.get(desc_c) or "").strip()
        ctr = TRANSFER_ACCT.search(r.get(last_c) or "")
        out.append({
            "source_file": path.name,
            "source_path": str(path),
            "txn_date": d,
            "amount": round(amount, 2),
            "description": desc,
            "counterparty": (r.get(cols.get("from/to", "")) or "").strip(),
            "qb_status": status,
            "qb_action": action,
            "qb_account_path": acct_path,
            "transfer_counter_acct": ctr.group(1) if ctr else "",
            "control": "none",          # no balance pair exists for these
            "truncated_export": "yes" if len(rows) == PAGE_CAP else "no",
        })
    meta = {"rows_in_file": len(rows), "parsed": len(out), "pending": pending,
            "truncated": len(rows) == PAGE_CAP}
    return out, meta


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("--glob", default="Bank_of_America*.csv")
    ap.add_argument("--out", default="data/processed/qb_bankfeed.csv")
    args = ap.parse_args()

    files = sorted(Path(args.folder).rglob(args.glob))
    allrows, truncated = [], []
    print(f"{'file':<28}{'rows':>7}{'parsed':>8}  state")
    print("-" * 62)
    for f in files:
        rows, meta = load(f)
        allrows += rows
        if meta.get("truncated"):
            truncated.append(f.name)
        state = "FOR REVIEW queue" if meta.get("pending") else "posted"
        if meta.get("truncated"):
            state += "  [TRUNCATED at page cap]"
        print(f"{f.name:<28}{meta.get('rows_in_file', 0):>7}{meta.get('parsed', 0):>8}  {state}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cols = ["source_file", "source_path", "txn_date", "amount", "description",
            "counterparty", "qb_status", "qb_action", "qb_account_path",
            "transfer_counter_acct", "control", "truncated_export"]
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(allrows)

    posted = [r for r in allrows if r["qb_status"] == "posted"]
    review = [r for r in allrows if r["qb_status"] == "for_review"]
    unknown = [r for r in allrows if r["qb_status"] == "unknown"]
    print(f"\n{len(allrows):,} rows -> {out}")
    print(f"  posted to the ledger : {len(posted):,}")
    print(f"  in the FOR REVIEW queue (bank saw it, books did not): {len(review):,}"
          f"   ${sum(abs(r['amount']) for r in review):,.2f}")
    if unknown:
        print(f"  unparsed posting state: {len(unknown):,}")
    blank = [r for r in review if not r["qb_account_path"]]
    if blank:
        print(f"  of those, {len(blank):,} with no suggested category at all: "
              f"${sum(abs(r['amount']) for r in blank):,.2f}")
    if truncated:
        print(f"\n  TRUNCATED exports (exactly {PAGE_CAP} rows -- re-export these, "
              f"totals from them are not totals):")
        for n in truncated:
            print(f"    {n}")
    print("\n  control: none. No balance pair exists for these files, so the "
          "statement-total control cannot run on them.")


if __name__ == "__main__":
    main()
