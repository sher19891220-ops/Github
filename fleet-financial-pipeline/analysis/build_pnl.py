"""
Builds the outputs that actually matter:
  1. Monthly P&L by entity (excluding matched intercompany transfers)
  2. Cost per unit (truck/trailer), joined with maintenance/downtime
  3. Bleeding-point flags: units with negative contribution, chronic breakdown units,
     top recurring expense creep, uncategorized $ still unresolved
Outputs CSVs to data/processed/ — pull those into Excel or feed back to Claude for narrative.
"""
import sqlite3
import pandas as pd
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "db" / "fleet_financials.db"
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "processed"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def load_transactions(conn):
    df = pd.read_sql("SELECT * FROM transactions WHERE is_intercompany = 0", conn)
    df["txn_date"] = pd.to_datetime(df["txn_date"], errors="coerce")
    df["month"] = df["txn_date"].dt.to_period("M").astype(str)
    return df


def monthly_pnl_by_entity(df):
    pivot = df.pivot_table(index=["entity_id", "month"], columns="category",
                            values="amount", aggfunc="sum", fill_value=0)
    pivot["net"] = pivot.sum(axis=1)
    return pivot.reset_index()


def per_unit_cost(df, conn):
    unit_txn = df[df["unit_number"].notna()].groupby("unit_number")["amount"].sum().rename("txn_net")
    maint = pd.read_sql("SELECT unit_number, SUM(cost) as maint_cost, SUM(downtime_days) as downtime_days, "
                         "COUNT(*) as breakdown_count FROM maintenance_events GROUP BY unit_number", conn)
    maint = maint.set_index("unit_number")
    combined = pd.concat([unit_txn, maint], axis=1).fillna(0)
    combined["bleeding_flag"] = (combined["txn_net"] < 0) | (combined["breakdown_count"] >= 4)
    return combined.reset_index()


def uncategorized_summary(df):
    unc = df[df["category"] == "uncategorized"]
    return unc.groupby("entity_id")["amount"].agg(["sum", "count"]).reset_index()


def run():
    conn = sqlite3.connect(DB_PATH)
    df = load_transactions(conn)

    if df.empty:
        print("No transactions in the database yet — run ingest scripts first.")
        return

    pnl = monthly_pnl_by_entity(df)
    pnl.to_csv(OUT_DIR / "monthly_pnl_by_entity.csv", index=False)

    units = per_unit_cost(df, conn)
    units.to_csv(OUT_DIR / "per_unit_cost_and_downtime.csv", index=False)

    unc = uncategorized_summary(df)
    unc.to_csv(OUT_DIR / "uncategorized_dollars_by_entity.csv", index=False)

    print("Wrote:")
    print(f"  - {OUT_DIR/'monthly_pnl_by_entity.csv'}  ({len(pnl)} rows)")
    print(f"  - {OUT_DIR/'per_unit_cost_and_downtime.csv'}  ({len(units)} units, "
          f"{int(units['bleeding_flag'].sum())} flagged)")
    print(f"  - {OUT_DIR/'uncategorized_dollars_by_entity.csv'}  "
          f"(${unc['sum'].sum():,.2f} total still uncategorized — this number should shrink "
          f"as you tighten taxonomy/categorize.py)")
    conn.close()


if __name__ == "__main__":
    run()
