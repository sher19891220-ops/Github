"""
The weekly P&L, and its month/quarter/year rollups -- built entirely from
this pipeline's own already-validated modules (truck_weeks.py's per-truck
per-week P&L rows, cost_structure.py's per-mile IFTA/Oregon tax rates).
Nothing here is a new parse; it is aggregation of numbers this project has
already spent weeks establishing and testing.

WHY THIS EXISTS. Operator, 2026-09-22: "profit and loss we must have on
weekly basis, and collect all data so we can have analyses for each month,
quarter, and years" -- plus a drag-and-drop upload for fuel/toll/mileage
source documents. The upload side (Claude Artifact, config/artifact
front-end) extends this SAME weekly table forward as new source documents
arrive; this module is what seeds it with everything already measured.

WEEKLY GRANULARITY, COMPANY-DRIVER ONLY. Every figure here is summed
across a company's COMPANY-DRIVER trucks for that week (truck_weeks.py's
`kind == "company_driver"`) -- owner-operator, lease-to-purchase and
lease-to-walk-away trucks have fundamentally different economics
(docs/ACCOUNTING_MODEL.md Section 3: the company's OO profit is a flat
company-charge + fuel-discount margin, not a measured cost) and are not
blended in here. A truck that changes kind mid-history is counted under
whichever kind it actually ran as THAT week -- truck_weeks.py's own row,
not a static classification.

IFTA HERE IS AN INTERIM WEEKLY-PRECISION STEP, NOT A REAL PER-JURISDICTION
ENGINE. Operator, 2026-09-22: build a real IFTA engine and price weekly,
not quarterly. A full per-jurisdiction weekly engine needs weekly
state-by-state miles and fuel purchases this corpus does not have -- IFTA
returns are themselves quarterly, state-by-state aggregates. What this
DOES fix: `ifta_estimate` now applies the filed return's own average
$/GALLON (`cost_structure.fuel_tax_per_gallon`) to THIS WEEK'S OWN REAL
GALLONS, instead of the return's average $/MILE to this week's miles --
removing the old method's silent assumption that every week ran at the
return's own average mpg. The one assumption still baked in (this week's
jurisdiction mix matches the filed return's average mix) has no cheaper
fix without weekly state-level data. The old miles-based figure is kept
alongside as `ifta_estimate_per_mile_method`, for comparison only.

MONTH/QUARTER/YEAR ARE DERIVED FROM THE WEEK-ENDING DATE, NOT PRORATED. A
week that spans a month or quarter boundary is credited whole to the
period its own tab-name week-ending date falls in -- consistent with how
every other calendar rollup in this corpus already works (docs/CATALOG.md,
QUARTERS in analysis/pnl_accuracy.py).
"""
import functools
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import cost_structure as CS  # noqa: E402
import truck_weeks as T      # noqa: E402

COMPANIES = ("ZONE", "XTRACK", "AFG")
CD_MONEY_FIELDS = ("driver_pay", "admin", "fuel", "rent", "trailer_rent", "toll", "additional", "other")
TRUCK_MONEY_FIELDS = CD_MONEY_FIELDS
SHEET_MONEY_FIELDS = ("driver_pay", "fuel", "toll", "additional", "other")  # unchanged, still from the P&L


