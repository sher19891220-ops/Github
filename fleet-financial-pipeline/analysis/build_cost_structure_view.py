"""
Builds the payload for the dashboard's "True cost: registration, insurance,
maintenance & debt" view.

Five pieces that are computed and tested elsewhere, assembled here and
NOWHERE recomputed -- the same discipline as build_pnl_view.py, for the same
reason: a second derivation can drift from the one the tests actually cover.

  1. REGISTRATION, TWO WAYS. `cost_structure.structure()` already carries both
     the plain who-last-ran-it registration rate (a per-company average that
     folds owner-operator and investor trucks into the company that happened
     to run them last) and the corrected, responsibility-based rate from
     `registration.attribute_by_responsibility()` (2026-09-10) -- a single
     group-wide $/truck-week once owner-operators, named investors,
     lease-to-purchase owners and sold/departed drivers bear their own
     IRP/HVUT. Both are shown so the correction is visible, not silent.

  2. IRON LEASE / TBK DEBT SERVICE. `iron_lease.tbk_financing()` reconciles
     the two TBK equipment-finance loans against account 5151's own bank
     feed and corrects a real overstatement: two ACH debits bounced and were
     returned, then re-collected days later, and looked like two extra real
     payments unless matched against the return credit. What is left after
     that correction -- each loan's confirmed payments and its remaining
     contractual cash obligation -- is a real future cost this pipeline does
     not price anywhere else.

  3. BREAK-EVEN GRIDS, ON THE TRUE COST BASIS. `cost_structure.true_breakeven()`
     and `true_breakeven_corrected()` already build the fixed and variable
     totals that include registration, IFTA and Oregon on top of the sheet's
     own numbers. This assembles the same arithmetic into a miles x rate
     grid for both the true and the corrected-registration basis, so the
     effect of the correction is visible at a glance rather than as one
     number.

  4. INSURANCE AT COST. `insurance_cost.py` prices every coverage line on its
     own basis (per unit, per dollar of insured value, per dollar of gross,
     per mile, per owner-operator) and prefers the ACTUAL bill over the rated
     figure wherever one exists -- auto liability nets six return-premium
     credits as units left the schedule. This assembles its per-company
     effective annual/weekly/per-truck-week cost, alongside (never merged
     into) the sheet's own blended admin/insurance/trailer line, and the
     "carried by nobody" total for insured units on no company's P&L.

  5. MAINTENANCE, MEASURED AGAINST THE PANEL'S OWN LINE. `truck_maintenance.py`
     joins two independent repair ledgers to each truck's own P&L window and
     reconciles the combined, company-borne total against the weekly P&L
     panel's own `maintenance` line for the SAME weeks. The ledgers cover
     roughly 40-50% of what the panel books -- a measured floor, never the
     true figure -- and that gap is exactly why `build_pnl_view.py`'s P&L
     view still prices maintenance from a modeled $/mile range rather than
     this ledger alone.

WHY WEEKS=13. Same window `cost_structure.py`'s own tests and CLI default use
-- the last 13 weeks of each company's own sheet -- so this view cannot
disagree with what `python analysis/cost_structure.py` prints for the same
company on the same day.
"""
import json
import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import cost_structure as C     # noqa: E402
import truck_breakeven as B    # noqa: E402
import iron_lease as IL        # noqa: E402
import insurance_cost as INS   # noqa: E402
import truck_maintenance as TM  # noqa: E402
from xtrack_trend import load as load_weeks  # noqa: E402

WEEKS = 13
RATES = (2.40, 2.60, 2.80, 3.00, 3.20, 3.40)
MILES = (1500, 2000, 2500, 3000, 3500, 4000, 4500)
IRON_TXN = ROOT / "data/processed/iron_lease_transactions.csv"


def kept_per_mile(s, rpm):
    return rpm * (1 - s["overhead_pct_of_gross"]) - (s["variable_total"] + s["outside_variable_total"])


def weekly_result_true(s, miles, rpm, fixed):
    return miles * kept_per_mile(s, rpm) - fixed


def breakeven_grid(s):
    fixed_true = s["fixed_total"] + s["outside_fixed_total"]
    fixed_corrected = s["fixed_total_corrected"]
    by_rate = []
    for rpm in RATES:
        k = kept_per_mile(s, rpm)
        by_rate.append({
            "rpm": rpm,
            "breakeven_miles_true": round(fixed_true / k) if k > 0 else None,
            "breakeven_miles_corrected": round(fixed_corrected / k) if k > 0 else None,
        })
    profit_true = [[round(weekly_result_true(s, mi, r, fixed_true)) for r in RATES]
                   for mi in MILES]
    profit_corrected = [[round(weekly_result_true(s, mi, r, fixed_corrected)) for r in RATES]
                        for mi in MILES]
    return {"rates": list(RATES), "miles": list(MILES),
            "by_rate": by_rate, "profit_true": profit_true,
            "profit_corrected": profit_corrected}


