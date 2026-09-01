"""
Per-truck economics split by pay model -- why a company can grow gross and lose
money at the same time.

The weekly P&L records one driver-pay line per unit and does not label the pay
model, but the model is visible in the ratio: an owner-operator takes most of
the linehaul and buys their own fuel, a company driver takes roughly a third
and the company buys the fuel. Splitting on driver pay as a share of gross
separates them cleanly, and the two populations then price out completely
differently.

WHY THIS MATTERS MORE THAN THE HEADLINE COST RATIOS: fuel and rent as a
percentage of revenue move when the pay model changes, with no change in
operating efficiency at all. Reading those ratios without splitting by model
shows "fuel fell from 27% to 10% of gross" and invites the conclusion that fuel
got cheaper. It did not; it moved onto the driver's side of the settlement.

Overhead per truck-week is the group's own fixed-cost sheet MINUS the lines the
per-unit P&L already charges (truck and trailer rent, insurance), so nothing is
counted twice.

Usage:
    python analysis/unit_economics.py --pnl pnl_unit_week_XTRACK.csv --from 2026-07-01
"""
import argparse
import csv
import collections
from pathlib import Path

# From "Fixed costs by company": total per truck per week, less the truck and
# trailer rent and the insurance the unit rows already carry. What is left is
# subscriptions, permits, road taxes, back-office salaries and software.
OVERHEAD_PER_TRUCK_WEEK = 440.73
OO_THRESHOLD = 0.55          # driver share of gross above which the unit is an OO
COSTS = ["driver_salary", "def_fuel_fee", "truck_rental", "toll_scale",
         "insur_admin_trl", "additional_charges"]


def f(r, k):
    try:
        return float(r[k]) if r.get(k) else 0.0
    except ValueError:
        return 0.0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pnl", required=True)
    ap.add_argument("--from", dest="since", default="")
    ap.add_argument("--overhead", type=float, default=OVERHEAD_PER_TRUCK_WEEK)
    ap.add_argument("--min-gross", type=float, default=500.0,
                    help="ignore unit-weeks below this; a truck that barely ran "
                         "has a meaningless pay ratio")
    a = ap.parse_args()

    rows = [r for r in csv.DictReader(Path(a.pnl).open())
            if r.get("week_start", "") >= a.since and f(r, "gross") > a.min_gross]
    if not rows:
        raise SystemExit("no unit-weeks in range")

    groups = collections.defaultdict(list)
    for r in rows:
        share = f(r, "driver_salary") / f(r, "gross")
        groups["owner-operator" if share >= OO_THRESHOLD else "company driver"].append(r)

    print(f"\n{Path(a.pnl).stem}  {a.since or 'all'} onward   "
          f"{len(rows):,} unit-weeks above ${a.min_gross:,.0f} gross\n")
    print(f"{'':<20}{'unit-wks':>9}{'gross/wk':>11}{'driver':>9}{'fuel':>8}"
          f"{'rent':>8}{'ins+toll':>10}{'contrib/wk':>12}{'after o/h':>11}")
    print("-" * 98)
    summary = {}
    for name in ("owner-operator", "company driver"):
        g = groups.get(name, [])
        if not g:
            continue
        n = len(g)
        G = sum(f(r, "gross") for r in g)
        d = sum(f(r, "driver_salary") for r in g)
        fu = sum(f(r, "def_fuel_fee") for r in g)
        rt = sum(f(r, "truck_rental") for r in g)
        it = sum(f(r, "insur_admin_trl") + f(r, "toll_scale") for r in g)
        C = G - sum(f(r, c) for r in g for c in COSTS)
        summary[name] = C / n - a.overhead
        print(f"{name:<20}{n:>9,}{G/n:>11,.0f}{d/G*100:>8.1f}%{fu/G*100:>7.1f}%"
              f"{rt/G*100:>7.1f}%{it/G*100:>9.1f}%{C/n:>12,.0f}{C/n - a.overhead:>11,.0f}")
    print("-" * 98)
    print(f"{'':<20}overhead charged per truck-week: ${a.overhead:,.2f} "
          f"(fixed-cost sheet, less rent and insurance already on the unit rows)")

    if len(summary) == 2:
        oo, cd = summary["owner-operator"], summary["company driver"]
        print(f"\n  Every owner-operator truck earns ${oo:,.0f} a week; every company "
              f"truck earns ${cd:,.0f}.")
        print(f"  The swing between the two pay models is ${cd - oo:,.0f} per truck "
              f"per week.")

    # a fuel line on an OO unit means the company bought fuel it may not have recovered
    oof = [r for r in groups.get("owner-operator", []) if f(r, "def_fuel_fee") > 0]
    if oof:
        print(f"\n  {len(oof)} owner-operator unit-weeks still carry a company fuel "
              f"charge, ${sum(f(r, 'def_fuel_fee') for r in oof):,.0f} in total.")
    else:
        print(f"\n  No owner-operator unit-week carries a company fuel charge, so any "
              f"OO fuel\n  the company bought is tracked somewhere other than the unit "
              f"row -- check it is recovered.")


if __name__ == "__main__":
    main()
