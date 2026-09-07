"""Maintenance cost per truck, matched to that truck's own miles and weeks.

Two sources, joined on the truck number -- the same identifier in both, the way
`analysis/truck_weeks.py` already joins the P&L to the Iron Lease rate card:

    maintenance ledger   `analysis/maintenance_ledger.py` -- what broke, on
                         which unit, who paid. 2026 YTD, one row per charge.
    weekly P&L blocks    `analysis/truck_weeks.py` -- gross, loaded miles, and
                         which weeks a truck was even on a roster.

A TRUCK'S MAINTENANCE IS NOT FILED UNDER ONE COMPANY. 20-plus units show charges
under TWO of the three companies' ledgers within this same window -- 7605,
15862, 15909 and others move between XTRACK and ZONE the same way they move in
the P&L (`truck_weeks.py`'s own finding). Reading a truck's cost from a single
company's ledger silently drops the charges booked while it ran for the other
one. So this reads all three ledgers and all three P&L companies and groups by
UNIT, not by company -- the company a charge is filed under is kept as a
dimension, not used as a filter.

WHAT COUNTS AS "WHAT WE SPEND." Three buckets, and only one is the group's own
cost:

    company    the operating company paid it and does not get it back
    driver     billed to the driver's settlement -- a RECOVERY, not a cost, and
               per CLAUDE.md whether it was actually deducted is a separate,
               still-open question this module does not close
    iron lease booked when the operating company pays Truck Max and REVERSED
               when Iron Lease credits it back (`iron_lease_flow()` in
               maintenance_ledger.py) -- nets to zero across the ledger, so it
               is excluded from cost, with the RAW paid/credited-back sizes for
               a specific truck shown so a lag (median 9-11 days, up to 177)
               does not read as an uncredited loss

MILES AND WEEKS ARE FROM THE SAME WINDOW THE CHARGES ARE, PER COMPANY. The
maintenance ledger runs 2026-01-01..2026-09-01; the P&L only reaches back to
2026-02-23 (XTRACK/ZONE) or 2026-04-13 (AFG), a fact `docs/CATALOG.md` already
records. Dividing a YTD maintenance total by a truncated week count would
overstate cost per week, so the ledger is re-cut to each company's own P&L
window before the two are joined, and the YTD total is kept alongside it, never
silently swapped in.

A TRUCK WITH NO MATCHING P&L UNIT HAS NO DENOMINATOR. Sold, retired, or a
numbering mismatch -- reported by name, cost withheld rather than divided by
zero.

THIS LEDGER IS NOT ALL OF "MAINTENANCE." The weekly P&L panel carries its own
`maintenance` figure -- a whole-fleet weekly total, independent of this file --
and it runs 2 to nearly 5 times LARGER than what this ledger books as
company-borne truck repairs over the same weeks (XTRACK $76,406 ledger against
$254,488 panel, ZONE $82,375 against $192,366, AFG $9,534 against $46,202: 21,
43 and 21 percent). So a per-truck total here is Truck Max SHOP REPAIRS
specifically, not the P&L's whole maintenance line -- tires bought elsewhere,
PM service, or anything paid outside Truck Max is in the panel figure and not
in this ledger, and this module does not invent an allocation to close that
gap. `reconcile_to_panel()` prints the two side by side so the ratio is visible
rather than silently assumed away.
"""
import argparse
import sys
import warnings
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
warnings.filterwarnings("ignore")

import maintenance_ledger as M      # noqa: E402
import truck_weeks as T             # noqa: E402

COMPANIES = ("XTRACK", "ZONE", "AFG")
# borne_by values that are the OPERATING COMPANY's own cost. Everything else
# (driver, iron lease) is excluded from "what we spend" -- see the docstring.
COMPANY_BORNE = {
    "company", "xtrack exp", "afg exp", "sher imam exp", "broker exp",
    "broker exp (ryder)", "fedex will reimburse",
}


def all_charges():
    """Every truck-type charge from all three ledgers, tagged by company.

    unit is stripped of whitespace here -- '7605 ' vs '7605' would otherwise
    split one truck into two rows silently.
    """
    out = []
    for co in COMPANIES:
        c, _ = M.load(co)
        fails = M.controls(c, _)
        c = c[c.unit_type == "truck"].copy()
        # pandas 3.x's astype(str) leaves a genuine NaN as NaN rather than the
        # string 'nan' -- these rows carry no unit at all and cannot be joined
        # to anything, so they are split off here and reported by name, not
        # silently dropped or left to break the set() below on mixed types.
        no_unit = c[c.Unit.isna()]
        if len(no_unit):
            fails = list(fails) + [("charges with no unit number",
                                    len(no_unit), no_unit.amount.sum())]
        c = c[c.Unit.notna()].copy()
        c["unit"] = c.unit.astype(str).str.strip()
        c["ledger_company"] = co
        out.append((co, c, fails))
    frames = [c for _, c, _ in out]
    all_fails = {co: f for co, _, f in out if f}
    return pd.concat(frames, ignore_index=True), all_fails


