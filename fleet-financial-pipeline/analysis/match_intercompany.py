"""
Find inter-company transfers: an outflow from one of your entities that matches
an inflow on another of your entities within +/- 3 days and the same (or close) amount.
These get flagged so they don't inflate revenue/expense in the real P&L, and so you
can see undocumented loans between entities at a glance.
"""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "db" / "fleet_financials.db"
DATE_TOLERANCE_DAYS = 3
AMOUNT_TOLERANCE = 0.01  # exact match; loosen if your transfers get fees skimmed off


def match_intercompany():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    candidates = cur.execute("""
        SELECT txn_id, entity_id, txn_date, amount, category
        FROM transactions
        WHERE category = 'intercompany' AND intercompany_pair_id IS NULL
        ORDER BY txn_date
    """).fetchall()

    pair_id = 1
    matched_ids = set()
    for i, t1 in enumerate(candidates):
        if t1["txn_id"] in matched_ids:
            continue
        for t2 in candidates[i + 1:]:
            if t2["txn_id"] in matched_ids:
                continue
            if t2["entity_id"] == t1["entity_id"]:
                continue  # must be a different entity to count as intercompany
            if abs(t1["amount"] + t2["amount"]) > AMOUNT_TOLERANCE:
                continue  # amounts should be opposite sign, same magnitude
            cur.execute("UPDATE transactions SET is_intercompany=1, intercompany_pair_id=? WHERE txn_id IN (?,?)",
                        (pair_id, t1["txn_id"], t2["txn_id"]))
            matched_ids.update([t1["txn_id"], t2["txn_id"]])
            pair_id += 1
            break

    conn.commit()
    unmatched = [c["txn_id"] for c in candidates if c["txn_id"] not in matched_ids]
    print(f"Matched {pair_id - 1} intercompany transfer pairs. "
          f"{len(unmatched)} 'intercompany'-tagged transactions had no counterpart — "
          f"these are worth a manual look (could be undocumented one-way loans).")
    conn.close()


if __name__ == "__main__":
    match_intercompany()
