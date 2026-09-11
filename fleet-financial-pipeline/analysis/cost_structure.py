"""Overhead, fixed cost and variable cost for each company, and the group total.

Two halves, and the second is the point.

WHAT THE SHEET CARRIES. The weekly P&L's own structure, measured line by line:
rent and admin per truck-week, fuel and pay and tolls per loaded mile, and
company overhead taken as a residual from an identity that cannot drift
(`gross - net - CD block cost - OO cost`), then split fixed/variable on the
proportions of its own named components.

WHAT THE SHEET DOES NOT CARRY. Registration, fuel tax and state road taxes have
NO COLUMN ANYWHERE in the weekly P&L. They are not buried in overhead either --
overhead here is a residual of the sheet's own gross and net, so a cost the sheet
never recorded cannot be inside it. Every one of these is measured from a
document filed with a government:

    IRP plates + federal HVUT   data/raw/permits/      fixed, per truck-year
    IFTA fuel tax               the quarterly returns  variable, per mile
    Oregon weight-mile tax      the monthly OR returns variable, per mile

So the group's true cost per truck is higher than any figure the sheets can
produce, and the gap is not an estimate -- it is the sum of filings.

FIXED AND VARIABLE ARE DECIDED BY MEASUREMENT, NOT BY CATEGORY. A line is fixed
if it is charged per truck-week whether the truck moves or not, and variable if
it scales with miles or with revenue. Rent is fixed with a per-mile Iron Lease
component; insurance is mostly fixed but XTRACK's second cargo layer is priced
per mile; Tashkent is 27.5% base salary and the rest commission. Sorting by the
name of the account instead would put all of insurance in fixed and all of
Tashkent in variable, and both would be wrong.

THE OWNER-OPERATOR CAVEAT APPLIES THROUGHOUT. Everything per-truck here prices a
COMPANY-DRIVER truck. Owner-operators carry their own equipment and fuel, and on
XTRACK and AFG they are 43% of the fleet.
"""
import argparse
import functools
import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import parse_irp as IRP              # noqa: E402
import parse_oregon as OR            # noqa: E402
import parse_tax_and_insurance as TAX  # noqa: E402
import registration as REG           # noqa: E402
import truck_breakeven as B          # noqa: E402

COMPANIES = ("ZONE", "XTRACK", "AFG")
WEEKS_PER_YEAR = 52.0
# The IFTA account each company files under. ZONE files as ZONE-OH.
IFTA_NAME = {"ZONE": "ZONE-OH", "XTRACK": "XTRACK", "AFG": "AFG"}
# The Oregon account each company files under. AFG has none on record -- and its
# own IFTA return says it ran 1,364 Oregon miles in 2026 Q2, so `None` here means
# "no account found", never "no Oregon exposure". analysis/oregon_gap.py prices
# what is owed and unfiled; this module only carries what was actually paid.
OREGON_CARRIER = {"ZONE": "ZONE OH LLC", "XTRACK": "XTRACK LLC", "AFG": None}
# Only the quarters whose returns are in the corpus for every company, so the
# per-mile rate is not a different period for each one.
TAX_QUARTERS = ("03/31/2026", "3/31/2026", "06/30/2026", "6/30/2026")


@functools.lru_cache(maxsize=None)
def _ifta():
    return tuple(TAX.load_ifta())


@functools.lru_cache(maxsize=None)
def _oregon():
    return tuple(OR.load())


def fuel_tax_per_mile(company):
    """IFTA tax over IFTA miles, from the returns themselves.

    Per MILE, not per truck: it is a tax on distance. Using the returns for both
    numerator and denominator keeps it internally consistent even where the
    returns disagree with the sheet about the miles.
    """
    name = IFTA_NAME[company]
    rs = [r for r in _ifta()
          if name in (r.get("legal_name") or "").upper()
          and str(r.get("period_end")) in TAX_QUARTERS
          and r.get("tax_due") and r.get("total_miles")]
    if not rs:
        return None
    tax = sum(r["tax_due"] for r in rs)
    miles = sum(r["total_miles"] for r in rs)
    return {"tax": tax, "miles": miles, "per_mile": tax / miles,
            "quarters": len(rs)}


