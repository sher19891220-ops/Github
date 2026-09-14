"""
Builds the P&L statement payload the dashboard's "Profit & Loss" view reads.

This does not compute anything new -- it assembles numbers three modules
already established and tested, on purpose: `company_pnl.py` (revenue, direct
cost, margin, overhead-adjusted net, ranked gaps), `breakeven.load_overhead`
(the operator-supplied staff/office roster), and `spend_picture.py`'s
company_rollup (the measured, multi-source maintenance floor per company).
Recomputing any of them here would risk disagreeing with the module that owns
that number.

TWO DIFFERENT "OVERHEAD" FIGURES EXIST IN THIS CORPUS AND THIS FILE DOES NOT
RESOLVE THAT.  `cost_structure.py` derives a PER-COMPANY overhead as a
residual of each company's own sheet (gross - net - CD block - OO cost) --
ZONE $672, XTRACK $505, AFG $398 per truck-week. `company_pnl.py` instead
spreads the operator's OWN STATED staff/office roster (`config/overhead.json`)
FLAT across every truck in the group, regardless of company -- $472/truck-week
group-wide for 2026 YTD. They answer different questions (what the sheet's own
arithmetic implies vs what the operator says staff actually costs) and do not
have to agree. This view uses the flat operator-roster figure, exactly as
`company_pnl.py` does, and says so in the payload rather than picking one
silently.

THREE MAINTENANCE FIGURES ALSO COEXIST, AND ARE ALL KEPT: an industry-standard
modeled range ($0.102-$0.220/mile, `company_pnl.py`'s default) used because no
better company-level rate has been fitted; and the measured, multi-source
floor per company from `spend_picture.py` -- known to cover only 42-44% of
what the P&L's own maintenance-adjacent lines carry (see CLAUDE.md), so it
UNDERSTATES real cost and must never be read as the true figure.
"""
import json
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
warnings.filterwarnings("ignore")

from company_pnl import load_payload, company_slice, rank_gaps, COST_LINES
from breakeven import load_overhead

YEAR = "2026"
MAINT_LO, MAINT_HI = 0.102, 0.220


def measured_maintenance():
    """Each company's measured, multi-source maintenance floor, from
    spend_picture.py's already-reconciled company rollup. Multi-year total
    spend, cost-per-mile only where a P&L mileage window exists -- see the
    module's own docstring. Never invented here; imported and run live so a
    stale number can't drift from what spend_picture.py itself would print."""
    import spend_picture as SP
    d, _ = SP.load_all()
    d = SP.add_periods(d)
    cpm = SP.truck_cost_per_mile(d)
    total, _ = SP.company_rollup(d, cpm)
    out = {}
    for co in ("ZONE", "XTRACK", "AFG"):
        if co in total.index:
            row = total.loc[co]
            out[co] = {"total_spend_multi_year": round(float(row["total_spend"]), 2),
                       "cost_per_mile": None if pd_isna(row["cost_per_mile"])
                                        else round(float(row["cost_per_mile"]), 4)}
    return out


def pd_isna(v):
    import math
    try:
        return math.isnan(float(v))
    except (TypeError, ValueError):
        return v is None


