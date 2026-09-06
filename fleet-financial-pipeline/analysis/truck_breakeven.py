"""What one truck costs standing still, what it costs per mile, and where it breaks even.

BUILT FROM THREE MEASURED PIECES, not from a chart of accounts:

1. WHAT A PARKED TRUCK IS ACTUALLY CHARGED. 65 company-driver truck-weeks in the
   last 13 weeks earned nothing. Their mean bill is the fixed cost of a truck,
   observed rather than assumed -- rent, admin and insurance, a little standing
   DEF and fee, occasional downtime pay.

2. EACH COST LINE MEASURED ON ITS OWN TERMS, not fitted. Least squares on total
   block cost was wrong twice over and both errors were invisible inside a good
   R-squared:

     RENT is not per-mile. Fitting it returned $0.1428/mile, which is not a rate
     anybody charges. Rent is a BASE plus, on an Iron Lease truck only, $0.10 or
     $0.12 a mile -- and checked truck by truck the rate card is followed almost
     exactly (15862 charged $1,011 against $1,012 due). The slope was the
     regression confusing WHICH TRUCK with HOW MANY MILES: outside-leased trucks
     pay a flat ~$1,200 a week and the ones that run more miles happen to sit on
     dearer leases.

     FUEL came back at $0.7210/mile when the fleet actually paid $0.8657. The
     intercept had absorbed $301/week of it as though it were fixed.

   So every line here is measured directly: dollars over loaded miles for the
   ones that scale, dollars over truck-weeks for the ones that do not, and rent
   from the rate card.

3. COMPANY OVERHEAD AS A RESIDUAL, from an identity that cannot drift:

       overhead = gross - net - company-driver block cost - owner-operator cost

   Every term is measured; nothing is allocated by judgement. The residual then
   splits fixed/variable on the proportions of its own named components --
   Tashkent's 27.5/72.5 base-to-commission split, factoring, maintenance, and the
   fixed lines (US office, owners, insurance, trailer rent).

WHY NOT JUST ADD UP THE SHEET'S OVERHEAD LINES: they sum to 126% of the residual.
Some of what the panel lists as overhead is already inside the unit blocks. Using
the identity avoids the double count; using the components only for the RATIO
keeps their information without importing their overlap.

WHAT THIS MODEL IS NOT. It prices a company-driver truck. Owner-operator trucks
carry their own equipment and fuel and break even on completely different
numbers. And a parked truck's cost is what the company was CHARGED, which on an
Iron Lease truck is below the contract rate card -- the difference is absorbed
inside Iron Lease, so the group's true cost of an idle truck is higher still.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
import truck_weeks as T
from xtrack_trend import load as load_weeks
from xtrack_diagnosis import CD_COST_FIELDS

WORKBOOK = {"XTRACK": "data/raw/pnl/88206141-Xtrack_LLC_download.xlsx",
            "ZONE": "data/raw/pnl/4954206d-Zone_LLC_download.xlsx",
            "AFG": "data/raw/pnl/b479b596-AFG__download.xlsx"}
DAYS_PER_WEEK = 7
# A truck that bought more than this much diesel in a week did not stand still.
# Deliberately low: the point is to catch a truck that ran, not to tune a cutoff.
MOVED_THRESHOLD = 50.0
# Tashkent is 27.5% base salary and 72.5% commission -- measured from the payroll
# register, see config/overhead.json. Treating all of it as fixed overstates the
# cost of an idle truck and understates cost per mile.
TASHKENT_VARIABLE = 0.725


WEEKS_PER_YEAR = 52.0


def fit_line(y, x):
    A = np.vstack([np.ones(len(x)), x]).T
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    resid = y - A @ coef
    r2 = 1 - (resid ** 2).sum() / max(((y - y.mean()) ** 2).sum(), 1e-9)
    return float(coef[0]), float(coef[1]), float(r2)


def model(company="XTRACK", weeks=13):
    wk = load_weeks(ROOT / WORKBOOK[company])
    tw = T.truck_weeks(company)
    ks = sorted(wk)[-weeks:]
    b = tw[tw.week.isin(ks)]
    cd, oo = b[b.kind == "company_driver"], b[b.kind == "owner_operator"]
    n = len(ks)
    m = {"company": company, "weeks": n, "from": ks[0], "to": ks[-1],
         "gross": sum(wk[k]["gross"] for k in ks) / n,
         "net": sum(wk[k]["net"] for k in ks) / n,
         "cd_trucks": len(cd) / n, "oo_trucks": len(oo) / n,
         "cd_gross": cd.gross.sum() / n, "cd_miles": cd.miles.sum() / n,
         "cd_block_cost": cd[list(CD_COST_FIELDS)].sum().sum() / n,
         "oo_gross": oo.gross.sum() / n, "oo_result": oo.result.sum() / n}
    m["trucks"] = m["cd_trucks"] + m["oo_trucks"]
    m["overhead"] = (m["gross"] - m["net"] - m["cd_block_cost"]
                     - (m["oo_gross"] - m["oo_result"]))

    run = cd[cd.gross > 0]
    m["running_truck_weeks"] = len(run) / n
    m["miles_per_running_truck"] = run.miles.sum() / len(run)
    # Per LOADED MILE, measured. Rent is excluded here and handled explicitly.
    for f in ("driver_pay", "fuel", "toll", "additional", "other"):
        m["per_mile_" + f] = run[f].sum() / run.miles.sum()
    m["per_mile_variable"] = sum(m["per_mile_" + f] for f in
                                 ("driver_pay", "fuel", "toll", "additional", "other"))
    # Flat per truck-week, measured.
    m["admin_per_truck_week"] = run.admin.mean()
    # Rent, from the rate card where there is one and measured where there is not.
    iron, outside = run[run.iron_leased], run[~run.iron_leased]
    m["iron_share"] = len(iron) / len(run)
    m["rent_outside_per_week"] = outside.rent.mean() if len(outside) else 0.0
    if len(iron):
        base = iron.unit.map(lambda u: T.IRON_RATE_CARD[u][0])
        rate = iron.unit.map(lambda u: T.IRON_RATE_CARD[u][1])
        m["rent_iron_base"] = base.mean()
        m["rent_iron_per_mile"] = float((rate * iron.miles).sum() / iron.miles.sum())
    else:
        m["rent_iron_base"], m["rent_iron_per_mile"] = 0.0, 0.0
    # Fleet-weighted: what an average company-driver truck carries.
    m["rent_base_per_week"] = (m["iron_share"] * m["rent_iron_base"]
                               + (1 - m["iron_share"]) * m["rent_outside_per_week"])
    m["rent_per_mile"] = m["iron_share"] * m["rent_iron_per_mile"]
    m["cost_per_mile_measured"] = m["per_mile_variable"] + m["rent_per_mile"]
    m["fuel_per_gallon"] = run.fuel.sum() / run.gallons.sum()
    m["mpg"] = run.odo.sum() / run.gallons.sum()

    # A ZERO-GROSS WEEK IS NOT THE SAME AS A PARKED TRUCK. Some of them burned
    # $450 of diesel and paid a driver, which a truck standing in a yard cannot
    # do -- those are trucks that MOVED and whose revenue landed in another week
    # or another block. The money says so, the gross column does not, and the
    # test that they are really still is that fuel and driver pay come out at
    # exactly zero once they are excluded. Including them overstated the cost of
    # a parked truck by 15% for ZONE and XTRACK and 69% for AFG, and it is where
    # the "standing DEF and fees" line came from.
    zero = cd[cd.gross <= 0]
    moved = (zero.fuel.abs() > MOVED_THRESHOLD) | (zero.driver_pay.abs() > MOVED_THRESHOLD)
    parked = zero[~moved]
    m["zero_gross_weeks"] = len(zero)
    m["moved_but_no_gross_weeks"] = int(moved.sum())
    m["moved_but_no_gross_cost"] = (zero[moved][list(CD_COST_FIELDS)].sum(axis=1).mean()
                                    if moved.any() else 0.0)
    m["parked_weeks"] = len(parked)
    m["parked_cost"] = parked[list(CD_COST_FIELDS)].sum(axis=1).mean()
    m["parked_lines"] = {f: parked[f].mean() for f in CD_COST_FIELDS}
    m["running_fixed"] = m["rent_base_per_week"] + m["admin_per_truck_week"]
    m["cost_per_mile"] = m["cost_per_mile_measured"]
    # kept only as a cross-check; see the docstring for why it is not the model
    a, sl, r2 = fit_line(cd[list(CD_COST_FIELDS)].sum(axis=1).values, cd.miles.values)
    m["fitted_fixed"], m["fitted_per_mile"], m["fit_r2"] = a, sl, r2

    # Split the overhead residual on the ratio of its own named components.
    named = {"us_office": sum(abs(wk[k]["overhead"] - wk[k]["tashkent"]
                                 - wk[k]["other_charges"]) for k in ks) / n,
             "tashkent": sum(wk[k]["tashkent"] for k in ks) / n,
             "other_charges": sum(wk[k]["other_charges"] for k in ks) / n,
             "insurance": sum(wk[k]["insurance"] for k in ks) / n,
             "maintenance": sum(wk[k]["maintenance"] for k in ks) / n,
             "factoring": sum(wk[k]["factoring"] for k in ks) / n,
             "trailer": sum(wk[k]["trailer"] for k in ks) / n}
    variable_named = (named["tashkent"] * TASHKENT_VARIABLE + named["factoring"]
                      + named["maintenance"])
    fixed_named = (named["us_office"] + named["insurance"] + named["trailer"]
                   + named["tashkent"] * (1 - TASHKENT_VARIABLE))
    m["named"] = named
    m["overhead_variable_share"] = variable_named / (variable_named + fixed_named)
    m["overhead_fixed"] = m["overhead"] * (1 - m["overhead_variable_share"])
    m["overhead_variable"] = m["overhead"] * m["overhead_variable_share"]
    m["overhead_per_truck_week"] = m["overhead"] / m["trucks"]
    m["fixed_overhead_per_truck_week"] = m["overhead_fixed"] / m["trucks"]
    m["overhead_pct_of_gross"] = m["overhead_variable"] / m["gross"]

    m["idle_day_cost"] = (m["parked_cost"] + m["fixed_overhead_per_truck_week"]) / DAYS_PER_WEEK
    # FIXED overhead only. The variable part is already taken off the top in
    # contribution_per_mile() as a percentage of gross; adding the whole $887
    # here subtracts it twice and roughly halves every truck's modelled profit.
    m["breakeven_fixed"] = m["running_fixed"] + m["fixed_overhead_per_truck_week"]
    m["rpm"] = m["cd_gross"] / m["cd_miles"]
    m["miles_per_truck"] = m["cd_miles"] / m["cd_trucks"]

    # The fleet run through the model, both halves: running trucks earn at their
    # own miles and rate, parked ones only cost. It is a model OUTPUT, not a
    # control artefact -- controls() only compares it, so leaving it in there
    # made it invisible to anything that did not run the controls first.
    m["modelled_cd_result"] = (
        weekly_result(m, m["miles_per_running_truck"], m["rpm"]) * m["running_truck_weeks"]
        - (m["parked_cost"] + m["fixed_overhead_per_truck_week"])
        * (m["cd_trucks"] - m["running_truck_weeks"]))
    m["actual_cd_result"] = (m["cd_gross"] - m["cd_block_cost"]
                             - m["overhead"] * (m["cd_trucks"] / m["trucks"]))
    return m


def contribution_per_mile(m, rpm):
    """A dollar of gross does not all reach the truck: commission, factoring and
    the maintenance-linked overhead come off it first."""
    return rpm * (1 - m["overhead_pct_of_gross"]) - m["cost_per_mile"]


def breakeven_miles(m, rpm):
    c = contribution_per_mile(m, rpm)
    return m["breakeven_fixed"] / c if c > 0 else float("inf")


def breakeven_rpm(m, miles):
    if miles <= 0:
        return float("inf")
    return ((m["breakeven_fixed"] / miles) + m["cost_per_mile"]) / (1 - m["overhead_pct_of_gross"])


def weekly_result(m, miles, rpm):
    return miles * contribution_per_mile(m, rpm) - m["breakeven_fixed"]


def registration_per_truck_week():
    """IRP plates and HVUT, per truck per week, from data/raw/permits/.

    Returns None rather than 0.0 when the file is not in the corpus: a zero here
    would silently claim registration is free, which is the failure this whole
    module exists to avoid. The container is ephemeral and data/raw is
    gitignored, so absence is the normal case after a reclaim.
    """
    try:
        import parse_irp as R
        payments, red, _ = R.read()
    except Exception:
        return None
    per = R.per_unit(payments)
    return (R.grand_total(payments, red) / len(per) / WEEKS_PER_YEAR) if per else None


def controls(m):
    """The model must reproduce the company's own bottom line."""
    fails = []
    # 5%, not 0: the owner-operator blocks do not reconstruct as exactly as the
    # company-driver ones (different column layout), and the sheet carries an
    # unallocated gap of its own -- see analysis/xtrack_trend.py. A wider miss
    # than this means a cost line has been dropped or double-counted.
    rebuilt = (m["cd_gross"] - m["cd_block_cost"]) + m["oo_result"] - m["overhead"]
    m["rebuild_gap"] = rebuilt - m["net"]
    # 10%: the owner-operator blocks reconstruct less exactly than the
    # company-driver ones and their layout varies more in the earlier weeks, so
    # the gap widens with the window. The gap is always printed, not just
    # checked.
    if abs(rebuilt - m["net"]) > 0.10 * abs(m["net"]):
        fails.append(("rebuilt net vs the sheet's net", round(rebuilt - m["net"], 2)))
    predicted = m["running_fixed"] + m["cost_per_mile"] * m["miles_per_truck"]
    actual = m["cd_block_cost"] / m["cd_trucks"]
    if abs(predicted - actual) > 0.05 * actual:
        fails.append(("fitted vs actual block cost per truck-week", round(predicted - actual)))
    # The control that catches a double-counted overhead: run the model at the
    # fleet's own miles and rate and it must land on the fleet's own result.
    #
    # Both halves, not one. This module produces two figures -- what a RUNNING
    # truck earns and what a PARKED one costs -- and the fleet is a mix. Pricing
    # every company-driver truck as though it were running charged the parked
    # ones a running truck's rent and missed by 12.5% on ZONE, 9.6% on XTRACK
    # and 0.2% on AFG: exactly their share of parked truck-weeks, in order. That
    # was the control mis-stated, not the model wrong.
    if abs(m["modelled_cd_result"] - m["actual_cd_result"]) > 0.10 * abs(m["actual_cd_result"]):
        fails.append(("model run at the fleet's own miles and rate vs its actual "
                      "company-driver result", round(m["modelled_cd_result"] - actual)))
    if not 0 < m["overhead_variable_share"] < 1:
        fails.append(("overhead variable share out of range", m["overhead_variable_share"]))
    if m["parked_cost"] >= m["running_fixed"]:
        fails.append(("a parked truck costs at least as much as a running truck's "
                      "fixed base -- check the rent read", round(m["parked_cost"])))
    return fails