@functools.lru_cache(maxsize=None)
def _motive_rates():
    """Real per-truck Motive cost, split by whether a truck has an
    installed dashcam or not. Operator, 2026-09-22: "divide to cameras we
    have from motive count and consolidate between motive installed trucks
    only per truck price and rest consolidate between all other trucks."
    Computed from the invoice's own line items (config/telematics_costs.json),
    not hardcoded: the three dashcam-only plans (Driver Safety + Fleet
    Management + Communications, $25,200 over the 36-month contract) split
    across the 15 trucks with a known installed unit; the AG-Mini tracker
    software plan, net of its matching "Sales Credit - SW" ($10,650 over
    36 months -- the credit name and the software line are the only two
    that share "SW", and only that pairing reconstructs the established
    $229.81/wk total exactly), split across the other 75 trucks (the same
    90-truck fleet-wide denominator used everywhere else in this file)."""
    import json
    cfg = json.loads((ROOT / "config" / "telematics_costs.json").read_text())
    m = cfg["motive"]
    li = m["line_items"]
    months = m["period_months"]
    weeks_per_month = 52 / 12
    dashcam_keys = ("Driver Safety Plan - AI Dashcam Plus Dual-Facing",
                    "Fleet Management Plan - AI Dashcam Plus Dual-Facing",
                    "Communications Plan - AI Dashcam Plus")
    dashcam_total = sum(li[k]["amount"] for k in dashcam_keys)
    tracker_total = li["AG-Mini Powered Software Plan"]["amount"] + li["Sales Credit - SW"]["amount"]
    installed_units = {str(u).strip() for u in m["unit_list_supplied"]}
    total_trucks = m["fleet_wide_motive_per_truck_week"]["trucks"]
    n_installed = len(installed_units)
    n_other = total_trucks - n_installed
    dashcam_wk_total = dashcam_total / months / weeks_per_month
    tracker_wk_total = tracker_total / months / weeks_per_month
    per_installed = round(dashcam_wk_total / n_installed, 2)
    per_other = round(tracker_wk_total / n_other, 2)
    # Fleet-wide truck counts, same denominator as driver_arrangement_rates.
    # json's samsara/verizon/pedigree figures (17 AFG + 32 ZONE + 41 XTRACK).
    company_trucks = {"AFG": 17, "ZONE": 32, "XTRACK": 41}
    installed_by_company = dict(m["by_company_resolved"])
    installed_by_company.pop("unresolved", None)
    company_avg = {}
    for co, total in company_trucks.items():
        n_co_installed = len(installed_by_company.get(co, []))
        n_co_other = total - n_co_installed
        company_avg[co] = round(
            (n_co_installed * per_installed + n_co_other * per_other) / total, 2)
    return {
        "installed_units": installed_units,
        "per_installed_truck_week": per_installed,
        "per_other_truck_week": per_other,
        "n_installed": n_installed, "n_other": n_other,
        "company_avg_per_truck_week": company_avg,
    }


@functools.lru_cache(maxsize=None)
def _per_truck_cost_rates(co):
    """Every per-truck-week rate this module needs to price Admin, Trailer
    Rent, and truck Rent -- computed once per company, from calculations
    already established elsewhere in this pipeline, NEVER from the P&L
    sheet's own Admin/Rent columns. Operator, 2026-09-22: "admin cost do
    not get from google sheet get that from calculation that we did
    priorly... unit rent insurance cost do not get from google sheets but
    from calculations we did priorly." Motive is kept separate from the
    rest of the admin fee because it is NOT uniform per truck (see
    _motive_rates); everything else here (insurance, the other six
    admin-fee vendors, trailer rent) is uniform across a company's trucks
    for lack of any more granular real source."""
    import fixed_costs as FC
    import insurance_cost as IC
    import driver_arrangement as DA

    reg = IC.load()
    ins = IC.per_company(reg)
    trucks_on_schedule = {"ZONE": 28, "XTRACK": 24, "AFG": 8}  # IC.main()'s own printed counts
    # Excludes "_benchmark" (XTRACK's own 3-unit policy does not cover the
    # whole fleet) and "_RECOVERED_FROM_DRIVER" (occupational accident is
    # billed by the company but deducted back from the driver's settlement,
    # so it is not a net company cost -- see insurance_cost.py).
    insurance_lines = {k: round(v / 52 / trucks_on_schedule[co], 2)
                       for k, v in ins[co].items()
                       if not k.endswith("_benchmark") and not k.endswith("_RECOVERED_FROM_DRIVER")}

    rates = DA.load_rates()
    admin_fee_block = rates["admin_fee_actual_cost_per_truck_week"]
    admin_fee_lines = dict(admin_fee_block["by_company_per_truck_week"][co])
    fleet_wide = admin_fee_block["fleet_wide_not_split_by_company"]
    admin_fee_lines.update({
        "samsara": fleet_wide["samsara_per_truck_week"],
        "verizon": fleet_wide["verizon_per_truck_week"],
        "pedigree_tpms": fleet_wide["pedigree_tpms_per_truck_week"],
    })
    admin_fee_lines = {k: v for k, v in admin_fee_lines.items() if v is not None}

    s = CS.structure(co)
    m = s["m"]
    return {
        "insurance_lines": insurance_lines,
        "insurance_per_truck_week": round(sum(insurance_lines.values()), 2),
        "admin_fee_lines_excl_motive": admin_fee_lines,
        "admin_fee_excl_motive_per_truck_week": round(sum(admin_fee_lines.values()), 2),
        "motive": _motive_rates(),
        "trailer_rent_per_truck_week": FC.RATES[co]["Trailer rent"],
        "outside_lease_rent_per_week": round(m["rent_outside_per_week"], 2),
        "iron_lease_base_per_week": m["rent_iron_base"],
        "iron_lease_mileage_rate_per_mile": m["rent_iron_per_mile"],
        "structure": s,
    }


