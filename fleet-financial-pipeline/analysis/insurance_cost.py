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

ACTUAL BILLING BEATS THE RATE, AND THE DIFFERENCE IS NOT SMALL. The auto
liability is written at $1,087,431.92 and $442,670.66 of it has come back as
RETURN PREMIUM in six credits as units left the schedule -- the effective cost
is $644,761, a 41% reduction, and any allocation of the face premium overstates
it by two thirds. The NTL/PD runs the other way: billed at $598,056 a year
against $576,778 by the rate, because the schedule grew. So this module reads
the ACTUAL where one exists and falls back to the rate only where it does not.

That return premium also settles the idle-truck question. Taking a unit off a
reporting policy does return money -- it is not a sunk annual charge -- so the
21 units that stopped running are worth removing, not just worth noting.

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


def al_scale(reg):
    """Face premium -> effective. One definition, used by every caller.

    The auto liability is a REPORTING policy: $442,670.66 of the $1,087,431.92
    written has come back as return premium. Any two places that compute this
    ratio separately will eventually disagree, and the disagreement shows up as
    a control failure rather than as a wrong number, so it lives here.
    """
    master = policy(reg, role="group master policy")
    eff = master.get("actual", {}).get("effective_annual_cost")
    return (eff / master["annual_total"]) if eff else 1.0


def per_company(reg, gross_per_week=None, miles_per_week=None):
    """Annual cost per company, line by line, with the basis named for each."""
    al = reg["allocation"]["auto_liability"]
    pdal = reg["allocation"]["physical_damage"]["from_the_submitted_schedule"]
    pdpol = policy(reg, coverage="vehicle_physical_damage_and_non_trucking_liability")
    cargo_z = policy(reg, coverage="motor_truck_cargo")
    cargo_x = policy(reg, coverage="motor_truck_cargo_second_layer")
    excess = policy(reg, coverage="excess_motor_truck_cargo")
    own_x = policy(reg, coverage="auto_liability_cargo_pd_gl")

    # The face premium is not the cost. Prefer the ledger's effective figure.
    scale = al_scale(reg)
    # Actual billing where it exists, the rate only where it does not.
    vpd_actual = pdpol.get("actual", {}).get("annualised")
    oac = policy(reg, coverage="occupational_accident")
    oac_actual = oac.get("actual", {}).get("annualised") or 0.0

    units_total = sum(pdal[c]["units"] for c in ("ZONE", "XTRACK", "AFG", "not_matched"))
    tiv_units = pdal["total"]["tiv"]
    # Premium is written on the operator's stated TIV; the schedule only splits it.
    vpd_total = vpd_actual or pdpol["vpd_annual"]
    trailer_tiv = pdpol["schedule_submitted_at_renewal"]["trailer_tiv"]
    unit_tiv = pdpol["schedule_submitted_at_renewal"]["power_unit_tiv"]
    unit_share_of_tiv = unit_tiv / (unit_tiv + trailer_tiv)

    out = {}
    for co in ("ZONE", "XTRACK", "AFG"):
        share_units = pdal[co]["units"] / units_total
        share_value = pdal[co]["tiv"] / tiv_units
        lines = {
            "auto_liability": al[co]["annual"] * scale,
            "physical_damage_power_units": vpd_total * unit_share_of_tiv * share_value,
            "physical_damage_trailers_ESTIMATED": vpd_total * (1 - unit_share_of_tiv) * share_units,
        }
        # The NTL/PD invoice is one bill covering both, so it is not split out.
        if oac_actual:
            lines["occupational_accident"] = oac_actual * share_units
        if co == "ZONE":
            lines["motor_truck_cargo"] = cargo_z["annual_total"]
            lines["excess_motor_truck_cargo"] = excess["annual_total"]
        if co == "XTRACK":
            lines["motor_truck_cargo_second_layer"] = cargo_x["annual_total"]
            # XTRACK's own Benchmark/Great American package. It was in the
            # register and missing from this table, which understated XTRACK by
            # $63,722 a year. The CASH cost is $67,120 -- the premium is financed
            # at 14.85% -- but the finance charge reaches the bank as a loan
            # payment, so the insurance line carries the premium and the $3,398
            # is named separately rather than buried here.
            lines["own_package_benchmark"] = own_x["annual_total"]
        if co == "AFG":
            # None until the Progressive billing history closes it. Never zero:
            # the bills show a balance rising to $42,630, so this is a real and
            # growing cost that simply cannot be totalled yet.
            prog = policy(reg, entity="AFG")["annual_total"]
            if prog is not None:
                lines["progressive_own_policy"] = prog
        out[co] = lines
    return out


def unallocated(reg):
    """What no company carries, because the units are on no P&L."""
    al = reg["allocation"]["auto_liability"]
    pdal = reg["allocation"]["physical_damage"]["from_the_submitted_schedule"]
    pdpol = policy(reg, coverage="vehicle_physical_damage_and_non_trucking_liability")
    sched = pdpol["schedule_submitted_at_renewal"]
    unit_share = sched["power_unit_tiv"] / (sched["power_unit_tiv"] + sched["trailer_tiv"])
    scale = al_scale(reg)
    return {"auto_liability_on_units_in_no_pnl": al["not_in_any_pnl"]["annual"] * scale,
            "physical_damage_on_units_not_resolved":
                (pdpol.get("actual", {}).get("annualised") or pdpol["vpd_annual"])
                * unit_share * pdal["not_matched"]["tiv"] / pdal["total"]["tiv"],
            "_note": al["_finding"]}