def idle_cost(company="XTRACK", weeks=None):
    """Restate every idle truck-week at fixed cost PLUS its share of fixed overhead.

    Charging only what the P&L billed the truck understates it: overhead does not
    pause when a truck does. Rent, insurance, the US office and the Tashkent base
    payroll all keep running against a fleet that is one truck smaller in
    earning terms and no smaller in cost terms.
    """
    tw = T.truck_weeks(company)
    all_weeks = sorted(tw.week.unique())
    ks = all_weeks[-weeks:] if weeks else all_weeks
    m = model(company, len(ks))
    cd = tw[(tw.kind == "company_driver") & tw.week.isin(ks)]
    sit = cd[cd.gross <= 0]
    billed = sit[list(CD_COST_FIELDS)].sum().sum()
    overhead = len(sit) * m["fixed_overhead_per_truck_week"]
    return {"weeks": len(ks), "idle_truck_weeks": len(sit),
            "billed_to_the_truck": billed, "fixed_overhead_they_absorbed": overhead,
            "true_cost": billed + overhead,
            "per_week_of_the_period": (billed + overhead) / len(ks),
            "per_idle_truck_week": (billed + overhead) / len(sit),
            "per_idle_truck_day": (billed + overhead) / len(sit) / DAYS_PER_WEEK}