def _motive_for_unit(unit, motive_rates):
    u = str(unit).strip()
    return (motive_rates["per_installed_truck_week"] if u in motive_rates["installed_units"]
            else motive_rates["per_other_truck_week"])


def admin_for_unit(unit, rates):
    """insurance + the six uniform admin-fee vendors + this specific
    truck's own Motive rate (camera-installed vs. other) -- see
    _per_truck_cost_rates and _motive_rates."""
    return round(rates["insurance_per_truck_week"] + rates["admin_fee_excl_motive_per_truck_week"]
                 + _motive_for_unit(unit, rates["motive"]), 2)


def rent_for_unit(unit, miles, rates):
    """Iron Lease trucks: the real rate-card formula (flat base + $/mile on
    THIS truck's own miles this week) -- not a fleet-wide blend. Every
    other truck: the outside/market lease average measured from this
    company's own non-Iron-Lease P&L rent rows (cost_structure.py's
    rent_outside_per_week) -- a calculated figure, not that truck's raw
    sheet value, but still not a real per-vendor (Penske/Ryder/STL) rate;
    those remain pending real numbers from the operator."""
    u = str(unit).strip()
    if u in T.IRON_RATE_CARD:
        base, per_mile = T.IRON_RATE_CARD[u]
        return round(base + per_mile * (miles or 0), 2)
    return rates["outside_lease_rent_per_week"]


def _augment(company):
    """One row per (week, unit) for this company's company-driver fleet,
    with admin/rent/trailer_rent computed from _per_truck_cost_rates/
    admin_for_unit/rent_for_unit rather than read from the sheet -- driver
    pay, fuel, toll, additional and other are untouched, still real P&L
    figures."""
    tw = T.truck_weeks(company)
    cd = tw[tw.kind == "company_driver"].copy()
    rates = _per_truck_cost_rates(company)
    rows = []
    for (week, unit), g in cd.groupby(["week", "unit"]):
        r = g.iloc[0]
        u = str(unit).strip()
        row = {
            "company": company, "week": week, "unit": u,
            "driver": r.get("driver", ""), "gross": round(r.gross, 2),
            "miles": round(r.miles, 1), "gallons": round(r.gallons, 1),
            "mpg": round(r.miles / r.gallons, 2) if r.gallons else None,
        }
        for f in SHEET_MONEY_FIELDS:
            row[f] = round(r[f], 2)
        row["admin"] = admin_for_unit(u, rates)
        row["rent"] = rent_for_unit(u, r.miles, rates)
        row["trailer_rent"] = rates["trailer_rent_per_truck_week"]
        # result is recomputed, not carried from the sheet: it must reflect
        # the calculated admin/rent/trailer_rent above, not the sheet's own
        # bundled Insur/Admin/Trl and Truck Rental figures.
        row["result"] = round(
            row["gross"] - row["driver_pay"] - row["admin"] - row["fuel"] - row["rent"]
            - row["trailer_rent"] - row["toll"] + row["additional"] + row["other"], 2)
        rows.append(row)
    return pd.DataFrame(rows).sort_values(["week", "unit"]).reset_index(drop=True)