def oregon_per_mile(company, fuel):
    """Oregon weight-mile tax, spread over the same IFTA miles.

    Oregon is charged on Oregon miles only, but it is carried here as a rate over
    ALL miles because that is how it lands on a truck the fleet dispatches
    anywhere: a cost per mile run, not a cost per Oregon mile.
    """
    carrier = OREGON_CARRIER[company]
    if not carrier or not fuel:
        return None
    rs = [r for r in _oregon() if r["carrier"] == carrier and r["year"] == 2026
          and r["month"] in ("January", "February", "March", "April", "May", "June")]
    if not rs:
        return None
    tax = sum(r["tax"] for r in rs)
    return {"tax": tax, "months": len(rs), "oregon_miles": sum(r["oregon_miles"] for r in rs),
            "per_mile": tax / fuel["miles"]}


@functools.lru_cache(maxsize=None)
def _registration():
    """The IRP workbook, the fleet registry and the attribution, done once.

    Each was being rebuilt per company -- and the fleet registry alone reads a
    1,413-row workbook -- which with the Oregon OCR on top ran the module past
    ten minutes.
    """
    payments, red, ref = IRP.read()
    fails, _ = IRP.controls(payments, red, ref)
    if fails:
        return None
    per_truck = IRP.per_unit(payments)
    idx = REG.unit_index()
    by_co, _, _ = REG.attribute(per_truck, idx)
    counts = {}
    for u in per_truck:
        co = _company_of(u, idx)
        counts[co] = counts.get(co, 0) + 1
    return by_co, counts


def registration_per_truck_week(company):
    got = _registration()
    if not got:
        return None
    by_co, counts = got
    trucks = counts.get(company, 0)
    if not trucks or company not in by_co:
        return None
    return {"annual": by_co[company], "trucks": trucks,
            "per_truck_week": by_co[company] / trucks / WEEKS_PER_YEAR}


@functools.lru_cache(maxsize=None)
def registration_corrected_per_truck_week():
    """The same $/truck-week question, answered with `registration.py`'s
    responsibility attribution (2026-09-10) instead of the plain
    who-last-ran-it split registration_per_truck_week() uses. Owner-
    operators, named investors, lease-to-purchase owners and sold/departed
    drivers now bear their own IRP/HVUT; what is left is split equally
    across ZONE/XTRACK/AFG (operator instruction) and spread evenly across
    the 90-truck RUNNING fleet (not just the 48 trucks a registration
    payment happens to name) -- a single group-wide rate, not a
    per-company one, because the equal-company-split step already removed
    the per-company skew the OLD figure carried from folding each
    company's own owner-operator trucks into its own average.
    """
    payments, red, ref = IRP.read()
    fails, _ = IRP.controls(payments, red, ref)
    if fails:
        return None
    idx = REG.unit_index()
    _, _, pool = REG.attribute_by_responsibility(payments, idx)
    fleet = sum(REG.RUNNING_FLEET.values())
    return pool["pool"] / fleet / WEEKS_PER_YEAR


def _company_of(unit, idx):
    rows = idx.get(str(unit))
    if not rows:
        return None
    return max(rows, key=lambda r: r.get("last_week") or "").get("company")


def structure(company, weeks=13):
    """Every cost line, on its own basis, with fixed and variable kept apart."""
    m = B.model(company, weeks)
    fuel = fuel_tax_per_mile(company)
    ore = oregon_per_mile(company, fuel)
    reg = registration_per_truck_week(company)
    reg_corrected = registration_corrected_per_truck_week()

    fixed = {
        "truck rent, base": m["rent_base_per_week"],
        "admin / insurance / trailer": m["admin_per_truck_week"],
        "fixed company overhead": m["fixed_overhead_per_truck_week"],
    }
    outside_fixed = {"IRP plates + HVUT": reg["per_truck_week"] if reg else None}

    variable = {f: m["per_mile_" + f] for f in
                ("fuel", "driver_pay", "toll", "additional", "other")}
    variable["Iron Lease mileage charge"] = m["rent_per_mile"]
    outside_variable = {
        "IFTA fuel tax": fuel["per_mile"] if fuel else None,
        "Oregon weight-mile tax": ore["per_mile"] if ore else None,
    }

    return {
        "company": company, "m": m, "fuel": fuel, "oregon": ore, "reg": reg,
        "reg_corrected": reg_corrected,
        "fixed": fixed, "outside_fixed": outside_fixed,
        "variable": variable, "outside_variable": outside_variable,
        "fixed_total": sum(fixed.values()),
        "outside_fixed_total": sum(v for v in outside_fixed.values() if v),
        "fixed_total_corrected": sum(fixed.values()) + (reg_corrected or 0),
        "variable_total": sum(variable.values()),
        "outside_variable_total": sum(v for v in outside_variable.values() if v),
        "overhead_pct_of_gross": m["overhead_pct_of_gross"],
    }