def controls(reg, by_co):
    fails = []
    pdpol = policy(reg, coverage="vehicle_physical_damage_and_non_trucking_liability")
    if pdpol["vpd_annual"] != pdpol["tiv_at_submission"] * pdpol["rate"][
            "vehicle_physical_damage_annual_pct_of_tiv"]:
        fails.append(("physical damage premium is not the rate times the TIV", None))
    act = pdpol.get("actual")
    if act and abs(sum(act["monthly"].values()) - act["total_5_months"]) > 0.01:
        fails.append(("the monthly NTL/PD invoices do not sum to their stated total", None))
    al = reg["allocation"]["auto_liability"]
    master = policy(reg, role="group master policy")
    # Compare like with like. per_company() and unallocated() both report the
    # EFFECTIVE premium (face less the six return credits), so the target is the
    # effective cost -- not the face value the four shares were written on. The
    # earlier control tested scaled shares against the unscaled policy and was
    # off by exactly the return premium.
    scale = al_scale(reg)
    got = (sum(by_co[c]["auto_liability"] for c in by_co)
           + al["not_in_any_pnl"]["annual"] * scale)
    target = master["annual_total"] * scale
    # $5 at face, so $5 x scale here: the allocation in config/insurance.json is
    # stored in whole dollars and the four shares cannot sum to the cent.
    if abs(got - target) > 5 * scale:
        fails.append(("allocated auto liability vs the policy", round(got - target)))
    # Against the ACTUAL bill where there is one: the NTL/PD invoice is a single
    # charge covering both covers, so the target is that bill, not the rate.
    target_pd = (pdpol.get("actual", {}).get("annualised") or pdpol["vpd_annual"])
    pd_alloc = sum(v["physical_damage_power_units"] + v["physical_damage_trailers_ESTIMATED"]
                   for v in by_co.values())
    if pd_alloc > target_pd + 1:
        fails.append(("more physical damage allocated than the bill",
                      round(pd_alloc - target_pd)))
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
        row = [by[c].get(n) or 0.0 for c in by]
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
    unpriced = [p for p in reg["policies"] if p.get("annual_total") is None]
    if unpriced:
        print("\n== IN THE STACK BUT NOT YET PRICED ==")
        for p in unpriced:
            print(f"  {p['entity']} {p['coverage']}: {p['_MISSING'][:88]}")

    print("\n== CARRIED BY NOBODY ==")
    for k, v in u.items():
        if not k.startswith("_"):
            print(f"  {k:<48}{v:>12,.0f}/yr{v / WEEKS:>10,.0f}/wk")
    print(f"  {u['_note']}")

    cx = policy(reg, coverage="motor_truck_cargo_second_layer")
    cz = policy(reg, coverage="motor_truck_cargo")
    master = I_master = policy(reg, role="group master policy")
    a = master.get("actual")
    if a:
        print("\n== THE FACE PREMIUM IS NOT THE COST ==")
        print(f"  auto liability as written          ${master['annual_total']:>12,.2f}")
        print(f"  return premium, {a['return_premiums']} credits           "
              f"${-a['return_premium_total']:>12,.2f}")
        print(f"  EFFECTIVE                          ${a['effective_annual_cost']:>12,.2f}"
              f"   ${a['effective_per_week']:,.0f}/wk, ${a['effective_per_unit_week']:.2f}/unit-wk")
        print("  A unit taken off a reporting policy returns money. The 21 that stopped")
        print("  running are worth removing, not just worth noting.")

    print("\n== WHAT IS BILLED, AGAINST WHAT THE RATE SAYS ==")
    print(f"  {'line':<40}{'rated':>13}{'BILLED':>13}{'diff':>11}  source")
    for pol, rated_key in ((policy(reg, coverage="vehicle_physical_damage_and_non_trucking_liability"),
                            "vpd_annual"),
                           (policy(reg, coverage="occupational_accident"), None),
                           (master, "annual_total")):
        act = pol.get("actual") or {}
        billed = act.get("annualised") or act.get("effective_annual_cost")
        if not billed:
            continue
        # The occ acc register carries no separate rate figure; there the rate
        # and the bill are the same number and the row is there to say so.
        rated = pol.get(rated_key) if rated_key else billed
        n = f"{pol['entity']} {pol['coverage']}"[:39]
        print(f"  {n:<40}{rated:>13,.0f}{billed:>13,.0f}{billed - rated:>11,.0f}"
              f"  {act['_source'][:40]}")
    print("  Where a bill exists it is used. The rate is a fallback, not a check:")
    print("  both reporting policies moved with the schedule, in opposite directions.")

    print("\n== THE TWO LINES THAT ARE NOT PER TRUCK ==")
    print(f"  XTRACK second cargo layer   ${cx['rate_per_mile']:.4f} per mile "
          f"(${cx['annual_total']:,.0f} estimated on {cx['estimated_miles']:,} miles)")
    print(f"  ZONE motor truck cargo      {cz['rate_per_100_of_gross']:.2f}% of gross "
          f"(${cz['annual_total']:,.0f} a year)")
    print("  Neither is charged on a truck that does not move; every other line is.")


if __name__ == "__main__":
    main()
