"""The per-unit maintenance ledger: what broke, on which unit, and who paid.

`*_Truck_and_Trailer_Expenses_*.xlsx` is one row per repair charge with the unit,
whether it is a truck or a trailer, a free-text description, the date and the
side that bears it. It is the only source that attributes maintenance to a unit,
so it is the only one that can answer why the maintenance line moved.

THREE THINGS THAT MISLEAD

1. MOST ROWS ARE NOT CHARGES. Of the 1,639 rows only 712 carry an amount; the
   rest are date banners and blank scaffolding. Counting rows counts furniture,
   and a per-charge average computed over all of them is half its true value.

2. `Iron lease exp` ROWS NET TO EXACTLY ZERO, IN PAIRS. 136 XTRACK charges in
   2026 are marked Iron Lease's; 68 are positive and 68 negative and they sum to
   $0.00. That is the repair being booked when the operating company pays it and
   reversed when Iron Lease credits it back on the next invoice
   (analysis/iron_lease.py). So the ledger TOTAL is already what the operating
   company bears -- but summing it without separating these hides the gross
   repair flow passing through, and reading a single reversal row as a charge
   books a refund as a cost.

3. TRAILERS ARE IN HERE TOO, AND THEY ARE THE BIGGER HALF. Reading the file as
   "truck maintenance" attributes trailer running-gear to the tractors and
   overstates cost per truck by roughly half. `Unit Type` separates them.

Dates are `MM.DD.YY` and a few are mistyped into other years; anything outside
the requested window is dropped rather than silently bucketed.
"""
import argparse
import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
LEDGERS = {
    "XTRACK": "data/raw/pnl/168e4bc8-XTRACK_Truck_and_Trailer_Expenses_2026.xlsx",
    "ZONE": "data/raw/pnl/5c1ac5ff-ZONE_Truck_and_Trailer_Expenses_2026.xlsx",
    "AFG": "data/raw/pnl/07ed590e-AFG_Truck_and_trailer_expenses_2026.xlsx",
}
# Ordered general -> specific; the later match wins, so the more specific
# pattern must come later in the list.
CATEGORIES = [
    ("APU/idle", r"apu|idle"),
    ("accident/body", r"accident|body labor|paint|bumper|fender|\bdoor\b|roof|panel"),
    ("electrical", r"batter|light|wire|alternator|sensor|starter|\babs\b"),
    ("tow/roadside/stuck", r"\btow|winch|jumpstart|road ?side|stuck"),
    ("engine/aftertreatment", r"engine|\begr\b|\bdpf\b|\bdef\b|turbo|injector|nox|"
                              r"oil leak|valve adj|fhwa|\bpm\b"),
    ("cooling", r"radiator|coolant|antifreeze|water pump|fan clutch"),
    ("tires/rims", r"tire|tyre|\brim\b|mudfl"),
    ("brakes/running gear", r"brake|drum|shoe|air ?bag|wheel seal|\bhub\b|axle|bushing|susp"),
]


def load(company="XTRACK", start="2026-01-01", end="2026-09-01"):
    d = pd.read_excel(ROOT / LEDGERS[company])
    d["amount"] = pd.to_numeric(d["$ used"], errors="coerce")
    d["date"] = pd.to_datetime(d["Issued Date"], format="%m.%d.%y", errors="coerce")
    d["unit"] = d["Unit"].astype(str).str.replace(r"\.0$", "", regex=True)
    d["unit_type"] = d["Unit Type"].fillna("unknown")
    d["borne_by"] = (d["Expense side"].astype(str).str.strip().str.lower()
                     .replace({"iron lease exp": "iron lease", "driver exp": "driver",
                               "nan": "(blank)"}))
    d["text"] = (d["Cost type"].fillna("").astype(str) + " "
                 + d["Details"].fillna("").astype(str)).str.lower()
    d["category"] = "other / unclassified"
    for name, pat in CATEGORIES:
        d.loc[d.text.str.contains(pat, regex=True, na=False), "category"] = name
    charged = d[d.amount.notna() & d.date.between(start, end)].copy()
    charged["month"] = charged.date.dt.to_period("M").astype(str)
    uncosted = d[d.amount.isna() & d.date.between(start, end)]
    return charged, uncosted