def truck_rows(company):
    """One row per company-driver truck per week -- the drill-down behind
    a weekly summary row."""
    return _augment(company)


def all_truck_rows():
    return pd.concat([truck_rows(co) for co in COMPANIES], ignore_index=True)


def weekly_rows(company):
    """One row per week for this company's company-driver fleet: gross,
    miles, gallons, the CD cost components (admin/rent/trailer_rent
    calculated, see _augment; the rest still real P&L figures), mpg, a
    trailing IFTA estimate, and trucks running that week."""
    tr = _augment(company)
    ifta_rate_per_mile = None
    ifta_rate_per_gallon = None
    try:
        f = CS.fuel_tax_per_mile(company)
        ifta_rate_per_mile = f["per_mile"] if f else None
    except Exception:
        ifta_rate_per_mile = None
    try:
        g_ = CS.fuel_tax_per_gallon(company)
        ifta_rate_per_gallon = g_["per_gallon"] if g_ else None
    except Exception:
        ifta_rate_per_gallon = None

    rows = []
    for week, g in tr.groupby("week"):
        running = g[g.gross > 0]
        miles = g.miles.sum()
        gallons = g.gallons.sum()
        row = {
            "company": company, "week": week,
            "trucks_running": len(running),
            "gross": round(g.gross.sum(), 2),
            "miles": round(miles, 1),
            "gallons": round(gallons, 1),
            "mpg": round(miles / gallons, 2) if gallons else None,
            "result": round(g.result.sum(), 2),
        }
        for f in CD_MONEY_FIELDS:
            row[f] = round(g[f].sum(), 2)
        # Interim weekly-precision IFTA (operator, 2026-09-22): this week's
        # OWN real gallons x the filed return's own $/gallon rate, not this
        # week's miles x an assumed constant mpg -- see
        # cost_structure.fuel_tax_per_gallon()'s docstring for why gallons
        # is the better weekly base than miles. The old miles-based figure
        # is kept alongside for comparison, not as the estimate used.
        row["ifta_estimate"] = round(gallons * ifta_rate_per_gallon, 2) if ifta_rate_per_gallon else None
        row["ifta_rate_per_gallon"] = ifta_rate_per_gallon
        row["ifta_estimate_per_mile_method"] = round(miles * ifta_rate_per_mile, 2) if ifta_rate_per_mile else None
        row["ifta_rate_per_mile"] = ifta_rate_per_mile
        rows.append(row)
    return pd.DataFrame(rows).sort_values("week").reset_index(drop=True)


def all_weekly_rows():
    return pd.concat([weekly_rows(co) for co in COMPANIES], ignore_index=True)


