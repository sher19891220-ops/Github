"""Worst-to-best maintenance/breakdown cost per truck and trailer, and
whether each unit is trending worse, trending better, or was a one-time hit.

Built on top of analysis/spend_picture.py's already-reconciled multi-source
charge data (2021-2026, every unit-attributed source in the corpus) --
nothing here re-parses or re-derives a dollar figure, it only ranks and
trends what spend_picture.py already produced.

HOW "TRENDING WORSE" IS DECIDED, AND WHY THIS WAY. A unit's monthly spend is
split at its own midpoint (by month count, not by date) into an earlier half
and a later half. That comparison, not a linear regression slope, is the
call, for a concrete reason: most units have long stretches of $0 months
between real repair events, and a regression line through mostly-zero data
with one $9,000 spike is dominated by the spike's position, not by whether
spend is genuinely climbing. Comparing two halves' TOTALS survives that.

    "one-time"   a single month is >= 60% of the unit's entire multi-year
                 total, or the unit has only ever had ONE priced month at
                 all -- a spike, not a pattern, however large
    "worsening"  later-half total > 1.5x earlier-half total (and not
                 already "one-time")
    "improving"  later-half total < 0.67x earlier-half total
    "steady"     everything else -- present in both halves, no strong swing

A unit with spend in only one HALF (all early or all late) is "one-time" if
that's also its only priced month, otherwise it falls to worsening/improving
by the same >=1.5x / <=0.67x test against a zero earlier or later half,
which correctly reads as "this got dramatically worse/better" rather than
being special-cased -- a truck silent for two years then hit five times in
the last quarter IS worsening, not a special case to hide.
"""
import sys
import warnings
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
warnings.filterwarnings("ignore")

import spend_picture as SP


def monthly_series(d, unit, unit_type):
    """Filtered by unit_type too, not just unit number -- a handful of units
    (e.g. truck 8093: 66 rows tagged 'truck' worth $33,539, one stray row
    tagged 'trailer' worth $237.50) have a mistagged row under the OTHER
    type. Without this filter that one row's presence pulled the unit's
    ENTIRE total into both the truck and trailer tables, double-counting it
    and misreporting it as a trailer too. The stray row is silently
    excluded, not reassigned -- it is not this module's job to decide which
    tag is right."""
    u = d[(d.unit == unit) & (d.unit_type == unit_type) & (d.borne_by == "company")]
    return u.groupby("month").amount.sum().sort_index()


def classify_trend(series):
    """series: month -> dollars, months with $0 or no charge simply absent."""
    months = series.index.tolist()
    if len(months) <= 1:
        return "one-time", (series.iloc[0] if len(series) else 0.0) / (series.sum() or 1)
    total = series.sum()
    biggest_month_share = series.max() / total if total else 0
    if biggest_month_share >= 0.60:
        return "one-time", biggest_month_share
    mid = len(months) // 2
    early = series.iloc[:mid].sum()
    late = series.iloc[mid:].sum()
    if early == 0 and late > 0:
        ratio = float("inf")
    elif late == 0:
        ratio = 0.0
    else:
        ratio = late / early
    if ratio >= 1.5:
        return "worsening", ratio
    if ratio <= 0.67:
        return "improving", ratio
    return "steady", ratio


def build(d):
    company = d[d.borne_by == "company"]
    cpm = SP.truck_cost_per_mile(d).set_index("unit")

    rows = []
    for unit_type in ("truck", "trailer"):
        units = sorted(company[company.unit_type == unit_type].unit.unique())
        for u in units:
            series = monthly_series(d, u, unit_type)
            total = series.sum()
            if total <= 0:
                continue
            trend, ratio = classify_trend(series)
            row = {
                "unit_type": unit_type, "unit": u, "total_spend": total,
                "months_with_charges": len(series), "first_month": series.index.min(),
                "last_month": series.index.max(), "trend": trend,
                "later_vs_earlier_ratio": ratio if ratio not in (float("inf"),) else None,
            }
            if unit_type == "truck" and u in cpm.index:
                c = cpm.loc[u]
                row["cost_per_mile"] = c.cost_per_mile
                row["miles_in_pnl_window"] = c.miles_in_pnl_window
            rows.append(row)
    out = pd.DataFrame(rows)
    return out.sort_values(["unit_type", "total_spend"], ascending=[True, False])


def main():
    d, notes = SP.load_all()
    d = SP.add_periods(d)
    table = build(d)

    out = ROOT / "data/processed/breakdown_trend.xlsx"
    with pd.ExcelWriter(out, engine="xlsxwriter") as xw:
        table[table.unit_type == "truck"].drop(columns=["unit_type"]).to_excel(
            xw, sheet_name="Trucks worst to best", index=False)
        table[table.unit_type == "trailer"].drop(
            columns=["unit_type", "cost_per_mile", "miles_in_pnl_window"]).to_excel(
            xw, sheet_name="Trailers worst to best", index=False)
        pd.DataFrame({"note": notes}).to_excel(xw, sheet_name="Data notes", index=False)

    print(f"wrote {out}\n")
    for ut in ("truck", "trailer"):
        t = table[table.unit_type == ut]
        print(f"=== {ut.upper()}S: {len(t)} units, ${t.total_spend.sum():,.0f} total ===")
        print(t.trend.value_counts().to_string())
        print()
        print("worst 10:")
        cols = ["unit", "total_spend", "months_with_charges", "trend"]
        if ut == "truck":
            cols.append("cost_per_mile")
        print(t.head(10)[cols].to_string(index=False))
        print()


if __name__ == "__main__":
    main()