def registration_section(ss):
    corrected = next((s["reg_corrected"] for s in ss.values() if s["reg_corrected"]), None)
    companies = {}
    for c, s in ss.items():
        r = s["reg"]
        companies[c] = {
            "trucks_covered": r["trucks"] if r else None,
            "annual": r["annual"] if r else None,
            "per_truck_week_plain": round(r["per_truck_week"], 2) if r else None,
            "fixed_total_plain": round(s["fixed_total"] + s["outside_fixed_total"], 2),
            "fixed_total_corrected": round(s["fixed_total_corrected"], 2),
            "breakeven_miles_plain": round(C.true_breakeven(s, s["m"]["rpm"])),
            "breakeven_miles_corrected": round(C.true_breakeven_corrected(s, s["m"]["rpm"])),
        }
    return {
        "per_truck_week_corrected": round(corrected, 2) if corrected else None,
        "companies": companies,
        "note": "The plain rate is each company's own who-last-ran-it average, which "
                "folds owner-operator and investor trucks into the company that "
                "happened to run them last. The corrected rate is one group-wide "
                "$/truck-week: owner-operators, named investors, lease-to-purchase "
                "owners and sold/departed drivers bear their own IRP/HVUT, and what "
                "is left is split equally across the three companies and spread over "
                "the 90-truck running fleet. Both are shown -- the correction is "
                "smaller for every company, never larger.",
    }


def iron_lease_debt_section():
    if not IRON_TXN.exists():
        return None
    r = IL.tbk_financing()
    loans = []
    total_remaining = 0.0
    total_remaining_interest = 0.0
    for loan in r["loans"]:
        loans.append({
            "loan_id": loan["loan_id"],
            "principal": loan["principal"],
            "annual_rate_pct": loan["annual_rate_pct"],
            "payments_confirmed": loan["payments_confirmed"],
            "payments_total": loan["payments_total"],
            "cash_paid_confirmed": loan["cash_paid_confirmed"],
            "interest_paid_confirmed": loan["interest_paid_confirmed"],
            "principal_paid_confirmed": loan["principal_paid_confirmed"],
            "remaining_balance": loan["remaining_balance"],
            "remaining_payments": loan["remaining_payments"],
            "remaining_cash_obligation": loan["remaining_cash_obligation"],
            "remaining_interest": loan["remaining_interest"],
        })
        total_remaining += loan["remaining_cash_obligation"]
        total_remaining_interest += loan["remaining_interest"]
    return {
        "raw_debit_total": r["raw_debit_total"],
        "real_total": r["real_total"],
        "overstatement": r["overstatement"],
        "bounced_count": len(r["bounced"]),
        "loans": loans,
        "total_remaining_cash_obligation": round(total_remaining, 2),
        "total_remaining_interest": round(total_remaining_interest, 2),
        "note": "Two of the recurring ACH debits bounced and were returned the next "
                "business day, then were re-collected days later under a RETRY PYMT "
                "memo -- both looked like a second real payment unless matched "
                "against the return credit. The corrected total is what account "
                "5151 actually paid the bank; the remaining cash obligation is a "
                "real, contractual future cost not priced anywhere else in this "
                "pipeline.",
    }


def insurance_section(ss):
    reg = INS.load()
    by = INS.per_company(reg)
    fails = INS.controls(reg, by)
    pdal = reg["allocation"]["physical_damage"]["from_the_submitted_schedule"]
    u = INS.unallocated(reg)

    companies = {}
    for c in C.COMPANIES:
        annual = sum(by[c].values())
        units = pdal[c]["units"]
        companies[c] = {
            "annual": round(annual, 2),
            "per_week": round(annual / INS.WEEKS, 2),
            "units": units,
            "per_truck_week": round(annual / INS.WEEKS / units, 2) if units else None,
            "lines": {k: round(v, 2) for k, v in by[c].items()},
            "sheet_admin_insur_trailer_per_truck_week": round(ss[c]["m"]["admin_per_truck_week"], 2),
        }

    carried_annual = sum(v for k, v in u.items() if not k.startswith("_"))
    return {
        "controls_pass": not fails,
        "companies": companies,
        "carried_by_nobody": {
            "annual": round(carried_annual, 2),
            "per_week": round(carried_annual / INS.WEEKS, 2),
            "note": u["_note"],
        },
        "note": "The effective (at-cost) premium: the actual bill where one exists, "
                "the rated figure only where it does not -- auto liability already "
                "nets six return-premium credits paid back as units left the "
                "schedule. The sheet's own 'admin/insurance/trailer' column blends "
                "insurance with a little admin and trailer rent, so it is not the "
                "same figure; shown alongside for comparison, never reconciled "
                "into it. 'Carried by nobody' is the insured units on no "
                "company's P&L at all -- a cleanup, not a misstatement.",
    }