def cost_breakdown_reference():
    """What 'Admin', 'Trailer Rent' and 'Rent' actually consist of, per
    company -- built from _per_truck_cost_rates(), the SAME function
    admin_for_unit()/rent_for_unit() use to price every truck row, so this
    reference can never drift from what the weekly/truck tables actually
    show. Nothing here reads the P&L sheet's own Admin or Rent columns.
    Operator, 2026-09-22: "admin cost do not get from google sheet get
    that from calculation that we did priorly, and from those brakedowns
    ... unit rent insurance cost do not get from google sheets but from
    calculations we did priorly."
    """
    out = {}
    for co in COMPANIES:
        rates = _per_truck_cost_rates(co)
        motive = rates["motive"]
        out[co] = {
            "insurance_per_truck_week": rates["insurance_per_truck_week"],
            "insurance_lines": rates["insurance_lines"],
            "insurance_covers": "whole insured fleet (CD + OO), auto liability at its effective "
                                "post-return-premium rate + physical damage + cargo",
            "insurance_excludes_note":
                ("XTRACK's own 3-unit Benchmark package ($51.06/truck-week if spread over just "
                 "those 3 trucks) is tracked separately since it does not cover the whole fleet. "
                 if co == "XTRACK" else
                 "AFG's own Progressive policy is NOT included -- its premium cannot be totalled "
                 "yet (the bills show a rising balance, not a closed annual figure), so this AFG "
                 "insurance figure is a floor, not the whole cost. "
                 if co == "AFG" else "") +
                "Occupational accident premium is billed by the company but deducted back from "
                "the driver's settlement, so it is NOT counted here -- see insurance_cost.py. "
                "Workers' compensation ($120/month, ZONE-OH only) is tracked in config/"
                "insurance.json but is not yet folded into this per-truck-week figure.",
            "admin_fee_lines": dict(rates["admin_fee_lines_excl_motive"],
                                    motive_camera_installed_trucks=motive["per_installed_truck_week"],
                                    motive_other_trucks=motive["per_other_truck_week"]),
            "admin_fee_measured_per_truck_week": round(
                rates["admin_fee_excl_motive_per_truck_week"]
                + motive["company_avg_per_truck_week"][co], 2),
            "admin_fee_note": f"Motive is split by whether a truck actually has a camera "
                f"installed: {motive['n_installed']} trucks fleet-wide currently do, at "
                f"${motive['per_installed_truck_week']}/truck-week each; the other "
                f"{motive['n_other']} carry ${motive['per_other_truck_week']}/truck-week "
                f"(the unassigned trackers/spare cameras, still real cost). The figure above "
                f"blends {co}'s own known installed-camera count into a company average "
                f"(${motive['company_avg_per_truck_week'][co]}/truck-week); a specific truck's "
                f"own Admin in the truck-by-truck table uses whichever rate actually applies "
                f"to it, not this blend.",
            "trailer_rent_per_truck_week": rates["trailer_rent_per_truck_week"],
            "trailer_rent_note": "ALLOCATED rate, not yet broken out by trailer type. Operator, "
                "2026-09-22: AFG runs open-deck trailers (flatbed/stepdeck) that ZONE/XTRACK do "
                "not, and reefers split between AFG and XTRACK, each at its own monthly/weekly "
                "rate -- real per-type rates are not yet in this pipeline, so this remains one "
                "blended allocated figure per company until they are supplied.",
        }
    return out


def cost_breakdown_reference_with_rent():
    """cost_breakdown_reference() plus each company's truck-rent detail --
    the same Iron-Lease-rate-card-or-outside-lease-average calculation
    rent_for_unit() applies to every truck row, shown as the actual
    arithmetic rather than a 'base x share of fleet' blend. Needs the full
    P&L + IRP/IFTA read cost_structure.py already pays elsewhere, so this
    is a separate call from cost_breakdown_reference() for callers that
    only want the cheaper figures."""
    out = cost_breakdown_reference()
    for co in COMPANIES:
        rates = _per_truck_cost_rates(co)
        s = rates["structure"]
        m = s["m"]
        iron_base = rates["iron_lease_base_per_week"]
        iron_rate = rates["iron_lease_mileage_rate_per_mile"]
        avg_miles = round(m["miles_per_truck"], 1)
        iron_lease_example_per_truck_week = round(iron_base + iron_rate * avg_miles, 2)
        out[co]["truck_rent_per_truck_week"] = iron_lease_example_per_truck_week
        out[co]["truck_rent_detail"] = {
            "iron_lease_base_per_week": iron_base,
            "iron_lease_mileage_rate_per_mile": iron_rate,
            "avg_miles_per_truck_week": avg_miles,
            "iron_lease_example_per_truck_week": iron_lease_example_per_truck_week,
            "outside_lease_rent_per_week": rates["outside_lease_rent_per_week"],
            "iron_lease_share_of_fleet": round(m["iron_share"], 4),
            "note": "Rent is calculated per truck, not read from the sheet. An Iron Lease "
                    f"truck's rent is ${iron_base:,.0f}/week base + ${iron_rate:.2f}/mile x its "
                    "OWN miles that week -- shown here at this fleet's average weekly miles as "
                    "an example, but the truck-by-truck table applies it to each truck's real "
                    "miles. A truck that is not on Iron Lease (roughly "
                    f"{round((1 - m['iron_share']) * 100)}% of this fleet) carries the "
                    "outside/market-lease average shown above instead -- a calculated company "
                    "average, not that truck's own raw sheet figure, since real per-vendor "
                    "(Penske/Ryder/STL) rates are not yet in this pipeline.",
        }
        out[co]["admin_insurance_trailer_booked_per_truck_week"] = round(s["fixed"]["admin / insurance / trailer"], 2)
        cb = out[co]
        real_sum = (cb["insurance_per_truck_week"] + cb["admin_fee_measured_per_truck_week"]
                    + cb["trailer_rent_per_truck_week"])
        out[co]["gap_per_truck_week"] = round(cb["admin_insurance_trailer_booked_per_truck_week"] - real_sum, 2)
        out[co]["gap_explanation"] = (
            "This is a reference point only -- the Admin and Trailer Rent shown on the P&L "
            "are the calculated figures above, not this sheet figure. The sheet's own "
            "Insur/Admin/Trl column was never built by adding insurance, the admin-fee vendor "
            "costs and trailer rent -- it is a hand-set weekly charge with only a handful of "
            "distinct tiers per company (e.g. ZONE runs just 10 distinct values across 300 "
            "truck-weeks: $394.38 x118, $534.28 x114), set mainly to track insurance at cost."
        )
    return out


