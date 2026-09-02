"""
Real break-even: fixed cost per truck and per mile, variable per mile, and the
mileage a truck has to run to pay for itself.

Fixed cost comes from two places and they are kept apart on purpose:

  EQUIPMENT FIXED   measured from verified 2026 cash -- truck and trailer rent,
                    equipment debt service, insurance, telematics, permits.
                    Scales with the fleet: park a truck and it keeps running,
                    sell it and it stops.

  GROUP OVERHEAD    supplied by the operator, because it cannot be measured.
                    ADP is one payroll rail for five companies mixing drivers
                    with office staff, so the bank cannot separate an office
                    salary from a driver settlement. These are the operator's
                    figures and are labelled as such wherever they appear.

Why not use the group's own "Fixed costs by company" sheet for equipment: its
truck rent rate of $843-889 a truck-week prices a RENTED fleet. The group
stopped paying STL in October 2025 and now buys through Iron Lease, so 2026 cash
rent annualises to $1.21M against the $3.9M that rate implies. Using the stale
rate overstates fixed cost by roughly $600 a truck-week and pushes break-even
about 700 miles too high.

Depreciation on owned trucks is NOT included. This is a cash break-even: it
answers "how far must a truck run to cover the money that actually leaves",
which is the question when the fleet is half idle. Add depreciation to get an
accounting break-even.

Variable rates are measured from COMPANY-DRIVER unit-weeks only, because on an
owner-operator week the driver bears the fuel and including those halves the
apparent rate.

Usage:
    python analysis/breakeven.py --cash cash.csv --pnl out/ \
        --tashkent 30000 --us-office 20000 --owners 5000 --trucks 85
"""
import argparse
import collections
import csv
from datetime import datetime
from pathlib import Path

EQUIP_CATS = ["lease_rent", "insurance_premium", "subscriptions_saas",
              "registration", "permits", "loan_finance"]
TRUCKING = ["0271", "1558", "5745", "5525", "4504", "5151"]   # shop excluded
OO_THRESHOLD = 0.55


