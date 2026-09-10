"""
N-way P&L and mileage reconciliation across every source.

Google Sheets (hand-maintained), QuickBooks (GL), bank/card (cash movement),
QuickManage/Samsara (odometer). Four sources is six pairwise comparisons, which
is the wrong shape — instead each source normalizes into pnl_observations /
odometer_readings and this compares them once, N-way.

The most useful output is `outlier_source`: when two sources agree and one does
not, the odd one out is named. That is a far stronger signal than "these two
numbers differ", because agreement between an independent cash feed and a GL is
hard to achieve by accident.

Usage:
    python analysis/reconcile_all_sources.py derive-bank --dsn "$DSN"   # bank -> observations
    python analysis/reconcile_all_sources.py pnl        --dsn "$DSN"
    python analysis/reconcile_all_sources.py mileage    --dsn "$DSN"
    python analysis/reconcile_all_sources.py pnl --entity ZONE --min-spread 500
"""
import argparse
import sys
from collections import defaultdict


def connect(args):
    if args.dsn:
        import psycopg2
        return psycopg2.connect(args.dsn)
    raise SystemExit("This report needs Postgres (--dsn). The N-way views live in "
                     "the finance schema; see db/postgres/004_multi_source.sql.")


def derive_bank(conn):
    """Roll categorized bank/card transactions into the same observation shape.

    Marked is_stated = false: this is computed from cash movement, not asserted
    by anyone. Matched intercompany transfers are excluded — internal movement is
    not a P&L line, and a Sheets P&L would never have counted it either.
    """
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO finance.pnl_observations
            (source, source_detail, entity_id, month, category, amount, is_stated)
        SELECT 'bank', 'derived_from_transactions', entity_id,
               DATE_TRUNC('month', txn_date)::date,
               COALESCE(category, 'uncategorized'),
               SUM(amount)::numeric(14,2), false
        FROM finance.transactions
        WHERE NOT is_intercompany
        GROUP BY entity_id, DATE_TRUNC('month', txn_date), COALESCE(category, 'uncategorized')
        ON CONFLICT (source, source_detail, entity_id, month, category)
        DO UPDATE SET amount = EXCLUDED.amount, loaded_at = now()
    """)
    n = cur.rowcount
    conn.commit()
    print(f"Derived {n} bank observations from categorized transactions.")
    return n


def pnl_report(conn, entity=None, min_spread=0.0, month=None, limit=40):
    cur = conn.cursor()
    where, params = ["1=1"], []
    if entity:
        where.append("entity_id = %s"); params.append(entity)
    if month:
        where.append("month = %s"); params.append(month)
    cur.execute(f"""
        SELECT entity_id, month, category, gsheets, quickbooks, bank,
               sources_present, spread, spread_pct, status, outlier_source
        FROM finance.v_pnl_source_variance
        WHERE {' AND '.join(where)}
        ORDER BY spread DESC NULLS LAST
    """, params)
    rows = cur.fetchall()
    if not rows:
        print("No P&L observations loaded. Run `derive-bank` and the Sheets/QuickBooks "
              "ingests first.")
        return []

    by_status = defaultdict(lambda: [0, 0.0])
    for r in rows:
        by_status[r[9]][0] += 1
        by_status[r[9]][1] += float(r[7] or 0)

    print(f"\nP&L source reconciliation — {len(rows)} entity/month/category cells\n")
    print(f"{'status':<26}{'cells':>8}{'disagreement $':>18}")
    print("-" * 52)
    for status in ("three_way_disagreement", "disagreement", "single_source", "agree"):
        if status in by_status:
            n, dollars = by_status[status]
            print(f"{status:<26}{n:>8}{dollars:>18,.2f}")

    flagged = [r for r in rows if r[9] in ("three_way_disagreement", "disagreement")
               and float(r[7] or 0) >= min_spread]
    if flagged:
        print(f"\nLargest disagreements (>= ${min_spread:,.0f}):\n")
        print(f"{'entity':<11}{'month':<11}{'category':<22}{'sheets':>13}{'quickbooks':>13}"
              f"{'bank':>13}{'spread':>12}  outlier")
        print("-" * 106)
        for r in flagged[:limit]:
            ent, mo, cat, gs, qb, bk, _, sp, spct, _, outlier = r
            f = lambda v: f"{float(v):,.2f}" if v is not None else "—"
            print(f"{ent:<11}{str(mo):<11}{cat[:21]:<22}{f(gs):>13}{f(qb):>13}{f(bk):>13}"
                  f"{float(sp):>12,.2f}  {outlier or '(all differ)'}")

    single = [r for r in rows if r[9] == "single_source"]
    if single:
        gaps = defaultdict(float)
        for r in single:
            present = "sheets" if r[3] is not None else ("quickbooks" if r[4] is not None else "bank")
            gaps[present] += abs(float(r[3] or r[4] or r[5] or 0))
        print(f"\nCells present in only ONE source — nothing to check them against:")
        for src, amt in sorted(gaps.items(), key=lambda kv: -kv[1]):
            print(f"   only in {src:<12} ${amt:>16,.2f}")
    return flagged


def mileage_report(conn, limit=30):
    cur = conn.cursor()
    cur.execute("""SELECT source, anomaly, COUNT(*), MIN(reading_date), MAX(reading_date)
                   FROM finance.v_odometer_anomalies
                   WHERE anomaly IS NOT NULL GROUP BY 1,2 ORDER BY 3 DESC""")
    anomalies = cur.fetchall()
    if anomalies:
        print("\nOdometer anomalies — fix before trusting any per-mile number\n")
        print(f"{'source':<14}{'anomaly':<22}{'count':>7}  date range")
        print("-" * 68)
        for src, an, n, d0, d1 in anomalies:
            print(f"{src:<14}{an:<22}{n:>7}  {d0} .. {d1}")

    cur.execute("""SELECT unit_number, month, gsheets_miles, quickmanage_miles, samsara_miles,
                          spread_miles, sources_present, preferred_source, preferred_miles
                   FROM finance.v_mileage_variance
                   WHERE sources_present > 1 AND spread_miles > 0
                   ORDER BY spread_miles DESC""")
    rows = cur.fetchall()
    print(f"\nMileage disagreement across sources — {len(rows)} unit-months differ\n")
    if rows:
        print(f"{'unit':<8}{'month':<12}{'sheets':>10}{'quickmanage':>13}{'samsara':>10}"
              f"{'spread':>10}{'pref':>13}")
        print("-" * 78)
        for u, mo, gs, qm, sm, sp, _, pref, _ in rows[:limit]:
            f = lambda v: f"{float(v):,.0f}" if v is not None else "—"
            print(f"{u:<8}{str(mo):<12}{f(gs):>10}{f(qm):>13}{f(sm):>10}{float(sp):>10,.0f}{pref:>13}")
        worst = float(rows[0][5])
        print(f"\n  Largest single-month gap: {worst:,.0f} miles. Cost-per-mile is linear in "
              f"mileage,\n  so a gap of this size moves that unit's cost-per-mile by the same "
              f"percentage.")

    cur.execute("""SELECT COUNT(*) FROM finance.v_mileage_variance WHERE sources_present = 1""")
    solo = cur.fetchone()[0]
    if solo:
        print(f"\n  {solo} unit-months have only one mileage source — unverifiable.")
    return rows


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--dsn")
    sub.add_parser("derive-bank", parents=[common])
    pr = sub.add_parser("pnl", parents=[common])
    pr.add_argument("--entity")
    pr.add_argument("--month")
    pr.add_argument("--min-spread", type=float, default=0.0)
    pr.add_argument("--strict", action="store_true", help="exit 1 if any disagreement found")
    sub.add_parser("mileage", parents=[common])
    args = p.parse_args()

    conn = connect(args)
    if args.cmd == "derive-bank":
        derive_bank(conn)
    elif args.cmd == "pnl":
        flagged = pnl_report(conn, args.entity, args.min_spread, args.month)
        if args.strict and flagged:
            conn.close(); sys.exit(1)
    else:
        mileage_report(conn)
    conn.close()


if __name__ == "__main__":
    main()
