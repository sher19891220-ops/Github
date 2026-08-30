"""
Ingest bank/card statements provided as PDF.
Bank PDFs vary wildly — this extracts tables where pdfplumber can find them,
and falls back to line-by-line regex parsing for statements without clean tables.
You WILL need to eyeball the first output per bank/card and adjust the regex —
that's normal, not a bug. Flag review rows land in review_flag='uncategorized'.

Usage: python ingest_pdf.py <filepath> <account_id> <entity_id>
"""
import sys
import re
import sqlite3
import pdfplumber
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parent.parent))
from taxonomy.categorize import categorize, extract_unit_number

DB_PATH = Path(__file__).resolve().parent.parent / "db" / "fleet_financials.db"

# Matches lines like: "03/14  AMAZON MKTPLACE PMTS   -128.40"  or  "03/14/25  ... 128.40-"
LINE_PATTERN = re.compile(
    r"(?P<date>\d{1,2}/\d{1,2}(?:/\d{2,4})?)\s+(?P<memo>.+?)\s+\$?(?P<amount>-?[\d,]+\.\d{2}-?)\s*$"
)


def _parse_amount(raw: str) -> float:
    neg = raw.strip().endswith("-") or raw.strip().startswith("-")
    val = float(raw.replace(",", "").replace("-", ""))
    return -val if neg else val


def ingest_pdf(filepath: str, account_id: str, entity_id: str):
    filepath = Path(filepath)
    rows = []

    with pdfplumber.open(filepath) as pdf:
        for page in pdf.pages:
            # Try table extraction first (works for clean tabular statements)
            for table in page.extract_tables() or []:
                for r in table:
                    if not r or len(r) < 2:
                        continue
                    line = " ".join(str(c) for c in r if c)
                    m = LINE_PATTERN.search(line)
                    if m:
                        rows.append(m.groupdict())
            # Fallback: raw text line scan
            text = page.extract_text() or ""
            for line in text.split("\n"):
                m = LINE_PATTERN.search(line)
                if m:
                    rows.append(m.groupdict())

    txns = []
    for r in rows:
        memo = r["memo"].strip()
        amt = _parse_amount(r["amount"])
        txns.append((
            filepath.name, account_id, entity_id, r["date"], amt, memo, memo,
            extract_unit_number(memo), categorize(memo), 0, None,
            "uncategorized" if categorize(memo) == "uncategorized" else None
        ))

    if not txns:
        print(f"WARNING: no transaction lines matched in {filepath.name}. "
              f"This bank's PDF layout needs a custom regex — inspect page.extract_text() output.")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.executemany("""
        INSERT INTO transactions
        (source_file, account_id, entity_id, txn_date, amount, raw_memo, counterparty,
         unit_number, category, is_intercompany, intercompany_pair_id, review_flag)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    """, txns)
    conn.commit()
    conn.close()
    print(f"Ingested {len(txns)} transactions from {filepath.name} -> {account_id} "
          f"({sum(1 for t in txns if t[8]=='uncategorized')} flagged for review)")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python ingest_pdf.py <filepath> <account_id> <entity_id>")
        sys.exit(1)
    ingest_pdf(sys.argv[1], sys.argv[2], sys.argv[3])