def f(r, k="amount"):
    try:
        return float(r[k]) if r.get(k) else 0.0
    except (ValueError, TypeError):
        return 0.0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cash", required=True)
    ap.add_argument("--pnl", required=True)
    ap.add_argument("--from", dest="since", default="2026-01-01")
    ap.add_argument("--trucks", type=float, default=85)
    ap.add_argument("--tashkent", type=float, default=30000, help="per WEEK, operator")
    ap.add_argument("--us-office", type=float, default=20000, help="per WEEK, operator")
    ap.add_argument("--owners", type=float, default=5000, help="per WEEK, operator")
    ap.add_argument("--maint-per-mile", type=float, default=0.220)
    a = ap.parse_args()

    # ---- equipment fixed, from cash ---------------------------------------
    rows = [r for r in csv.DictReader(Path(a.cash).open())
            if f(r) < 0 and r["date"] >= a.since and r["account"] in TRUCKING]
    d0 = datetime.fromisoformat(min(r["date"] for r in rows))
    d1 = datetime.fromisoformat(max(r["date"] for r in rows))
    weeks = max((d1 - d0).days / 7, 1)
    eq = {k: sum(abs(f(r)) for r in rows if r["category"] == k) for k in EQUIP_CATS}
    eq_wk = {k: v / weeks for k, v in eq.items()}
    eq_total = sum(eq_wk.values())

    print(f"\nEQUIPMENT FIXED — verified cash, {d0.date()} to {d1.date()} "
          f"({weeks:.0f} weeks), trucking accounts only\n")
    print(f"  {'':<34}{'per week':>12}{'per truck/wk':>15}")
    NAMES = {"lease_rent": "Truck & trailer rent",
             "loan_finance": "Equipment debt service",
             "insurance_premium": "Insurance (all lines)",
             "subscriptions_saas": "Telematics, ELD, software",
             "registration": "Registration & plates", "permits": "Permits"}
    for k in EQUIP_CATS:
        print(f"  {NAMES[k]:<34}{eq_wk[k]:>12,.0f}{eq_wk[k] / a.trucks:>15,.2f}")
    print(f"  {'TOTAL EQUIPMENT FIXED':<34}{eq_total:>12,.0f}"
          f"{eq_total / a.trucks:>15,.2f}")

    # ---- overhead, operator-supplied --------------------------------------
    oh = a.tashkent + a.us_office + a.owners
    print(f"\nGROUP OVERHEAD — operator figures, not measurable from the bank\n")
    print(f"  {'Tashkent office':<34}{a.tashkent:>12,.0f}{a.tashkent / a.trucks:>15,.2f}")
    print(f"  {'US office and staff':<34}{a.us_office:>12,.0f}{a.us_office / a.trucks:>15,.2f}")
    print(f"  {'Owners (2)':<34}{a.owners:>12,.0f}{a.owners / a.trucks:>15,.2f}")
    print(f"  {'TOTAL OVERHEAD':<34}{oh:>12,.0f}{oh / a.trucks:>15,.2f}")

    fixed_wk = eq_total + oh
    print(f"\n  {'ALL FIXED, PER WEEK':<34}{fixed_wk:>12,.0f}"
          f"{fixed_wk / a.trucks:>15,.2f}")
    print(f"  {'ALL FIXED, PER YEAR':<34}{fixed_wk * 52:>12,.0f}")

    # ---- variable, from company-driver rows -------------------------------
    pr = []
    for e in ("ZONE", "XTRACK", "AFG"):
        p = Path(a.pnl) / f"pnl_unit_week_{e}.csv"
        if not p.exists():
            continue
        for r in csv.DictReader(p.open()):
            if (r.get("week_start", "") >= a.since and f(r, "gross") > 500
                    and f(r, "mileage") > 100
                    and f(r, "driver_salary") / f(r, "gross") < OO_THRESHOLD):
                pr.append(r)
    M = sum(f(r, "mileage") for r in pr)
    G = sum(f(r, "gross") for r in pr)
    rpm = G / M
    print(f"\nVARIABLE — company-driver unit-weeks, {len(pr):,} weeks, {M:,.0f} miles\n")
    print(f"  {'':<34}{'per mile':>12}")
    var = 0.0
    for k, lb in (("def_fuel_fee", "Fuel and DEF"), ("driver_salary", "Driver pay"),
                  ("toll_scale", "Tolls and scales")):
        v = sum(f(r, k) for r in pr)
        var += v
        print(f"  {lb:<34}{v / M:>12.3f}")
    var += a.maint_per_mile * M
    print(f"  {'Maintenance (estimated)':<34}{a.maint_per_mile:>12.3f}")
    print(f"  {'TOTAL VARIABLE':<34}{var / M:>12.3f}")
    print(f"\n  {'Revenue per mile':<34}{rpm:>12.3f}")
    cm = rpm - var / M
    print(f"  {'CONTRIBUTION per mile':<34}{cm:>12.3f}")

    # ---- break-even -------------------------------------------------------
    be_truck = (fixed_wk / a.trucks) / cm
    print(f"\nBREAK-EVEN\n")
    print(f"  fixed cost per truck-week{'':<12}${fixed_wk / a.trucks:>10,.2f}")
    print(f"  contribution per mile{'':<16}${cm:>10.3f}")
    print(f"  MILES PER TRUCK PER WEEK TO BREAK EVEN{'':<1}{be_truck:>11,.0f}")
    print(f"  fixed cost per mile at that point{'':<5}${fixed_wk / a.trucks / be_truck:>10.3f}")
    print(f"\n  Group fixed cost per week ${fixed_wk:,.0f} needs "
          f"{fixed_wk / cm:,.0f} fleet miles a week.")


if __name__ == "__main__":
    main()
