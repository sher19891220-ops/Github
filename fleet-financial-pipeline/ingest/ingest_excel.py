"""
Ingest bank/card statements exported as Excel or CSV into the transactions table.
Handles the common column-naming variants banks use.
Usage: python ingest_excel.py <filepath> <account_id> <entity_id>
"""
import sys
import sqlite3
import pandas as pd
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parent.parent))
from taxonomy.categorize import classify, extract_unit_number

DB_PATH = Path(__file__).resolve().parent.parent / "db" / "fleet_financials.db"

# Common column name variants across banks/exports — extend as you hit new formats
DATE_COLS = ["date", "transaction date", "posted date", "posting date"]
AMOUNT_COLS = ["amount", "transaction amount"]
DEBIT_COLS = ["debit", "withdrawal"]
CREDIT_COLS = ["credit", "deposit"]
MEMO_COLS = ["description", "memo", "narrative", "details", "transaction description"]


def _find_col(columns, candidates):
    cols_lower = {c.lower().strip(): c for c in columns}
    for cand in candidates:
        if cand in cols_lower:
            return cols_lower[cand]
    return None


def ingest_excel(filepath: str, account_id: str, entity_id: str):
    filepath = Path(filepath)
    df = pd.read_excel(filepath) if filepath.suffix.lower() in (".xlsx", ".xls") else pd.read_csv(filepath)
    df.columns = [str(c).strip() for c in df.columns]

    date_col = _find_col(df.columns, DATE_COLS)
    memo_col = _find_col(df.columns, MEMO_COLS)
    amount_col = _find_col(df.columns, AMOUNT_COLS)
    debit_col = _find_col(df.columns, DEBIT_COLS)
    credit_col = _find_col(df.columns, CREDIT_COLS)

    if not date_col or not memo_col:
        raise ValueError(f"Could not detect date/memo columns in {filepath.name}. "
                          f"Found columns: {list(df.columns)}. Add the variant to DATE_COLS/MEMO_COLS.")

    rows = []
    for _, r in df.iterrows():
        memo = str(r.get(memo_col, "") or "")
        if amount_col:
            amt = r.get(amount_col)
        else:
            debit = r.get(debit_col) if debit_col else None
            credit = r.get(credit_col) if credit_col else None
            amt = (float(credit) if pd.notna(credit) else 0) - (float(debit) if pd.notna(debit) else 0)
        if pd.isna(amt):
            continue
        amt = float(amt)
        # Amount is passed so inflows can be told from outflows: without the sign
        # an incoming factoring advance categorizes as a factoring fee, which is
        # the entire revenue line booked as an expense.
        c = classify(memo, amt)
        rows.append((
            filepath.name, account_id, entity_id, str(r.get(date_col)),
            amt, memo, memo,  # counterparty defaults to raw memo; clean later
            extract_unit_number(memo), c.category, 0, None,
            "uncategorized" if c.category == "uncategorized"
            else ("anomaly" if c.confidence == "medium" else None)
        ))

    conn = sqlite3.connect(DB_PATH)
    conn.executemany("""
        INSERT INTO transactions
        (source_file, account_id, entity_id, txn_date, amount, raw_memo, counterparty,
         unit_number, category, is_intercompany, intercompany_pair_id, review_flag)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    """, rows)
    conn.commit()
    conn.close()
    print(f"Ingested {len(rows)} transactions from {filepath.name} -> {account_id}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python ingest_excel.py <filepath> <account_id> <entity_id>")
        sys.exit(1)
    ingest_excel(sys.argv[1], sys.argv[2], sys.argv[3])
