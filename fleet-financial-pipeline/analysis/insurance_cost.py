"""Insurance cost per company per week, from the policies rather than from an allocation.

Every line here is priced on a different basis, and using one basis for all of
them is the mistake this module exists to prevent:

    per scheduled unit   auto liability ($15,992/unit-yr), excess cargo ($300),
                         non-trucking liability ($35/unit-month)
    per dollar of value  physical damage -- 4.50% of Total Insured Value a year
    per dollar of gross  ZONE's motor truck cargo -- $0.70 per $100 of revenue
    PER MILE             XTRACK's second cargo layer -- $1.43 per 100 miles
    per owner-operator   occupational accident -- $107 a month

So a truck that stops running still costs its auto liability, its excess cargo
and its physical damage in full, stops costing the mileage-rated cargo entirely,
and stops costing the revenue-rated cargo entirely. Spreading a single "insurance
per truck" number over the fleet gets the idle-truck question exactly backwards.

WHAT IS ALLOCATED AND WHAT IS MEASURED. The per-unit lines are allocated on the
units each company actually runs, resolved through ingest/fleet_registry.py --
that is measurement, not judgement, because the policy schedules the units by
VIN and the registry says who was running each one. The physical damage is
allocated on the stated value of those same units. Only the trailers are a
genuine estimate: 104 of them at $4,349,304 with no company column anywhere, so
they follow the power-unit share and are reported separately so that assumption
stays visible.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))

REGISTER = ROOT / "config/insurance.json"
WEEKS = 52.0


def load():
    return json.loads(REGISTER.read_text())


def policy(reg, **match):
    for p in reg["policies"]:
        if all(p.get(k) == v for k, v in match.items()):
            return p
    raise KeyError(match)


def per_company(reg, gross_per_week=None, miles_per_week=None):
    """Annual cost per company, line by line, with the basis named for each."""
    al = reg["allocation"]["auto_liability"]
    pdal = reg["allocation"]["physical_damage"]["from_the_submitted_schedule"]
    pdpol = policy(reg, coverage="vehicle_physical_damage_and_non_trucking_liability")
    cargo_z = policy(reg, coverage="motor_truck_cargo")
    cargo_x = policy(reg, coverage="motor_truck_cargo_second_layer")
    excess = policy(reg, coverage="excess_motor_truck_cargo")

    units_total = sum(pdal[c]["units"] for c in ("ZONE", "XTRACK", "AFG", "not_matched"))
    tiv_units = pdal["total"]["tiv"]
    # Premium is written on the operator's stated TIV; the schedule only splits it.
    vpd_total = pdpol["vpd_annual"]
    trailer_tiv = pdpol["schedule_submitted_at_renewal"]["trailer_tiv"]
    unit_tiv = pdpol["schedule_submitted_at_renewal"]["power_unit_tiv"]
    unit_share_of_tiv = unit_tiv / (unit_tiv + trailer_tiv)

    out = {}
    for co in ("ZONE", "XTRACK", "AFG"):
        share_units = pdal[co]["units"] / units_total
        share_value = pdal[co]["tiv"] / tiv_units
        lines = {
            "auto_liability": al[co]["annual"],
            "physical_damage_power_units": vpd_total * unit_share_of_tiv * share_value,
            "physical_damage_trailers_ESTIMATED": vpd_total * (1 - unit_share_of_tiv) * share_units,
            "non_trucking_liability": pdpol["rate"]["non_trucking_liability_per_unit_month"]
                                      * pdal[co]["units"] * 12,
        }
        if co == "ZONE":
            lines["motor_truck_cargo"] = cargo_z["annual_total"]
            lines["excess_motor_truck_cargo"] = excess["annual_total"]
        if co == "XTRACK":
            lines["motor_truck_cargo_second_layer"] = cargo_x["annual_total"]
        if co == "AFG":
            lines["progressive_own_policy"] = policy(reg, entity="AFG")["annual_total"]
        out[co] = lines
    return out


def unallocated(reg):
    """What no company carries, because the units are on no P&L."""
    al = reg["allocation"]["auto_liability"]
    pdal = reg["allocation"]["physical_damage"]["from_the_submitted_schedule"]
    pdpol = policy(reg, coverage="vehicle_physical_damage_and_non_trucking_liability")
    sched = pdpol["schedule_submitted_at_renewal"]
    unit_share = sched["power_unit_tiv"] / (sched["power_unit_tiv"] + sched["trailer_tiv"])
    return {"auto_liability_on_units_in_no_pnl": al["not_in_any_pnl"]["annual"],
            "physical_damage_on_units_not_resolved":
                pdpol["vpd_annual"] * unit_share * pdal["not_matched"]["tiv"] / pdal["total"]["tiv"],
            "_note": al["_finding"]}


def controls(reg, by_co):
    fails = []
    pdpol = policy(reg, coverage="vehicle_physical_damage_and_non_trucking_liability")
    if pdpol["vpd_annual"] != pdpol["tiv_at_submission"] * pdpol["rate"][
            "vehicle_physical_damage_annual_pct_of_tiv"]:
        fails.append(("physical damage premium is not the rate times the TIV", None))
    al = reg["allocation"]["auto_liability"]
    got = sum(by_co[c]["auto_liability"] for c in by_co) + al["not_in_any_pnl"]["annual"]
    master = policy(reg, role="group master policy")
    # $5, not $0: the allocation in config/insurance.json is stored in whole
    # dollars, so the four shares cannot sum to the cent.
    if abs(got - master["annual_total"]) > 5:
        fails.append(("allocated auto liability vs the policy", round(got - master["annual_total"])))
    pd_alloc = sum(v["physical_damage_power_units"] + v["physical_damage_trailers_ESTIMATED"]
                   for v in by_co.values())
    if pd_alloc > pdpol["vpd_annual"] + 1:
        fails.append(("more physical damage allocated than the policy costs",
                      round(pd_alloc - pdpol["vpd_annual"])))
    return fails


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trucks", type=int, default=47,
                    help="company-driver + owner-operator trucks, for the per-truck line")
    a = ap.parse_args()
    reg = load()
    by = per_company(reg)
    fails = controls(reg, by)
    print("controls: all pass" if not fails else "CONTROLS FAILED:")
    for what, v in fails:
        print(f"  {what}: {v}")

    names = sorted({k for v in by.values() for k in v})
    print(f"\n== ANNUAL INSURANCE COST BY COMPANY ==")
    print(f"  {'line':<38}" + "".join(f"{c:>13}" for c in by) + f"{'total':>13}")
    for n in names:
        row = [by[c].get(n, 0.0) for c in by]
        print(f"  {n:<38}" + "".join(f"{v:>13,.0f}" for v in row) + f"{sum(row):>13,.0f}")
    tot = {c: sum(v.values()) for c, v in by.items()}
    print(f"  {'TOTAL ANNUAL':<38}" + "".join(f"{tot[c]:>13,.0f}" for c in by)
          + f"{sum(tot.values()):>13,.0f}")
    print(f"  {'PER WEEK':<38}" + "".join(f"{tot[c] / WEEKS:>13,.0f}" for c in by)
          + f"{sum(tot.values()) / WEEKS:>13,.0f}")
    pdal = reg["allocation"]["physical_damage"]["from_the_submitted_schedule"]
    print(f"  {'units on the schedule':<38}"
          + "".join(f"{pdal[c]['units']:>13}" for c in by))
    print(f"  {'PER TRUCK-WEEK':<38}"
          + "".join(f"{tot[c] / WEEKS / pdal[c]['units']:>13,.0f}" for c in by))

    u = unallocated(reg)
    print("\n== CARRIED BY NOBODY ==")
    for k, v in u.items():
        if not k.startswith("_"):
            print(f"  {k:<48}{v:>12,.0f}/yr{v / WEEKS:>10,.0f}/wk")
    print(f"  {u['_note']}")

    cx = policy(reg, coverage="motor_truck_cargo_second_layer")
    cz = policy(reg, coverage="motor_truck_cargo")
    print("\n== THE TWO LINES THAT ARE NOT PER TRUCK ==")
    print(f"  XTRACK second cargo layer   ${cx['rate_per_mile']:.4f} per mile "
          f"(${cx['annual_total']:,.0f} estimated on {cx['estimated_miles']:,} miles)")
    print(f"  ZONE motor truck cargo      {cz['rate_per_100_of_gross']:.2f}% of gross "
          f"(${cz['annual_total']:,.0f} a year)")
    print("  Neither is charged on a truck that does not move; every other line is.")


if __name__ == "__main__":
    main()
