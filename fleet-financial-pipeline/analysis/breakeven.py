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
import json
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


def load_overhead(path):
    """Read config/overhead.json and total every line as dollars per WEEK.

    The roster mixes periods -- people weekly, premises monthly -- so each line
    declares its own and a line without one raises. That is deliberate: reading
    the whole file as weekly priced premises at 52x instead of 12x and overstated
    fixed cost by roughly 6,900 a week.

    The other controls exist because a hand-kept roster drifts: every stated
    total must equal the sum of its own lines, and every hourly line must equal
    rate x hours. A mismatch raises rather than quietly moving break-even.
    """
    cfg = json.loads(Path(path).read_text())
    wpm = cfg["weeks_per_month"]

    def weekly(amount, period, what):
        if period == "week":
            return float(amount)
        if period == "month":
            return amount / wpm
        raise ValueError(f"{what}: period {period!r} is neither 'week' nor 'month'")

    def total(lines, key="amount"):
        return sum(weekly(x[key], x.get("period"), x.get("name", key)) for x in lines)

    staff = total(cfg["us_staff_1099"])
    if round(staff) != cfg["us_staff_1099_stated_total"]:
        raise ValueError(f"1099 lines sum to {staff:,.0f}/wk, stated "
                         f"{cfg['us_staff_1099_stated_total']:,}")
    owners = total(cfg["owners"])
    if round(owners) != cfg["owners_stated_total"]:
        raise ValueError(f"owner lines sum to {owners:,.0f}/wk, stated "
                         f"{cfg['owners_stated_total']:,}")
    for m in cfg["shop"]["mechanics"]:
        if m["basis"] == "hourly" and m["rate"] * m["hours"] != m["amount"]:
            raise ValueError(f"{m['name']}: {m['rate']} x {m['hours']} != {m['amount']}")

    oy = cfg["us_office_and_yard"]
    if oy["office"] + oy["yard"] != oy["stated_total"]:
        raise ValueError(f"office {oy['office']} + yard {oy['yard']} "
                         f"!= stated {oy['stated_total']}")

    w2 = total(cfg["w2"])
    yard = weekly(oy["stated_total"], oy["period"], "office_and_yard")
    sh = cfg["shop"]
    shop = (weekly(sh["shop_itself"], sh["shop_itself_period"], "shop_itself")
            + total(sh["mechanics"]))
    return {"us_staff": staff, "w2": w2, "owners": owners, "office_and_yard": yard,
            "us_total": staff + w2 + owners + yard, "shop": shop,
            "tashkent": cfg["offshore"]["tashkent_operator_stated"],
            "tashkent_bank": cfg["offshore"]["tashkent_bank_observed_2026"],
            "cfg": cfg}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cash", required=True)
    ap.add_argument("--pnl", required=True)
    ap.add_argument("--from", dest="since", default="2026-01-01")
    ap.add_argument("--trucks", type=float, default=85)
    ap.add_argument("--overhead", default="config/overhead.json",
                    help="operator-supplied weekly overhead roster")
    ap.add_argument("--tashkent", type=float, help="override the roster, per WEEK")
    ap.add_argument("--us-office", type=float, help="override the roster, per WEEK")
    ap.add_argument("--owners", type=float, help="override the roster, per WEEK")
    ap.add_argument("--include-shop", action="store_true",
                    help="fold the shop block into fixed cost (default: excluded,\nper the operator, who costs the shop independently)")
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
    ov = load_overhead(a.overhead)
    tashkent = a.tashkent if a.tashkent is not None else ov["tashkent"]
    us = a.us_office if a.us_office is not None else ov["us_total"]
    owners = a.owners if a.owners is not None else ov["owners"]
    shop = ov["shop"] if a.include_shop else 0.0
    oh = tashkent + us + owners + shop
    print(f"\nGROUP OVERHEAD — operator figures, not measurable from the bank\n")
    print(f"  {'Tashkent office':<34}{tashkent:>12,.0f}{tashkent / a.trucks:>15,.2f}")
    print(f"  {'US staff and office':<34}{us:>12,.0f}{us / a.trucks:>15,.2f}")
    print(f"  {'Owners (2)':<34}{owners:>12,.0f}{owners / a.trucks:>15,.2f}")
    if a.include_shop:
        print(f"  {'Shop (folded in)':<34}{shop:>12,.0f}{shop / a.trucks:>15,.2f}")
    else:
        print(f"  {'Shop':<34}{'excluded':>12}{'costed apart':>15}")
    if tashkent != ov["tashkent_bank"]:
        print(f"\n  ! Tashkent is operator-stated at {tashkent:,.0f}/wk; the bank shows "
              f"{ov['tashkent_bank']:,.0f}/wk\n    in 2026. Unreconciled — the gap moves "
              f"break-even by {abs(tashkent - ov['tashkent_bank']) / a.trucks:,.2f}/truck/wk.")
    print(f"\n  {'TOTAL OVERHEAD':<34}{oh:>12,.0f}{oh / a.trucks:>15,.2f}")

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