def maintenance_section(ss):
    charges, ledger_fails = TM.all_charges()
    weeks_df = TM.all_weeks()
    rec = TM.reconcile_to_panel(charges, weeks_df)

    companies = {}
    tot_panel = tot_combined = 0.0
    for c in C.COMPANIES:
        wk = load_weeks(B.ROOT / B.WORKBOOK[c])
        n_weeks = len(wk)
        trucks = ss[c]["m"]["trucks"]
        r = rec[c]
        companies[c] = {
            "window_weeks": n_weeks,
            "panel_total": round(r["panel"], 2),
            "ledger_first_source": round(r["first_source"], 2),
            "ledger_second_source": round(r["second_source"], 2),
            "ledger_combined": round(r["combined"], 2),
            "coverage_ratio": round(r["ratio"], 4) if r["ratio"] else None,
            "panel_per_truck_week": round(r["panel"] / n_weeks / trucks, 2),
            "ledger_per_truck_week": round(r["combined"] / n_weeks / trucks, 2),
        }
        tot_panel += r["panel"]
        tot_combined += r["combined"]

    return {
        "companies": companies,
        "fleet_coverage_ratio": round(tot_combined / tot_panel, 4) if tot_panel else None,
        "ledger_has_known_data_quality_issues": any(ledger_fails.values()),
        "note": "Two independent repair ledgers, joined to each truck's own P&L "
                "window and reconciled against the weekly panel's own "
                "'maintenance' line for the same weeks. The ledgers cover "
                "roughly 40-50% of what the panel books -- a measured FLOOR, "
                "never the true figure -- because most repair spend rides the "
                "fuel card or Truck Max invoices this pipeline has not yet "
                "matched line for line. The panel's own per-truck-week figure "
                "is the better number for a total; the ledger is the better "
                "number for which trucks and categories are driving it.",
    }


def main():
    ss = {c: C.structure(c, WEEKS) for c in C.COMPANIES}
    bad = {c: C.controls(s) for c, s in ss.items()}
    if any(bad.values()):
        print("CONTROLS FAILED -- refusing to build a payload on a broken model:")
        for c, f in bad.items():
            for x in f:
                print(f"  {c}: {x}")
        raise SystemExit(1)

    out = {
        "weeks": WEEKS,
        "period": {c: [ss[c]["m"]["from"], ss[c]["m"]["to"]] for c in C.COMPANIES},
        "registration": registration_section(ss),
        "breakeven": {c: breakeven_grid(ss[c]) for c in C.COMPANIES},
        "iron_lease_debt": iron_lease_debt_section(),
        "insurance": insurance_section(ss),
        "maintenance": maintenance_section(ss),
    }
    out_path = ROOT / "data" / "processed" / "cost_structure_view.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=None, separators=(",", ":")))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")
    for c in C.COMPANIES:
        r = out["registration"]["companies"][c]
        print(f"  {c}: fixed {r['fixed_total_plain']:.0f} -> {r['fixed_total_corrected']:.0f} "
              f"corrected, break-even {r['breakeven_miles_plain']} -> "
              f"{r['breakeven_miles_corrected']} mi/wk")
    if out["iron_lease_debt"]:
        print(f"  Iron Lease/TBK remaining obligation: "
              f"${out['iron_lease_debt']['total_remaining_cash_obligation']:,.0f}")
    for c in C.COMPANIES:
        i = out["insurance"]["companies"][c]
        print(f"  {c}: insurance at cost ${i['per_truck_week']:,.0f}/truck-wk "
              f"({i['units']} units) vs sheet's admin/insur/trailer "
              f"${i['sheet_admin_insur_trailer_per_truck_week']:,.0f}/truck-wk")
    for c in C.COMPANIES:
        m = out["maintenance"]["companies"][c]
        print(f"  {c}: maintenance ledger covers "
              f"{m['coverage_ratio'] * 100:.0f}% of the panel's own line "
              f"(${m['ledger_per_truck_week']:,.0f} vs ${m['panel_per_truck_week']:,.0f}/truck-wk)")


if __name__ == "__main__":
    main()