def controls(charged, uncosted):
    """What must hold before this ledger's total is quoted as a cost."""
    fails = []
    iron = charged[charged.borne_by == "iron lease"]
    if len(iron) and abs(iron.amount.sum()) > 1.0:
        fails.append(("'Iron lease exp' rows no longer net to zero -- the "
                      "credit-back arrangement has changed and the ledger total is "
                      "no longer operator-borne only", round(iron.amount.sum(), 2)))
    other_neg = charged[(charged.amount < 0) & (charged.borne_by != "iron lease")]
    if len(other_neg):
        fails.append(("negative charges outside the Iron Lease reversals", len(other_neg)))
    if charged.unit.eq("nan").any():
        fails.append(("charges with no unit", int(charged.unit.eq("nan").sum())))
    return fails


def iron_lease_flow(charged):
    """Repair spend that passes through the operating company and comes back."""
    iron = charged[charged.borne_by == "iron lease"]
    return {"charges": len(iron), "paid_out": iron[iron.amount > 0].amount.sum(),
            "credited_back": -iron[iron.amount < 0].amount.sum(),
            "net": iron.amount.sum()}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--company", default="XTRACK")
    ap.add_argument("--split", default="2026-05",
                    help="first month of the second half of the comparison")
    a = ap.parse_args()
    c, u = load(a.company)
    fmt = lambda v: f"{v:,.0f}"
    print(f"{a.company}: ${c.amount.sum():,.0f} over {len(c)} charges, "
          f"{c.month.min()} .. {c.month.max()}")
    print(f"  uncosted rows in the same window: {len(u)} "
          f"(of which {int((u.borne_by == 'iron lease').sum())} marked Iron Lease's)")
    for what, n in controls(c, u):
        print(f"  CONTROL: {what}: {n}")
    for t in ("trailer", "truck"):
        s = c[c.unit_type == t]
        print(f"  {t + 's':<10}{s.unit.nunique():>4} units  ${s.amount.sum():>10,.0f}")
    f = iron_lease_flow(c)
    print(f"  Iron Lease repairs passing through: {f['charges']} charges, "
          f"${f['paid_out']:,.0f} paid out, ${f['credited_back']:,.0f} credited back, "
          f"net ${f['net']:,.0f}")

    print("\n== BY CATEGORY ==")
    p = c.pivot_table(index="category", columns="unit_type", values="amount",
                      aggfunc="sum").fillna(0)
    p["total"] = p.sum(axis=1)
    p["pct"] = 100 * p.total / p.total.sum()
    print(p.sort_values("total", ascending=False).to_string(float_format=fmt))

    print("\n== BY MONTH ==")
    q = c.pivot_table(index="month", columns="unit_type", values="amount",
                      aggfunc="sum").fillna(0)
    q["total"] = q.sum(axis=1)
    q["charges"] = c.groupby("month").size()
    q["units_touched"] = c.groupby("month").unit.nunique()
    q["per_charge"] = q.total / q.charges
    print(q.to_string(float_format=fmt))

    early, late = c[c.month < a.split], c[c.month >= a.split]
    print(f"\n== WHAT GREW: before {a.split} (${early.amount.sum():,.0f}) "
          f"vs from {a.split} (${late.amount.sum():,.0f}, "
          f"{100 * (late.amount.sum() / early.amount.sum() - 1):+.0f}%) ==")
    g = pd.DataFrame({"before": early.groupby("category").amount.sum(),
                      "after": late.groupby("category").amount.sum()}).fillna(0)
    g["change"] = g.after - g.before
    print(g.sort_values("change", ascending=False).to_string(float_format=fmt))

    print("\n== UNITS COSTING THE MOST ==")
    for t in ("truck", "trailer"):
        s = c[c.unit_type == t].groupby("unit").amount.agg(["size", "sum"])
        print(f"  {t}s:  " + ", ".join(f"{u} ${v:,.0f}" for u, v in
                                       s.nlargest(6, "sum")["sum"].items()))


if __name__ == "__main__":
    main()
