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

IFTA HERE IS STILL THE TRAILING, PER-MILE-RATE VERSION, NOT A REAL WEEKLY
ENGINE. `cost_structure.fuel_tax_per_mile(company)` is one rate per
company, derived from the LATEST available filed IFTA return -- applying
it to every historical week assumes that rate held constant, which is
merely the best available estimate until a real per-quarter join exists.
Flagged here rather than presented as more precise than it is.

MONTH/QUARTER/YEAR ARE DERIVED FROM THE WEEK-ENDING DATE, NOT PRORATED. A
week that spans a month or quarter boundary is credited whole to the
period its own tab-name week-ending date falls in -- consistent with how
every other calendar rollup in this corpus already works (docs/CATALOG.md,
QUARTERS in analysis/pnl_accuracy.py).
"""
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import cost_structure as CS  # noqa: E402
import truck_weeks as T      # noqa: E402

COMPANIES = ("ZONE", "XTRACK", "AFG")
CD_MONEY_FIELDS = ("driver_pay", "admin", "fuel", "rent", "toll", "additional", "other")


def weekly_rows(company):
    """One row per week for this company's company-driver fleet: gross,
    miles, gallons, the CD cost components, mpg, a trailing IFTA estimate,
    and trucks running that week."""
    tw = T.truck_weeks(company)
    cd = tw[tw.kind == "company_driver"].copy()
    ifta_rate = None
    try:
        f = CS.fuel_tax_per_mile(company)
        ifta_rate = f["per_mile"] if f else None
    except Exception:
        ifta_rate = None

    rows = []
    for week, g in cd.groupby("week"):
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
        row["ifta_estimate"] = round(miles * ifta_rate, 2) if ifta_rate else None
        row["ifta_rate_per_mile"] = ifta_rate
        rows.append(row)
    return pd.DataFrame(rows).sort_values("week").reset_index(drop=True)


def all_weekly_rows():
    return pd.concat([weekly_rows(co) for co in COMPANIES], ignore_index=True)


TRUCK_MONEY_FIELDS = ("driver_pay", "admin", "fuel", "rent", "toll", "additional", "other")


def truck_rows(company):
    """One row per company-driver truck per week -- the drill-down behind
    a weekly summary row. Same fields as weekly_rows(), at truck grain,
    plus the driver name from that week's own P&L block."""
    tw = T.truck_weeks(company)
    cd = tw[tw.kind == "company_driver"].copy()
    rows = []
    for (week, unit), g in cd.groupby(["week", "unit"]):
        r = g.iloc[0]
        row = {
            "company": company, "week": week, "unit": str(unit).strip(),
            "driver": r.get("driver", ""), "gross": round(r.gross, 2),
            "miles": round(r.miles, 1), "gallons": round(r.gallons, 1),
            "mpg": round(r.miles / r.gallons, 2) if r.gallons else None,
            "result": round(r.result, 2),
        }
        for f in TRUCK_MONEY_FIELDS:
            row[f] = round(r[f], 2)
        rows.append(row)
    return pd.DataFrame(rows).sort_values(["week", "unit"]).reset_index(drop=True)


def all_truck_rows():
    return pd.concat([truck_rows(co) for co in COMPANIES], ignore_index=True)


def cost_breakdown_reference():
    """What 'Admin', 'Rent' and 'IFTA est.' actually consist of, per
    company -- NOT a decomposition of the P&L's own bundled figures (the
    sheet books them as one column each and does not itemize), but the
    best independently-SOURCED figures this pipeline has for each named
    sub-component, so the gap between 'what the sheet books' and 'what
    the pieces actually cost' is visible rather than papered over.

    Sources, each already established elsewhere in this pipeline:
      truck_rent      cost_structure.py's rent_base_per_week -- Iron
                      Lease/market blend, TRUCK rent only.
      insurance       analysis/insurance_cost.py's PER TRUCK-WEEK figure
                      (auto liability at its EFFECTIVE post-return-premium
                      rate, physical damage, cargo, occupational
                      accident) -- covers the whole insured fleet
                      (company-driver AND owner-operator), not CD-only.
      admin_fee       config/driver_arrangement_rates.json's
                      admin_fee_actual_cost_per_truck_week -- MEASURED
                      from real ELD/Samsara/Verizon/Pedigree/IFTA-admin
                      invoices and bank/card data, not the stated fee.
      trailer_rent    config/... fixed_costs.py's RATES table -- an
                      ALLOCATED rate, not measured from cash (that
                      module's own docstring already flags the sibling
                      truck-rent rate as stale; treat this the same way
                      until it is checked against a real trailer-lease
                      invoice).

    THE PIECES DO NOT SUM TO THE SHEET'S OWN 'ADMIN' COLUMN, ON PURPOSE:
    that mismatch is real and already visible in this pipeline (docs/
    FINDINGS.md, 2026-09-08/09/21/22 entries) -- reporting a forced match
    would hide it.
    """
    import fixed_costs as FC
    import insurance_cost as IC
    import driver_arrangement as DA

    reg = IC.load()
    ins = IC.per_company(reg)
    trucks_on_schedule = {"ZONE": 28, "XTRACK": 24, "AFG": 8}  # IC.main()'s own printed counts
    rates = DA.load_rates()
    admin_fee_block = rates["admin_fee_actual_cost_per_truck_week"]
    admin_fee_rates = admin_fee_block["total_measured_per_truck_week"]
    per_company_admin = admin_fee_block["by_company_per_truck_week"]
    fleet_wide_admin = admin_fee_block["fleet_wide_not_split_by_company"]

    out = {}
    for co in COMPANIES:
        # Line-by-line, per truck-week -- excludes anything ending "_benchmark":
        # XTRACK's own 3-unit Benchmark package only covers those 3 trucks, so
        # spreading its cost across all 24 units on the schedule would
        # misallocate a policy that does not cover the whole fleet.
        insurance_lines = {k: round(v / 52 / trucks_on_schedule[co], 2)
                           for k, v in ins[co].items() if not k.endswith("_benchmark")}
        insurance_per_truck_week = sum(insurance_lines.values())

        admin_fee_lines = dict(per_company_admin[co])
        admin_fee_lines.update({
            "samsara": fleet_wide_admin["samsara_per_truck_week"],
            "verizon": fleet_wide_admin["verizon_per_truck_week"],
            "pedigree_tpms": fleet_wide_admin["pedigree_tpms_per_truck_week"],
            "motive": fleet_wide_admin["motive_per_truck_week"],
        })
        admin_fee_lines = {k: v for k, v in admin_fee_lines.items() if v is not None}

        out[co] = {
            "truck_rent_per_truck_week": None,  # filled from cost_structure.structure() by the caller
            "insurance_per_truck_week": round(insurance_per_truck_week, 2),
            "insurance_lines": insurance_lines,
            "insurance_covers": "whole insured fleet (CD + OO), auto liability at its effective "
                                "post-return-premium rate + physical damage + cargo + occ. accident",
            "insurance_excludes_note":
                ("XTRACK's own 3-unit Benchmark package ($51.06/truck-week if spread over just "
                 "those 3 trucks) is tracked separately since it does not cover the whole fleet. "
                 if co == "XTRACK" else
                 "AFG's own Progressive policy is NOT included -- its premium cannot be totalled "
                 "yet (the bills show a rising balance, not a closed annual figure), so this AFG "
                 "insurance figure is a floor, not the whole cost. "
                 if co == "AFG" else "") +
                "Workers' compensation ($120/month, ZONE-OH only) is tracked in config/"
                "insurance.json but is not yet folded into this per-truck-week figure.",
            "admin_fee_measured_per_truck_week": admin_fee_rates.get(co),
            "admin_fee_lines": admin_fee_lines,
            "trailer_rent_per_truck_week": FC.RATES[co]["Trailer rent"],
            "trailer_rent_note": "ALLOCATED rate, not measured from a trailer-lease invoice -- "
                                 "treat like fixed_costs.py's own stale-truck-rent caveat.",
        }
    return out