def all_weeks():
    """Every truck-week from all three companies' P&L, tagged by company."""
    frames = []
    for co in COMPANIES:
        tw = T.truck_weeks(co)
        tw = tw.copy()
        tw["unit"] = tw.unit.astype(str).str.strip()
        tw["pnl_company"] = co
        frames.append(tw)
    return pd.concat(frames, ignore_index=True)


def pnl_window(weeks, unit):
    """This unit's own first/last P&L week, across every company it ran for."""
    u = weeks[weeks.unit == unit]
    if not len(u):
        return None, None
    return u.week.min(), u.week.max()


def per_truck(charges, weeks):
    """One row per unit: cost, miles, weeks, and the buckets behind each."""
    rows = []
    units = sorted(set(charges.unit) | set(weeks.unit))
    for u in units:
        cu = charges[charges.unit == u]
        wu = weeks[weeks.unit == u]
        if not len(wu):
            rows.append({"unit": u, "unresolved": True,
                        "ytd_charged": cu.amount.sum(), "n_charges": len(cu)})
            continue

        lo, hi = wu.week.min(), wu.week.max()
        # Re-cut the ledger to THIS truck's own P&L window before dividing --
        # not the ledger's full Jan-Sep span, which the P&L cannot corroborate
        # for every truck (AFG's P&L starts 2026-04-13, six weeks later than
        # some of its trucks' first charges).
        cu_win = cu[cu.date.between(lo, hi)]

        company_cost = cu_win[cu_win.borne_by.isin(COMPANY_BORNE)].amount.sum()
        driver_billed = cu_win[cu_win.borne_by == "driver"].amount.sum()
        iron = cu_win[cu_win.borne_by == "iron lease"]
        iron_paid = iron[iron.amount > 0].amount.sum()
        iron_credited = -iron[iron.amount < 0].amount.sum()

        n_weeks = wu.week.nunique()
        total_miles = wu.miles.sum()
        companies = sorted(wu.pnl_company.unique())
        ledger_companies = sorted(cu.ledger_company.unique()) if len(cu) else []

        rows.append({
            "unit": u, "unresolved": False,
            "companies": "/".join(companies),
            "ledger_companies": "/".join(ledger_companies) or "(no charges)",
            "moved_companies": len(companies) > 1 or (
                len(ledger_companies) > 1),
            "first_week": lo, "last_week": hi, "weeks_in_pnl": n_weeks,
            "total_miles": total_miles,
            "company_cost_in_window": company_cost,
            "driver_billed_in_window": driver_billed,
            "iron_lease_paid": iron_paid,
            "iron_lease_credited": iron_credited,
            "iron_lease_net_outstanding": iron_paid - iron_credited,
            "charges_in_window": len(cu_win),
            "ytd_charged_all": cu.amount.sum(),
            "cost_per_week": company_cost / n_weeks if n_weeks else None,
            "cost_per_mile": company_cost / total_miles if total_miles else None,
        })
    return pd.DataFrame(rows)


def reconcile_to_panel(charges):
    """The ledger against the P&L's OWN maintenance line, whole fleet.

    Independent of the per-truck join: this compares two totals for the same
    weeks, the way analysis/pnl_accuracy.py checks the sheet against a record
    it did not write. It is not the per-truck answer -- it is the check on
    whether the ledger can be trusted as A COMPLETE PICTURE of maintenance, and
    the answer is no.
    """
    import truck_breakeven as B
    from xtrack_trend import load as load_weeks
    out = {}
    for co in COMPANIES:
        wk = load_weeks(ROOT / B.WORKBOOK[co])
        panel = sum(wk[k].get("maintenance", 0) or 0 for k in wk)
        t = charges[(charges.ledger_company == co)]
        ledger = t[t.borne_by.isin(COMPANY_BORNE)].amount.sum()
        out[co] = {"panel": panel, "ledger": ledger,
                   "ratio": ledger / panel if panel else None}
    return out


