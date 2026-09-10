"""
Fixed versus variable cost per truck, and the break-even mileage that falls out.

The group's own "Fixed costs by company" sheet prices a truck at $1,813.05 a
week for Xtrack. That number is close to right but it is not all fixed, and the
distinction is the whole point: a fixed cost accrues on a truck standing in a
yard, a variable cost does not. Mixing them hides why an idle truck is
expensive.

Three things in that sheet are not weekly fixed costs:

    IFTA                        a fuel tax -- varies with miles
    KY / NY / NM mileage taxes  vary with miles
    MVR, PSP, drug test, travel per HIRE, not per week. At a 19% hire rate
                                (284 candidates, 55 hired) this is a recruiting
                                cost that belongs to churn, not to the truck

They are small -- $41.92 of $1,813.05 -- so the sheet is 97.7% right. It is the
SHAPE that matters: rent, insurance and back-office salaries are 96% of the
fixed cost and none of them care whether the truck moves.

Variable rates are measured from COMPANY-DRIVER unit-weeks only. On an
owner-operator week the driver bears the fuel, so including those weeks halves
the apparent fuel rate and makes the fleet look more efficient than it is.

Maintenance per mile is the one estimate here and is labelled as such: the
breakdown log and the truck-and-trailer ledger together give roughly $0.22/mile.

Usage:
    python analysis/cost_model.py --pnl out/ --entities XTRACK ZONE --from 2026-01-01
"""
import argparse
import csv
from pathlib import Path

FIXED = [("Truck rent", 877.53), ("Trailer rent", 132.75),
         ("Insurance cargo / liability", 233.68), ("Insurance physical damage", 103.46),
         ("Occupational accident", 24.90), ("Back-office salaries", 354.16),
         ("ELD / Samsara / Verizon / Trippak", 32.95),
         ("ADP / DAT / QuickBooks / 8x8", 11.70)]
MISFILED = [("IFTA — a fuel tax, varies with miles", 16.72),
            ("KY / NY / NM mileage taxes", 6.80),
            ("MVR, PSP, drug test, travel — per HIRE", 18.40)]
MAINT_PER_MILE = 0.220
OO_THRESHOLD = 0.55


def f(r, k):
    try:
        return float(r[k]) if r.get(k) else 0.0
    except ValueError:
        return 0.0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pnl", required=True, help="directory of pnl_unit_week_*.csv")
    ap.add_argument("--entities", nargs="+", default=["XTRACK", "ZONE"])
    ap.add_argument("--from", dest="since", default="2026-01-01")
    ap.add_argument("--maint-per-mile", type=float, default=MAINT_PER_MILE)
    a = ap.parse_args()

    rows = []
    for e in a.entities:
        p = Path(a.pnl) / f"pnl_unit_week_{e}.csv"
        if not p.exists():
            continue
        for r in csv.DictReader(p.open()):
            if (r.get("week_start", "") >= a.since and f(r, "gross") > 500
                    and f(r, "mileage") > 100
                    and f(r, "driver_salary") / f(r, "gross") < OO_THRESHOLD):
                rows.append(r)
    if not rows:
        raise SystemExit("no company-driver unit-weeks in range")

    n = len(rows)
    M = sum(f(r, "mileage") for r in rows)
    G = sum(f(r, "gross") for r in rows)
    rpm = G / M

    print(f"\nCompany-driver unit-weeks, {a.since} onward: {n:,} truck-weeks, "
          f"{M:,.0f} miles\n")
    print(f"  revenue per mile{'':<26}${rpm:>7.3f}\n")

    print("VARIABLE — incurred only when the truck turns a wheel")
    var = 0.0
    for k, lb in (("def_fuel_fee", "Fuel and DEF"), ("driver_salary", "Driver pay"),
                  ("toll_scale", "Tolls and scales")):
        v = sum(f(r, k) for r in rows)
        var += v
        print(f"  {lb:<34}${v / M:>7.3f}/mi   ${v / n:>9,.0f}/truck-week")
    mv = a.maint_per_mile * M
    var += mv
    print(f"  {'Maintenance (estimated)':<34}${a.maint_per_mile:>7.3f}/mi   "
          f"${mv / n:>9,.0f}/truck-week")
    print(f"  {'TOTAL VARIABLE':<34}${var / M:>7.3f}/mi   ${var / n:>9,.0f}/truck-week\n")

    tf = sum(v for _, v in FIXED)
    print("FIXED — accrues whether the truck moves or not")
    for lb, v in FIXED:
        print(f"  {lb:<34}${v:>8,.2f}/truck-week")
    print(f"  {'TOTAL FIXED':<34}${tf:>8,.2f}/truck-week\n")

    print("Counted as fixed in the group's sheet, but not fixed:")
    for lb, v in MISFILED:
        print(f"  {lb:<50}${v:>6,.2f}")
    print(f"  {'':<50}${sum(v for _, v in MISFILED):>6,.2f} of $1,813.05\n")

    cm = rpm - var / M
    be = tf / cm
    print("BREAK-EVEN")
    print(f"  contribution per mile{'':<21}${cm:>7.3f}")
    print(f"  fixed cost per truck-week{'':<17}${tf:>8,.2f}")
    print(f"  miles a truck must run each week{'':<10}{be:>9,.0f}")
    print(f"  company drivers actually run{'':<14}{M / n:>9,.0f}")
    print(f"\n  Every mile above {be:,.0f} earns ${cm:.3f}. Every truck-week below it "
          f"loses\n  fixed cost at ${tf / 7:,.0f} a day whether it moves or not.")


if __name__ == "__main__":
    main()