def main():
    payload_path = Path(__file__).parent.parent / "dashboard" / "console.html"
    D = load_payload(payload_path)
    ov = load_overhead(Path(__file__).parent.parent / "config" / "overhead.json")
    overhead_total = ov["us_total"] + ov["tashkent"]

    cos = {k: company_slice(e, YEAR) for k, e in D["entities"].items()}
    fleet_trucks = sum(c["trucks"] for c in cos.values())
    ohtw = overhead_total / fleet_trucks

    maint_measured = measured_maintenance()

    companies = {}
    for name, c in cos.items():
        mpw = c["miles_per_truck_week"]
        ml, mh = MAINT_LO * mpw, MAINT_HI * mpw
        net_lo = c["margin_per_truck_week"] - ohtw - mh
        net_hi = c["margin_per_truck_week"] - ohtw - ml
        mm = maint_measured.get(name, {})
        companies[name] = {
            "months": c["months"], "trucks": round(c["trucks"], 1),
            "truck_weeks": round(c["truck_weeks"]), "miles": round(c["miles"]),
            "gross": round(c["gross"], 2),
            "cost_lines": {k: round(c[k], 2) for k, _ in COST_LINES},
            "margin": round(c["margin"], 2),
            "revenue_per_mile": round(c["revenue_per_mile"], 4),
            "margin_per_mile": round(c["margin_per_mile"], 4),
            "miles_per_truck_week": round(mpw),
            "margin_per_truck_week": round(c["margin_per_truck_week"]),
            "overhead_per_truck_week": round(ohtw),
            "maint_model_lo_per_truck_week": round(ml),
            "maint_model_hi_per_truck_week": round(mh),
            "net_lo_per_truck_week": round(net_lo),
            "net_hi_per_truck_week": round(net_hi),
            "net_lo_total": round(net_lo * c["truck_weeks"]),
            "net_hi_total": round(net_hi * c["truck_weeks"]),
            "maint_measured_total_spend_multi_year": mm.get("total_spend_multi_year"),
            "maint_measured_cost_per_mile": mm.get("cost_per_mile"),
        }

    group_gross = sum(c["gross"] for c in cos.values())
    group_margin = sum(c["margin"] for c in cos.values())
    group_miles = sum(c["miles"] for c in cos.values())
    group_net_lo = sum(companies[n]["net_lo_total"] for n in companies)
    group_net_hi = sum(companies[n]["net_hi_total"] for n in companies)

    gaps = rank_gaps(cos, ohtw, MAINT_HI)

    out = {
        "year": YEAR,
        "basis": "2026 year-to-date, from the same weekly P&L series the rest "
                 "of the dashboard reads -- the only period all three "
                 "companies share (AFG's sheet starts 2026-04).",
        "overhead_total_per_week": round(overhead_total),
        "overhead_flat_per_truck_week": round(ohtw),
        "fleet_trucks": round(fleet_trucks, 1),
        "maint_model_range": [MAINT_LO, MAINT_HI],
        "companies": companies,
        "group": {
            "gross": round(group_gross, 2), "margin": round(group_margin, 2),
            "miles": round(group_miles),
            "net_lo": round(group_net_lo), "net_hi": round(group_net_hi),
        },
        "ranked_gaps": [{"company": n, "gap": lab, "period_cost": round(cost),
                         "annualised": round(cost * 12 / cos[n]["months"])}
                        for n, lab, cost, _ in gaps],
        "notes": [
            "Revenue and the five direct cost lines are the weekly P&L sheet's "
            "own numbers -- an assertion the sheet makes, not verified cash. "
            "XTRACK's own panel total disagrees with its unit rows in 10 of 27 "
            "weeks between 2026-03-02 and 2026-06-15 (net -$48,100, -0.52% of "
            "gross); ZONE and AFG tie to the dollar every week.",
            "Driver pay, fuel, truck rent, tolls and insurance/admin/trailer "
            "are NOT comparable across companies -- ZONE runs mostly company "
            "drivers, XTRACK and AFG carry owner-operators who buy their own "
            "fuel and insurance out of a settlement close to full linehaul. A "
            "low fuel line can mean more owner-operators, not cheaper fuel.",
            "Overhead here is the operator's OWN STAFF/OFFICE ROSTER "
            f"(${overhead_total:,.0f}/week) spread FLAT across all "
            f"{fleet_trucks:.0f} group trucks -- not the different, "
            "per-company residual cost_structure.py derives from each "
            "sheet's own arithmetic (ZONE $672, XTRACK $505, AFG $398 per "
            "truck-week). The two do not have to agree and this view does "
            "not reconcile them.",
            "Maintenance is NOT a P&L cost line at all -- margin above is "
            "before it. The $0.102-$0.220/mile range is an industry-standard "
            "model estimate, not a fitted company-specific rate, and it is "
            "'the single most valuable unknown left in this model' -- it "
            "decides whether the net figure is positive or negative for "
            "every company. The separately measured, multi-source floor from "
            "spend_picture.py is far lower per mile, but is known to cover "
            "only 42-44% of what the P&L's own maintenance-adjacent spend "
            "implies (Truck Max + its own invoice log against the panel), so "
            "it systematically understates and is shown only as a floor.",
            "Registration (IRP+HVUT) and IFTA fuel tax appear on NO line of "
            "any P&L and are not in the cost lines above at all -- "
            "cost_structure.py prices them at roughly $31/truck-week "
            "(registration) and $0.007-0.008/mile (IFTA) on the trucks a "
            "filing actually names, which is a floor since registration "
            "only covers 48 of the group's ~93 trucks.",
            "Insurance here is the sheet's own admin/insurance/trailer line, "
            "not the effective (at-cost) premium insurance_cost.py prices "
            "from actual policies and invoices -- that figure runs "
            "$375-471/truck-week by company and is the better number where "
            "precision on insurance specifically matters.",
            "Revenue (gross) is the P&L sheet's own figure, not a bank or "
            "factor confirmation -- Triumph's factoring lists confirm most "
            "of it but show $746,917 (9.7% of factored invoices) genuinely "
            "at risk, and 7.2% of XTRACK's booked gross never went through "
            "the factor at all (freight billed direct is a legitimate "
            "explanation, not automatically an error).",
        ],
    }
    out_path = Path(__file__).parent.parent / "data" / "processed" / "pnl_view.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=None, separators=(",", ":")))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")
    for n, c in companies.items():
        print(f"  {n}: net {c['net_lo_per_truck_week']:+d} to {c['net_hi_per_truck_week']:+d} "
              f"$/truck-week over {c['truck_weeks']} truck-weeks")


if __name__ == "__main__":
    main()