def compare(companies=("ZONE", "XTRACK", "AFG"), weeks=13):
    """Break-even for each company side by side.

    They are NOT the same business and the model must not flatten them: the
    company-driver share, the Iron Lease share, the parked share and the
    overhead per truck all differ, and each of those moves break-even on its
    own. What is comparable is the METHOD, not the numbers.
    """
    ms = {c: model(c, weeks) for c in companies}
    W = 13

    def row(label, fn, fmt=",.0f"):
        print(f"  {label:<36}" + "".join(f"{fn(ms[c]):>{W}{fmt}}" for c in companies))

    print(f"== BREAK-EVEN, {weeks} WEEKS, EACH COMPANY ON ITS OWN SHEET ==")
    print(f"  {'':<36}" + "".join(f"{c:>{W}}" for c in companies))
    for c in companies:
        pass
    print(f"  {'period':<36}" + "".join(f"{ms[c]['from'][5:] + '..' + ms[c]['to'][5:]:>{W}}"
                                        for c in companies))
    row("gross per week", lambda m: m["gross"])
    row("net per week", lambda m: m["net"])
    row("company-driver trucks", lambda m: m["cd_trucks"], ",.1f")
    row("owner-operator trucks", lambda m: m["oo_trucks"], ",.1f")
    print()
    row("truck rent, base", lambda m: m["rent_base_per_week"])
    row("admin / insurance / trailer", lambda m: m["admin_per_truck_week"])
    row("FIXED COST, RUNNING TRUCK", lambda m: m["running_fixed"])
    row("fixed overhead per truck", lambda m: m["fixed_overhead_per_truck_week"])
    row("= MUST BE COVERED EVERY WEEK", lambda m: m["breakeven_fixed"])
    print()
    row("variable cost per loaded mile", lambda m: m["cost_per_mile"], ",.4f")
    row("variable overhead, % of gross", lambda m: 100 * m["overhead_pct_of_gross"], ",.2f")
    row("fuel $/gal", lambda m: m["fuel_per_gallon"], ",.3f")
    row("mpg", lambda m: m["mpg"], ",.2f")
    print()
    row("miles per truck now", lambda m: m["miles_per_truck"])
    row("rate per mile now", lambda m: m["rpm"], ",.3f")
    row("$ kept per mile at that rate",
        lambda m: contribution_per_mile(m, m["rpm"]), ",.4f")
    row("BREAK-EVEN MILES at that rate",
        lambda m: breakeven_miles(m, m["rpm"]))
    row("headroom, miles a week",
        lambda m: m["miles_per_truck"] - breakeven_miles(m, m["rpm"]))
    row("BREAK-EVEN RATE at those miles",
        lambda m: breakeven_rpm(m, m["miles_per_truck"]), ",.3f")
    print()
    row("cost of a PARKED truck / week", lambda m: m["parked_cost"])
    row("  + fixed overhead it still absorbs",
        lambda m: m["fixed_overhead_per_truck_week"])
    row("  = a lost truck-week costs",
        lambda m: m["parked_cost"] + m["fixed_overhead_per_truck_week"])
    row("  a lost truck-DAY costs", lambda m: m["idle_day_cost"])
    row("parked truck-weeks in the period", lambda m: m["parked_weeks"], ",.0f")

    print("\n== BREAK-EVEN MILES A WEEK, BY RATE ==")
    print(f"  {'RPM':>6}" + "".join(f"{c:>{W}}" for c in companies))
    for rpm in (2.40, 2.60, 2.80, 3.00, 3.20, 3.40):
        cells = []
        for c in companies:
            be = breakeven_miles(ms[c], rpm)
            cells.append(f"{be:>{W},.0f}" if be < 1e6 else f"{'never':>{W}}")
        print(f"  {rpm:>6.2f}" + "".join(cells))
    print("  A truck below its column's figure at that rate loses money that week.")

    print("\n== WEEKLY PROFIT OR LOSS OF ONE TRUCK, BY SCENARIO ==")
    print(f"  {'miles':>7}{'rate':>7}" + "".join(f"{c:>{W}}" for c in companies))
    for miles, rpm in ((2000, 2.60), (2500, 2.60), (2500, 3.00), (3000, 2.80),
                       (3500, 2.80), (3500, 3.00), (4000, 2.60), (4000, 3.00)):
        print(f"  {miles:>7,}{rpm:>7.2f}"
              + "".join(f"{weekly_result(ms[c], miles, rpm):>{W},.0f}" for c in companies))

    print("\n== WHY THE THREE DIFFER ==")
    for c in companies:
        m = ms[c]
        print(f"  {c}: fixed ${m['breakeven_fixed']:,.0f}/wk, "
              f"${m['cost_per_mile']:.4f}/mile, {100 * m['overhead_pct_of_gross']:.2f}% "
              f"off the top.")
        print(f"     {100 * m['iron_share']:.0f}% of running truck-weeks are Iron Lease "
              f"(base ${m['rent_iron_base']:,.0f} vs outside ${m['rent_outside_per_week']:,.0f}), "
              f"{m['oo_trucks'] / m['trucks'] * 100:.0f}% of the fleet is owner-operator,")
        print(f"     and {m['parked_weeks'] / (m['cd_trucks'] * m['weeks']) * 100:.0f}% of "
              f"company-driver truck-weeks earned nothing.")
    print("\n  This prices a COMPANY-DRIVER truck. Owner-operators carry their own")
    print("  equipment and fuel and break even on entirely different numbers, which is")
    print("  why XTRACK's fleet mix matters as much as its costs.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--company", default="XTRACK",
                    help="ZONE, XTRACK, AFG, or 'all' for the comparison")
    ap.add_argument("--weeks", type=int, default=13)
    a = ap.parse_args()
    if a.company.lower() == "all":
        compare(weeks=a.weeks)
        return

    m = model(a.company, a.weeks)
    D = DAYS_PER_WEEK

    print(f"{m['company']}, mean of {m['weeks']} weeks {m['from']} .. {m['to']}")
    print(f"  gross ${m['gross']:,.0f}/wk   net ${m['net']:,.0f}/wk   "
          f"{m['cd_trucks']:.0f} company-driver + {m['oo_trucks']:.0f} owner-operator trucks")
    fails = controls(m)
    print(f"  rebuilt net vs the sheet's own: ${m['rebuild_gap']:+,.0f} "
          f"({100 * m['rebuild_gap'] / m['net']:+.1f}%)")
    print("  controls: all pass" if not fails else "  CONTROLS FAILED:")
    for what, v in fails:
        print(f"    {what}: {v}")

    print("\n== FIXED COST OF ONE COMPANY-DRIVER TRUCK ==")
    print(f"  {'':<34}{'per week':>12}{'per day':>10}")
    for f, v in sorted(m["parked_lines"].items(), key=lambda x: -x[1]):
        if abs(v) < 0.5:
            continue
        print(f"  {f:<34}{v:>12,.0f}{v / D:>10,.0f}")
    print(f"  {'measured on ' + str(m['parked_weeks']) + ' parked truck-weeks':<34}"
          f"{m['parked_cost']:>12,.0f}{m['parked_cost'] / D:>10,.0f}")
    print(f"  {'fixed company overhead, allocated':<34}"
          f"{m['fixed_overhead_per_truck_week']:>12,.0f}"
          f"{m['fixed_overhead_per_truck_week'] / D:>10,.0f}")
    print(f"  {'COST OF A TRUCK THAT DOES NOT MOVE':<34}"
          f"{m['parked_cost'] + m['fixed_overhead_per_truck_week']:>12,.0f}"
          f"{m['idle_day_cost']:>10,.0f}")

    print("\n== WHAT A MILE COSTS (measured: dollars over loaded miles) ==")
    for f in ("fuel", "driver_pay", "toll", "additional", "other"):
        v = m["per_mile_" + f]
        if abs(v) >= 0.0005:
            print(f"  {f:<34}{v:>12.4f}")
    print(f"  {'Iron Lease mileage charge':<34}{m['rent_per_mile']:>12.4f}"
          f"   ({100 * m['iron_share']:.0f}% of truck-weeks x "
          f"${m['rent_iron_per_mile']:.3f})")
    print(f"  {'TOTAL VARIABLE PER LOADED MILE':<34}{m['cost_per_mile']:>12.4f}")
    print(f"  (fuel ${m['fuel_per_gallon']:.3f}/gal at {m['mpg']:.2f} mpg; "
          f"a least-squares fit would say ${m['fitted_per_mile']:.4f} and be wrong -- "
          f"see the module docstring)")
    print(f"  {'variable overhead, % of gross':<34}"
          f"{100 * m['overhead_pct_of_gross']:>11.2f}%"
          f"   (commission, factoring, maintenance)")

    print("\n== BREAK-EVEN BASE ==")
    print(f"  {'truck rent, base only':<34}{m['rent_base_per_week']:>12,.0f}"
          f"   (Iron ${m['rent_iron_base']:,.0f} on {100 * m['iron_share']:.0f}%, "
          f"outside lease ${m['rent_outside_per_week']:,.0f})")
    print(f"  {'admin / insurance / trailer':<34}{m['admin_per_truck_week']:>12,.0f}")
    print(f"  {'fixed cost of a RUNNING truck':<34}{m['running_fixed']:>12,.0f}")
    print(f"  {'fixed company overhead per truck':<34}"
          f"{m['fixed_overhead_per_truck_week']:>12,.0f}")
    print(f"  {'= must be covered every week':<34}{m['breakeven_fixed']:>12,.0f}")
    print(f"  (the variable overhead, {100 * m['overhead_pct_of_gross']:.2f}% of gross, "
          f"is taken off the rate instead -- counting it here too halves the answer)")
    print(f"  today the fleet runs {m['miles_per_truck']:,.0f} loaded miles a week "
          f"at ${m['rpm']:.3f}")
    reg = registration_per_truck_week()
    if reg:
        print(f"\n  NOT IN THAT FIGURE: registration ${reg:.0f}/truck-week "
              f"(IRP plates + HVUT).")
        print("  It is fixed, annual and prepaid -- the same shape as insurance -- and")
        print("  it is deliberately NOT added, because `overhead` here is a RESIDUAL")
        print("  (gross - net - block cost) and would already contain any registration")
        print("  that reached this P&L. Adding it blind double-counts. Settle it by")
        print("  finding a registration line in the panel; until then it is a floor")
        print(f"  of ${reg:.0f} on every per-truck cost in this module, and the true")
        print("  break-even is at most that much higher.")

    print("\n== BREAK-EVEN MILES AT EACH RATE ==")
    print(f"  {'RPM':>6}{'$ kept per mile':>18}{'break-even miles/wk':>22}"
          f"{'per driving day (5)':>21}")
    for rpm in (2.40, 2.60, 2.80, 2.94, 3.00, 3.20, 3.40):
        c = contribution_per_mile(m, rpm)
        be = breakeven_miles(m, rpm)
        print(f"  {rpm:>6.2f}{c:>18.4f}{be:>22,.0f}{be / 5:>21,.0f}")

    print("\n== WEEKLY PROFIT PER TRUCK, MILES x RATE ==")
    rates = (2.40, 2.60, 2.80, 3.00, 3.20)
    miles = (1500, 2000, 2500, 3000, 3500, 4000, 4500)
    print("  " + "miles".ljust(8) + "".join(f"${r:>11.2f}" for r in rates))
    for mi in miles:
        print("  " + f"{mi:,}".ljust(8)
              + "".join(f"{weekly_result(m, mi, r):>12,.0f}" for r in rates))
    print("  (negative = the truck loses money that week after its own costs and "
          "its share of overhead)")

    ic = idle_cost(a.company)
    print(f"\n== WHAT THE IDLE TRUCKS ACTUALLY COST ({ic['weeks']} weeks) ==")
    print(f"  idle truck-weeks                  {ic['idle_truck_weeks']:>12,}")
    print(f"  billed to the truck by the P&L    ${ic['billed_to_the_truck']:>11,.0f}")
    print(f"  fixed overhead they still absorbed ${ic['fixed_overhead_they_absorbed']:>10,.0f}")
    print(f"  TRUE COST                         ${ic['true_cost']:>11,.0f}"
          f"   (${ic['per_week_of_the_period']:,.0f} a week, "
          f"${ic['per_idle_truck_day']:,.0f} per truck-day)")

    print("\n== SCENARIOS ==")
    for mi, rpm in ((3000, 2.80), (2546, 2.968), (3500, 2.60), (4000, 2.50),
                    (2000, 3.20), (2500, 3.00), (4500, 2.40)):
        r = weekly_result(m, mi, rpm)
        need_rpm = breakeven_rpm(m, mi)
        need_mi = breakeven_miles(m, rpm)
        verdict = "PROFIT" if r > 0 else "LOSS  "
        print(f"  {mi:>5,} miles @ ${rpm:.2f}  ->  gross ${mi * rpm:>8,.0f}   "
              f"{verdict} ${r:>8,.0f}/wk   needs ${need_rpm:.2f} at that mileage, "
              f"or {need_mi:,.0f} miles at that rate")


if __name__ == "__main__":
    main()