def controls(s):
    """Nothing may be counted twice, and nothing may quietly become zero."""
    fails = []
    m = s["m"]
    if abs(s["fixed_total"] - (m["running_fixed"] + m["fixed_overhead_per_truck_week"])) > 1:
        fails.append("the sheet's fixed lines do not sum to its own break-even base")
    if abs(s["variable_total"] - m["cost_per_mile"]) > 0.0001:
        fails.append("the sheet's per-mile lines do not sum to its own cost per mile")
    # A missing filing must read as MISSING, never as zero -- a company with no
    # return in the corpus would otherwise look like the cheapest to run.
    for k, v in {**s["outside_fixed"], **s["outside_variable"]}.items():
        if v is not None and v <= 0:
            fails.append(f"{k} priced at zero rather than reported as missing")
    return fails


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weeks", type=int, default=13)
    ap.add_argument("--explain", action="store_true",
                    help="show how every fixed line was derived, with its inputs")
    a = ap.parse_args()
    ss = {c: structure(c, a.weeks) for c in COMPANIES}
    W = 13

    bad = {c: controls(s) for c, s in ss.items()}
    if any(bad.values()):
        print("CONTROLS FAILED:")
        for c, f in bad.items():
            for x in f:
                print(f"  {c}: {x}")
    else:
        print("controls: all pass")

    def row(label, get, fmt=",.0f", indent=2):
        cells = []
        for c in COMPANIES:
            v = get(ss[c])
            cells.append(f"{'--':>{W}}" if v is None else f"{v:>{W}{fmt}}")
        print(" " * indent + f"{label:<38}" + "".join(cells))

    print(f"\n{'=' * 79}")
    print(f"COST STRUCTURE PER COMPANY-DRIVER TRUCK, {a.weeks} WEEKS")
    print(f"{'=' * 79}")
    print(f"  {'':<38}" + "".join(f"{c:>{W}}" for c in COMPANIES))
    print(f"  {'period':<38}" + "".join(
        f"{ss[c]['m']['from'][5:] + '..' + ss[c]['m']['to'][5:]:>{W}}" for c in COMPANIES))

    print("\n  FIXED -- charged whether the truck moves or not, $/truck-week")
    for k in ss["ZONE"]["fixed"]:
        row(k, lambda s, k=k: s["fixed"][k])
    row("subtotal, in the sheet", lambda s: s["fixed_total"])
    print("\n    not in the sheet -- no column exists for these")
    for k in ss["ZONE"]["outside_fixed"]:
        row("  " + k, lambda s, k=k: s["outside_fixed"][k], indent=4)
    row("TRUE FIXED PER TRUCK-WEEK",
        lambda s: s["fixed_total"] + s["outside_fixed_total"])
    row("  per truck-DAY", lambda s: (s["fixed_total"] + s["outside_fixed_total"]) / 7)
    # The registration file is a PARTIAL record -- $9,648 of registration debits
    # in the bank are on no line of it -- so its per-truck rate is the cost of a
    # truck it covers, and the coverage is stated rather than assumed away.
    row("  registration file covers, of",
        lambda s: s["reg"]["trucks"] if s["reg"] else None)
    row("  company-driver trucks running",
        lambda s: s["m"]["cd_trucks"], ",.1f")
    print("    The registration file names 48 trucks against a group fleet of 93, so")
    print("    that line is the cost of a truck it COVERS. Applying it fleet-wide")
    print("    assumes the unlisted trucks cost the same; the bank says $9,648 of")
    print("    registration debits are on no line of the file, so it is a floor.")

    print("\n  REGISTRATION, CORRECTED FOR WHO ACTUALLY BEARS IT (2026-09-10)")
    print("    Owner-operators, named investors, lease-to-purchase owners and")
    print("    sold/departed drivers now bear their own IRP/HVUT -- see")
    print("    config/registration_responsibility.json. What is left is split")
    print("    equally across the three companies and spread over the 90-truck")
    print("    running fleet, ONE rate for every truck, not a per-company one:")
    row("  registration, corrected", lambda s: s["reg_corrected"])
    row("TRUE FIXED, CORRECTED REGISTRATION",
        lambda s: s["fixed_total_corrected"])
    row("  per truck-DAY, corrected", lambda s: s["fixed_total_corrected"] / 7)

    print("\n  VARIABLE -- scales with distance, $/loaded mile")
    for k in ss["ZONE"]["variable"]:
        row(k, lambda s, k=k: s["variable"][k] or None, ",.4f")
    row("subtotal, in the sheet", lambda s: s["variable_total"], ",.4f")
    print("\n    not in the sheet")
    for k in ss["ZONE"]["outside_variable"]:
        row("  " + k, lambda s, k=k: s["outside_variable"][k], ",.4f", indent=4)
    row("TRUE VARIABLE PER LOADED MILE",
        lambda s: s["variable_total"] + s["outside_variable_total"], ",.4f")

    print("\n  VARIABLE -- scales with revenue, % of gross")
    row("company overhead (commission,", lambda s: 100 * s["overhead_pct_of_gross"], ",.2f")
    print(f"  {'  factoring, maintenance)':<38}")

    print("\n  OVERHEAD, THE WHOLE OF IT")
    row("total per week", lambda s: s["m"]["overhead"])
    row("per truck-week", lambda s: s["m"]["overhead_per_truck_week"])
    row("  of which FIXED", lambda s: s["m"]["fixed_overhead_per_truck_week"])
    row("  of which VARIABLE", lambda s: s["m"]["overhead_per_truck_week"]
        - s["m"]["fixed_overhead_per_truck_week"])
    row("trucks it is spread over", lambda s: s["m"]["trucks"], ",.1f")

    print("\n  WHAT A TRUCK MUST COVER, AND WHERE IT BREAKS EVEN")
    row("fixed to cover each week", lambda s: s["fixed_total"] + s["outside_fixed_total"])
    row("miles per truck now", lambda s: s["m"]["miles_per_truck"])
    row("rate per mile now", lambda s: s["m"]["rpm"], ",.3f")
    row("break-even miles (true cost)", lambda s: true_breakeven(s, s["m"]["rpm"]))
    row("  the sheet alone would say", lambda s: B.breakeven_miles(s["m"], s["m"]["rpm"]))
    row("understated by, miles a week",
        lambda s: true_breakeven(s, s["m"]["rpm"]) - B.breakeven_miles(s["m"], s["m"]["rpm"]))
    row("  break-even, corrected registration",
        lambda s: true_breakeven_corrected(s, s["m"]["rpm"]))
    row("  break-even miles per day, corrected",
        lambda s: true_breakeven_corrected(s, s["m"]["rpm"]) / 7)

    print(f"\n{'=' * 79}")
    print("GROUP TOTAL, PER WEEK")
    print(f"{'=' * 79}")
    tot_over = sum(s["m"]["overhead"] for s in ss.values())
    trucks = sum(s["m"]["trucks"] for s in ss.values())
    cd = sum(s["m"]["cd_trucks"] for s in ss.values())
    gross = sum(s["m"]["gross"] for s in ss.values())
    miles = sum(s["m"]["cd_miles"] for s in ss.values())
    fixed_wk = sum((s["fixed_total"] + s["outside_fixed_total"]) * s["m"]["cd_trucks"]
                   for s in ss.values())
    var_wk = sum((s["variable_total"] + s["outside_variable_total"]) * s["m"]["cd_miles"]
                 for s in ss.values())
    print(f"  {'gross':<44}{gross:>14,.0f}")
    print(f"  {'trucks (company-driver + owner-operator)':<44}{trucks:>14,.1f}")
    print(f"  {'company-driver trucks':<44}{cd:>14,.1f}")
    print(f"  {'company overhead':<44}{tot_over:>14,.0f}"
          f"   {100 * tot_over / gross:.1f}% of gross")
    print(f"  {'  per truck-week':<44}{tot_over / trucks:>14,.0f}")
    print(f"  {'fixed cost of the company-driver fleet':<44}{fixed_wk:>14,.0f}")
    print(f"  {'variable cost of the company-driver fleet':<44}{var_wk:>14,.0f}"
          f"   on {miles:,.0f} loaded miles")
    outside_wk = sum(s["outside_fixed_total"] * s["m"]["cd_trucks"]
                     + s["outside_variable_total"] * s["m"]["cd_miles"]
                     for s in ss.values())
    print(f"\n  {'COST THE SHEETS DO NOT CARRY':<44}{outside_wk:>14,.0f} a week"
          f"   ${outside_wk * WEEKS_PER_YEAR:,.0f} a year")
    print("  Registration, fuel tax and Oregon weight-mile tax have no column in")
    print("  any of the three P&Ls, and cannot be hiding in overhead: overhead here")
    print("  is a residual of the sheets' own gross and net, so a cost never")
    print("  recorded cannot be inside it. Every figure above comes from a document")
    print("  filed with a government, not from an estimate.")

    if a.explain:
        explain(ss)

    print("\n  WHERE EACH FIGURE CAME FROM")
    for c in COMPANIES:
        s = ss[c]
        f, o, r = s["fuel"], s["oregon"], s["reg"]
        print(f"    {c}")
        print(f"      IFTA        " + (f"${f['tax']:,.0f} over {f['miles']:,.0f} miles "
              f"on {f['quarters']} return(s) = ${f['per_mile']:.4f}/mi" if f else "no return in the corpus"))
        print(f"      Oregon      " + (f"${o['tax']:,.0f} over {o['months']} monthly returns, "
              f"{o['oregon_miles']:,.0f} Oregon miles = ${o['per_mile']:.4f}/mi" if o
              else "PAID NOTHING -- and its IFTA return shows Oregon miles. "
                   "See analysis/oregon_gap.py"))
        print(f"      registration" + (f"  ${r['annual']:,.0f}/yr over {r['trucks']} trucks "
              f"= ${r['per_truck_week']:.2f}/truck-week" if r else "  not measurable"))