def controls(df, ledger_fails):
    fails = []
    for co, f in ledger_fails.items():
        for item in f:
            what, n = item[0], item[1]
            fails.append(f"{co} maintenance_ledger control: {what} ({n})")
    resolved = df[~df.unresolved]
    if (resolved.cost_per_week < 0).any():
        fails.append("negative cost per week on a resolved unit")
    huge = resolved[resolved.cost_per_mile.fillna(0) > 5]
    if len(huge):
        fails.append(f"{len(huge)} unit(s) over $5/mile maintenance -- check "
                     f"for a truck matched to the wrong window")
    return fails


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--csv", help="write the full per-truck table here")
    a = ap.parse_args()

    charges, ledger_fails = all_charges()
    weeks = all_weeks()
    df = per_truck(charges, weeks)
    fails = controls(df, ledger_fails)
    print("controls: all pass" if not fails else "CONTROLS FAILED:")
    for f in fails:
        print(f"  {f}")

    resolved = df[~df.unresolved].copy()
    moved = resolved[resolved.moved_companies]
    print(f"\n{len(resolved)} trucks matched to a P&L unit, "
          f"{len(df) - len(resolved)} charged in the ledger but never seen "
          f"in any company's P&L (sold, retired, or a numbering mismatch)")
    print(f"{len(moved)} of them show charges or P&L weeks under MORE THAN ONE "
          f"company -- their cost below is the whole truck, not one company's "
          f"slice of it")

    tot_cost = resolved.company_cost_in_window.sum()
    tot_miles = resolved.total_miles.sum()
    tot_weeks = resolved.weeks_in_pnl.sum()
    print(f"\n== FLEET TOTAL, COMPANY-BORNE MAINTENANCE, EACH TRUCK'S OWN WINDOW ==")
    print(f"  ${tot_cost:,.0f} over {tot_weeks:,} truck-weeks and "
          f"{tot_miles:,.0f} miles")
    print(f"  fleet average: ${tot_cost / tot_weeks:,.2f}/truck-week   "
          f"${tot_cost / tot_miles:.4f}/mile")
    print(f"  driver-billed (excluded, a recovery not a cost): "
          f"${resolved.driver_billed_in_window.sum():,.0f}")
    il_net = resolved.iron_lease_net_outstanding.sum()
    print(f"  Iron Lease pass-through still outstanding (paid, not yet "
          f"credited back): ${il_net:,.0f} of "
          f"${resolved.iron_lease_paid.sum():,.0f} paid")

    print(f"\n== TOP {a.top} BY COST PER MILE (min 3,000 miles in window) ==")
    sample = resolved[resolved.total_miles >= 3000].copy()
    sample = sample.sort_values("cost_per_mile", ascending=False)
    cols = ["unit", "companies", "weeks_in_pnl", "total_miles",
            "company_cost_in_window", "cost_per_week", "cost_per_mile"]
    print(sample[cols].head(a.top).to_string(
        index=False,
        formatters={"total_miles": "{:,.0f}".format,
                   "company_cost_in_window": "${:,.0f}".format,
                   "cost_per_week": "${:,.2f}".format,
                   "cost_per_mile": "${:.4f}".format}))

    print(f"\n== TOP {a.top} BY TOTAL COST ==")
    top_cost = resolved.sort_values("company_cost_in_window", ascending=False)
    print(top_cost[cols].head(a.top).to_string(
        index=False,
        formatters={"total_miles": "{:,.0f}".format,
                   "company_cost_in_window": "${:,.0f}".format,
                   "cost_per_week": "${:,.2f}".format,
                   "cost_per_mile": "${:.4f}".format}))

    print(f"\n== MOVED BETWEEN COMPANIES (a sample of {min(8, len(moved))}) ==")
    if len(moved):
        print(moved[["unit", "companies", "ledger_companies",
                    "company_cost_in_window"]].head(8).to_string(index=False))

    unresolved = df[df.unresolved].sort_values("ytd_charged", ascending=False)
    if len(unresolved):
        print(f"\n== CHARGED IN THE LEDGER, SEEN IN NO COMPANY'S P&L "
              f"(top {min(10, len(unresolved))} by $) ==")
        print(unresolved[["unit", "ytd_charged", "n_charges"]].head(10)
              .to_string(index=False, formatters={"ytd_charged": "${:,.0f}".format}))

    print(f"\n== IS THIS LEDGER ALL OF MAINTENANCE? NO -- CHECKED AGAINST THE P&L'S "
          f"OWN LINE ==")
    rec = reconcile_to_panel(charges)
    print(f"  {'company':<10}{'P&L panel maintenance':>24}{'this ledger, company-borne':>28}{'ratio':>8}")
    for co, r in rec.items():
        print(f"  {co:<10}{r['panel']:>24,.0f}{r['ledger']:>28,.0f}{r['ratio']:>8.0%}")
    print("  Only 21-43% of the P&L's own maintenance line is in this file. The rest")
    print("  is tires, PM service or repairs paid outside Truck Max -- not invented")
    print("  here, and not something this module can attribute to a truck.")

    if a.csv:
        out = ROOT / a.csv
        df.to_csv(out, index=False)
        print(f"\nfull table -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