def cost_breakdown_reference_with_rent():
    """cost_breakdown_reference() plus each company's real truck-rent
    figure from cost_structure.structure(), which needs the full P&L +
    IRP/IFTA read cost_structure.py already pays elsewhere -- kept as a
    separate call so a caller that only wants the cheap reference figures
    isn't forced to pay for a full structure() build."""
    out = cost_breakdown_reference()
    for co in COMPANIES:
        s = CS.structure(co)
        m = s["m"]
        out[co]["truck_rent_per_truck_week"] = round(s["fixed"]["truck rent, base"], 2)
        mileage_component = round(m["rent_per_mile"] * m["miles_per_truck"], 2)
        out[co]["truck_rent_detail"] = {
            "iron_lease_share": round(m["iron_share"], 4),
            "iron_lease_base_per_week": m["rent_iron_base"],
            "outside_lease_share": round(1 - m["iron_share"], 4),
            "outside_lease_rent_per_week": round(m["rent_outside_per_week"], 2),
            "iron_lease_mileage_rate_per_mile": round(m["rent_iron_per_mile"], 4),
            "avg_miles_per_truck_week": round(m["miles_per_truck"], 1),
            "fleet_weighted_mileage_component_per_truck_week": mileage_component,
            "all_in_truck_rent_per_truck_week": round(s["fixed"]["truck rent, base"] + mileage_component, 2),
            "note": "The figure shown as \"Truck Rent\" is the BASE blend only -- Iron "
                    "Lease's flat $900/week base weighted by the share of the fleet on Iron "
                    "Lease, plus everything else at its own P&L-measured rent. An Iron Lease "
                    "truck ALSO pays $0.15/mile on top of that base; fleet-wide that averages "
                    "to the mileage component above (the $0.15 rate weighted by the Iron "
                    "Lease share, times this fleet's average weekly miles). That mileage "
                    "add-on is NOT included in the base figure -- this pipeline currently "
                    "folds it into the fleet's variable cost-per-mile instead, alongside fuel "
                    "and tolls, so it never shows up next to Rent on the weekly P&L.",
        }
        out[co]["admin_insurance_trailer_booked_per_truck_week"] = round(s["fixed"]["admin / insurance / trailer"], 2)
        cb = out[co]
        real_sum = (cb["insurance_per_truck_week"] + (cb["admin_fee_measured_per_truck_week"] or 0)
                    + cb["trailer_rent_per_truck_week"])
        out[co]["gap_per_truck_week"] = round(cb["admin_insurance_trailer_booked_per_truck_week"] - real_sum, 2)
        out[co]["gap_explanation"] = (
            "The sheet's own Insur/Admin/Trl column was never built by adding these three "
            "things -- it is a hand-set weekly charge with only a handful of distinct tiers "
            "per company (e.g. ZONE runs just 10 distinct values across 300 truck-weeks: "
            "$394.38 x118, $534.28 x114), set mainly to track insurance at cost. It carries "
            "little to none of the trailer-rent allocation and only a rough allowance for the "
            "admin-fee vendor costs (IFTA/ELD/Samsara/Verizon/Motive/Pedigree) named above, so "
            "it does not move when those real costs move. The gap is that mismatch, not a "
            "data error."
        )
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