def ifta_reference():
    """Per-company IFTA detail for the artifact's reference collection --
    both the active per-gallon method and the superseded per-mile one, so
    the IFTA info panel can show its own math rather than just a number."""
    out = {}
    for co in COMPANIES:
        g = CS.fuel_tax_per_gallon(co)
        m = CS.fuel_tax_per_mile(co)
        out[co] = {
            "method": "per_gallon",
            "tax": g["tax"], "gallons": g["gallons"], "per_gallon": g["per_gallon"],
            "quarters": g["quarters"], "return_mpg": g["return_mpg"],
            "per_mile_method_reference": {
                "tax": m["tax"], "miles": m["miles"], "per_mile": m["per_mile"],
                "quarters": m["quarters"],
            } if m else None,
        }
    return out


def _period_key(week, granularity):
    d = pd.Timestamp(week)
    if granularity == "month":
        return f"{d.year}-{d.month:02d}"
    if granularity == "quarter":
        return f"{d.year}-Q{(d.month - 1) // 3 + 1}"
    if granularity == "year":
        return str(d.year)
    raise ValueError(granularity)


SUM_FIELDS = ("gross", "miles", "gallons", "result", "ifta_estimate") + CD_MONEY_FIELDS


def rollup(weekly, granularity):
    """Aggregate weekly_rows()/all_weekly_rows() output to month, quarter,
    or year. mpg and ifta_rate_per_mile are recomputed from the summed
    inputs, never averaged as if they were already-comparable rates."""
    df = weekly.copy()
    df["period"] = df.week.apply(lambda w: _period_key(w, granularity))
    out = []
    for (company, period), g in df.groupby(["company", "period"]):
        row = {"company": company, "period": period, "weeks": len(g),
               "trucks_running_avg": round(g.trucks_running.mean(), 1)}
        for f in SUM_FIELDS:
            row[f] = round(g[f].sum(skipna=True), 2)
        row["mpg"] = round(row["miles"] / row["gallons"], 2) if row.get("gallons") else None
        out.append(row)
    return pd.DataFrame(out).sort_values(["company", "period"]).reset_index(drop=True)


def main():
    weekly = all_weekly_rows()
    print(f"{len(weekly)} company-weeks across {weekly.company.nunique()} companies, "
          f"{weekly.week.min()} .. {weekly.week.max()}")
    for gran in ("month", "quarter", "year"):
        r = rollup(weekly, gran)
        print(f"\n{gran.upper()} ({len(r)} rows):")
        print(r.to_string(index=False))


if __name__ == "__main__":
    main()
