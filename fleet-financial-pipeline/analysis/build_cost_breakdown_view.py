"""
Builds the payload for the dashboard's full fixed/variable/overhead/break-even
cost breakdown, per company.

Reads ONLY data/processed/facts.json -- the already-built, already-tested
index `analysis/facts.py` produces from cost_structure.py, truck_breakeven.py
and insurance_cost.py. Nothing here recomputes a single number; it only
reshapes facts.json's flat "COMPANY/category/name" keys into the nested
structure the dashboard template wants. Run `python3 analysis/facts.py
--build` first if facts.json is stale -- this script does not check.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPANIES = ("ZONE", "XTRACK", "AFG")
RATES = (2.40, 2.60, 2.80, 3.00, 3.20)


def main():
    facts = json.loads((ROOT / "data/processed/facts.json").read_text())["facts"]

    def v(key):
        return facts[key]["value"] if key in facts else None

    companies = {}
    for co in COMPANIES:
        p = f"{co}/"
        companies[co] = {
            "period": v(p + "period"),
            "trucks": v(p + "trucks"),
            "company_driver_trucks": v(p + "company_driver_trucks"),
            "owner_operator_trucks": v(p + "owner_operator_trucks"),
            "gross_per_week": v(p + "gross_per_week"),
            "net_per_week": v(p + "net_per_week"),
            "fixed": {
                "truck_rent": v(p + "fixed/truck rent, base"),
                "admin_insurance_trailer": v(p + "fixed/admin / insurance / trailer"),
                "fixed_overhead": v(p + "fixed/fixed company overhead"),
                "registration": v(p + "fixed/registration_not_in_the_sheet"),
                "subtotal_in_sheet": v(p + "fixed/subtotal_in_the_sheet"),
                "true_total_per_truck_week": v(p + "fixed/TRUE_TOTAL"),
                "true_total_per_truck_day": v(p + "fixed/per_truck_day"),
            },
            "variable": {
                "fuel": v(p + "variable/fuel"),
                "driver_pay": v(p + "variable/driver_pay"),
                "toll": v(p + "variable/toll"),
                "additional": v(p + "variable/additional"),
                "other": v(p + "variable/other"),
                "iron_lease_mileage": v(p + "variable/Iron Lease mileage charge"),
                "ifta": v(p + "variable/IFTA fuel tax_not_in_the_sheet"),
                "oregon": v(p + "variable/Oregon weight-mile tax_not_in_the_sheet"),
                "true_total_per_mile": v(p + "variable/TRUE_TOTAL"),
                "overhead_pct_of_gross": v(p + "variable/overhead_pct_of_gross"),
            },
            "overhead": {
                "per_truck_week": v(p + "overhead/per_truck_week"),
                "fixed_per_truck_week": v(p + "overhead/fixed_per_truck_week"),
                "variable_per_truck_week": (v(p + "overhead/per_truck_week") or 0)
                                           - (v(p + "overhead/fixed_per_truck_week") or 0),
            },
            "current": {
                "miles_per_truck_week": v(p + "current/miles_per_truck"),
                "rate_per_mile": v(p + "current/rate_per_mile"),
            },
            "breakeven": {
                "miles_at_current_rate": v(p + "breakeven/miles_at_current_rate"),
                "rate_at_current_miles": v(p + "breakeven/rate_at_current_miles"),
                "by_rate": [{"rate": r, "miles": v(p + f"breakeven/miles_at_{r:.2f}")}
                            for r in RATES],
            },
            "idle": {
                "cost_per_truck_week": v(p + "idle/cost_per_truck_week"),
                "cost_per_truck_day": v(p + "idle/cost_per_truck_day"),
            },
            "insurance_annual": {k.split("/")[-1]: fact["value"] for k, fact in facts.items()
                                  if k.startswith(p + "insurance/") and not k.endswith("TOTAL_annual")}
                                 | {"total": v(p + "insurance/TOTAL_annual")},
        }

    out = {
        "companies": companies,
        "note": "Every figure here is read from data/processed/facts.json, itself built by "
                "analysis/cost_structure.py, truck_breakeven.py and insurance_cost.py -- "
                "nothing is recomputed in this script. Fixed cost is per company-driver "
                "truck; owner-operators carry their own equipment and fuel and are not "
                "priced the same way (see CLAUDE.md's owner-operator section). Insurance "
                "here is the effective (at-cost) annual premium, not the sheet's blended "
                "admin/insurance/trailer line, which is shown separately under 'fixed'.",
        "source_fingerprint": json.loads((ROOT / "data/processed/facts.json").read_text())
                                   .get("source_fingerprint"),
    }
    out_path = ROOT / "data" / "processed" / "cost_breakdown_view.json"
    out_path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