def explain(ss):
    """Where each fixed number came from, with the arithmetic shown.

    Every one of these is a MEASUREMENT over a stated sample, not an allocation
    and not a chart-of-accounts line. Printing the sample size next to the mean
    is the point: a $1,166 rent measured on 300 truck-weeks and a $1,167 rent
    measured on 68 are not the same claim, and the three companies landing
    within $2 of each other is a fact about the lease market, not a rounding.
    """
    for c in COMPANIES:
        s = ss[c]
        m = s["m"]
        print(f"\n{'=' * 79}\n{c}: HOW EACH FIXED LINE WAS DERIVED\n{'=' * 79}")
        print(f"  window {m['from']} .. {m['to']}, {m['weeks']} weeks")
        print(f"  {m['running_truck_weeks'] * m['weeks']:.0f} running company-driver "
              f"truck-weeks (gross > 0) are the sample for the per-truck means")

        print(f"\n  1. TRUCK RENT, BASE                        ${m['rent_base_per_week']:,.2f}")
        print("     A weighted average of two different things, NOT one rent.")
        print(f"       Iron Lease units, from the RATE CARD:  ${m['rent_iron_base']:,.2f}/wk"
              f"  x {100 * m['iron_share']:.1f}% of running truck-weeks")
        print(f"       everything else, measured in the P&L:  ${m['rent_outside_per_week']:,.2f}/wk"
              f"  x {100 * (1 - m['iron_share']):.1f}%")
        print(f"       = {m['iron_share']:.4f} x {m['rent_iron_base']:,.2f} + "
              f"{1 - m['iron_share']:.4f} x {m['rent_outside_per_week']:,.2f} = "
              f"${m['rent_base_per_week']:,.2f}")
        print("     The Iron figure is the CONTRACT, not the charge: a parked Iron truck")
        print("     is billed below its rate card and the difference is absorbed inside")
        print("     Iron Lease. The per-mile part ($0.10/$0.12) is in the variable table.")

        print(f"\n  2. ADMIN / INSURANCE / TRAILER             ${m['admin_per_truck_week']:,.2f}")
        print("     The mean of ONE column of the per-unit block, over running")
        print("     truck-weeks. It is headed 'Insur/Admin/Trl' up to 2026-06-29 and")
        print("     'Pys/Cargo/Admin' after -- the SAME column renamed. Mapping only")
        print("     the later spelling read 3,594 block headers as zero and overstated")
        print("     the company-driver margin by about $0.19 a mile.")
        print(f"     Cross-checked against the actual policies in analysis/insurance_cost.py:")
        print(f"     XTRACK's measured insurance is $440/truck-week against the $459 here,")
        print("     so this column is very nearly insurance at cost plus a little admin.")

        print(f"\n  3. FIXED COMPANY OVERHEAD                  ${m['fixed_overhead_per_truck_week']:,.2f}")
        print("     Overhead is a RESIDUAL from an identity that cannot drift:")
        print(f"       gross {m['gross']:>10,.0f}")
        print(f"       - net {m['net']:>10,.0f}")
        print(f"       - company-driver block cost {m['cd_block_cost']:>10,.0f}")
        print(f"       - owner-operator cost       {m['oo_gross'] - m['oo_result']:>10,.0f}")
        print(f"       = OVERHEAD                  {m['overhead']:>10,.0f} a week")
        print("     NEVER add up the panel's own overhead lines: they sum to 126% of")
        print("     this, because some of what the panel calls overhead is already")
        print("     inside the unit blocks. The components are used only for the RATIO.")
        print(f"     fixed/variable split from those components ({100 * (1 - m['overhead_variable_share']):.1f}% fixed):")
        for k, v in sorted(m["named"].items(), key=lambda kv: -kv[1]):
            kind = ("VARIABLE" if k in ("factoring", "maintenance") else
                    "27.5% fixed" if k == "tashkent" else "fixed")
            print(f"       {k:<16}{v:>10,.0f}   {kind}")
        print(f"     ${m['overhead']:,.0f} x {1 - m['overhead_variable_share']:.4f} fixed "
              f"= ${m['overhead_fixed']:,.0f}, over {m['trucks']:.1f} trucks = "
              f"${m['fixed_overhead_per_truck_week']:,.2f}")
        print(f"     The other ${m['overhead_per_truck_week'] - m['fixed_overhead_per_truck_week']:,.2f} "
              f"is variable and is charged as {100 * m['overhead_pct_of_gross']:.2f}% of gross,")
        print("     not per truck -- counting it in both places halves the answer.")

        r = s["reg"]
        print(f"\n  4. IRP PLATES + HVUT                       "
              f"${r['per_truck_week']:,.2f}" if r else "\n  4. IRP PLATES + HVUT   not measurable")
        if r:
            print("     The only line here that is NOT from the P&L -- there is no")
            print("     registration column anywhere in the weekly sheets.")
            print(f"       ${r['annual']:,.0f} a year, attributed to {c} by the company whose")
            print(f"       P&L last carried each truck, over {r['trucks']} trucks it covers")
            print(f"       = ${r['annual']:,.0f} / {r['trucks']} / 52 = ${r['per_truck_week']:,.2f}")
            print("     HVUT is a flat $550 a truck-year and every group payment divides")
            print("     by it exactly; IRP is apportioned on miles and weight and runs")
            print("     $438 to $1,430 a truck, so this is an average of a real spread.")
            print("     The file covers 48 trucks of a group fleet of 93 and the newest")
            print("     trucks are not registered yet, so it is a FLOOR.")


def true_breakeven(s, rpm):
    """Break-even miles once the filings are included."""
    kept = rpm * (1 - s["overhead_pct_of_gross"]) - (
        s["variable_total"] + s["outside_variable_total"])
    fixed = s["fixed_total"] + s["outside_fixed_total"]
    return fixed / kept if kept > 0 else float("inf")


def true_breakeven_corrected(s, rpm):
    """Same as true_breakeven(), but with registration_corrected_per_truck_
    week()'s responsibility-based rate in place of the plain who-last-ran-it
    one -- see registration_corrected_per_truck_week()'s docstring."""
    kept = rpm * (1 - s["overhead_pct_of_gross"]) - (
        s["variable_total"] + s["outside_variable_total"])
    return s["fixed_total_corrected"] / kept if kept > 0 else float("inf")


if __name__ == "__main__":
    main()
