"""Build the operator-facing workbook: every XTRACK truck, every week.

One sheet per question, all from analysis/truck_weeks.py so nothing here is a
second, divergent calculation. The money series runs 27 weeks and the day series
13; every sheet says which it is, because a per-week average over the wrong
window is the easiest wrong number to produce here.
"""
import argparse
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import truck_weeks as T
import maintenance_ledger as ML
import truck_breakeven as B
from xtrack_diagnosis import CD_COST_FIELDS

NOTES = [
    ("Weekly by truck", "27 weeks of P&L money joined to 13 weeks of dispatch days. "
     "Day columns are blank before 2026-06-01 because the dispatch export starts there."),
    ("Truck summary", "Whole 27-week period per truck. Company-driver and owner-operator "
     "blocks use different cost columns and are kept apart."),
    ("Why gross fell short", "Against the fleet's own median running truck. The three "
     "causes are applied in order and add up exactly."),
    ("Sitting trucks", "Truck-weeks with zero gross, and the cost charged to them anyway. "
     "'Active', 'Shop' and 'Dealer' are STATUSES the P&L writes into the driver cell "
     "when no driver is assigned; they are not names."),
    ("Sitting runs", "The same weeks grouped into consecutive outages. A blank "
     "dispatch_day_rows means the truck had no driver at all that week."),
    ("Home time policy", "4 days home per 32-day cycle. Entitlement is scaled to the days "
     "each driver actually appears, so a mid-period joiner is not scored as compliant."),
    ("Iron Lease rent", "Contract rate card against what the P&L charged the truck."),
    ("Maintenance charges", "Per-unit repair ledger, 2026 YTD. 'iron lease' rows appear "
     "as a matched pair -- the charge and its credit back -- and net to zero."),
    ("Maintenance by unit", "Same ledger totalled per unit. Trailers and trucks are "
     "separate fleets; a trailer repair is not a cost of the tractor pulling it."),
    ("Break-even scenarios", "Weekly profit for ONE company-driver truck at each "
     "combination of loaded miles and rate, after its own costs and its share of "
     "company overhead. Negative means that truck loses money that week."),
    ("Cost model", "The inputs behind the scenarios, all measured: fixed cost from "
     "parked truck-weeks, cost per mile by least squares, overhead from the "
     "identity gross - net - block costs."),
]


def build(company, out):
    tw = T.truck_weeks(company)
    days = T.day_rows()
    td = T.truck_days(days, company)
    weekly = tw.merge(td.drop(columns=["driver"]), on=["unit", "week"], how="left")
    weekly = weekly[["week", "unit", "kind", "driver", "gross", "miles", "rpm", "odo",
                     "gallons", "mpg", *CD_COST_FIELDS, "cost", "result",
                     "iron_leased", "iron_rent_due", "days", "active", "idle",
                     "home", "shop", "oos", "stuck", "office", "newdriver",
                     "leftcompany", "mechanical"]].sort_values(["unit", "week"])

    cd = tw[tw.kind == "company_driver"]
    summ = cd.groupby("unit").agg(
        driver=("driver", "last"), weeks=("week", "size"),
        weeks_sat=("gross", lambda s: (s <= 0).sum()),
        gross=("gross", "sum"), miles=("miles", "sum"), odo=("odo", "sum"),
        gallons=("gallons", "sum"), result=("result", "sum"),
        **{f: (f, "sum") for f in CD_COST_FIELDS})
    summ["rpm"] = summ.gross / summ.miles
    summ["mpg"] = summ.odo / summ.gallons
    summ["cost_per_mile"] = summ[list(CD_COST_FIELDS)].sum(axis=1) / summ.miles
    summ["result_per_mile"] = summ.result / summ.miles
    summ["miles_per_week"] = summ.miles / summ.weeks
    summ["result_per_week"] = summ.result / summ.weeks
    d = T.truck_days(days, company).groupby("unit").sum(numeric_only=True)
    summ = summ.join(d[["days", "active", "idle", "home", "mechanical"]], how="left")

    short = T.gross_shortfall(tw)
    sit = tw[(tw.kind == "company_driver") & (tw.gross <= 0)].copy()
    sit["cost"] = sit[list(CD_COST_FIELDS)].sum(axis=1)
    sitting = (sit.merge(T.truck_days(days, company).drop(columns=["driver"]),
                         on=["unit", "week"], how="left")
               .rename(columns={"driver": "driver_or_status"})
               [["week", "unit", "driver_or_status", "cost", *CD_COST_FIELDS,
                 "days", "active", "idle", "home", "shop", "oos", "stuck",
                 "office", "newdriver", "leftcompany"]]
               .sort_values(["unit", "week"]))
    short_ben = T.gross_shortfall(tw)
    ben = short_ben.attrs["benchmark_miles"] * short_ben.attrs["benchmark_rpm"]
    runs = T.sitting_runs(tw, days, company, benchmark=ben)
    policy = T.home_time_policy(days, company)
    policy.insert(0, "band", policy.variance.map(T.policy_band))
    policy = policy.sort_values(["band", "variance"])
    rent = T.iron_rent_check(tw).groupby("unit").agg(
        weeks=("week", "size"), miles=("miles", "sum"),
        contract_due=("iron_rent_due", "sum"), charged=("rent", "sum"))
    rent["gap"] = rent.charged - rent.contract_due
    rent["base_rent"] = [T.IRON_RATE_CARD[u][0] for u in rent.index]
    rent["per_mile"] = [T.IRON_RATE_CARD[u][1] for u in rent.index]

    maint, _ = ML.load(company)
    mcols = ["date", "month", "unit", "unit_type", "category", "amount", "borne_by",
             "Cost type", "Issued To"]
    by_unit = (maint.groupby(["unit_type", "unit"])
               .agg(charges=("amount", "size"), total=("amount", "sum"),
                    first=("date", "min"), last=("date", "max"))
               .sort_values("total", ascending=False).reset_index())

    bm = B.model(company, 13)
    rates = [2.20, 2.40, 2.60, 2.80, 3.00, 3.20, 3.40]
    grid = pd.DataFrame(
        [{"loaded_miles_per_week": mi,
          **{f"${r:.2f}/mi": round(B.weekly_result(bm, mi, r)) for r in rates}}
         for mi in range(1000, 5001, 250)])
    be = pd.DataFrame([{"rpm": r,
                        "kept_per_mile": round(B.contribution_per_mile(bm, r), 4),
                        "breakeven_miles_per_week": round(B.breakeven_miles(bm, r)),
                        "breakeven_miles_per_driving_day": round(B.breakeven_miles(bm, r) / 5),
                        "breakeven_gross_per_week": round(B.breakeven_miles(bm, r) * r)}
                       for r in rates])
    grid = pd.concat([be, pd.DataFrame([{}]), grid], ignore_index=True)
    inputs = pd.DataFrame(
        [{"input": k, "value": v} for k, v in bm.items()
         if isinstance(v, (int, float))]
        + [{"input": f"parked cost: {k}", "value": round(v, 2)}
           for k, v in bm["parked_lines"].items()]
        + [{"input": f"cost per mile: {k}", "value": round(v[1], 4)}
           for k, v in bm["line_fit"].items()])

    sheets = {"Weekly by truck": weekly, "Truck summary": summ.reset_index(),
              "Why gross fell short": short.reset_index(), "Sitting trucks": sitting, "Sitting runs": runs,
              "Home time policy": policy.reset_index(drop=True),
              "Iron Lease rent": rent.reset_index(),
              "Maintenance charges": maint[mcols].sort_values(["unit", "date"]),
              "Maintenance by unit": by_unit,
              "Break-even scenarios": grid, "Cost model": inputs}
    with pd.ExcelWriter(out, engine="xlsxwriter") as xl:
        book = xl.book
        head = book.add_format({"bold": True, "bg_color": "#1F3864", "font_color": "white",
                                "border": 1, "text_wrap": True, "valign": "vcenter"})
        note = book.add_format({"italic": True, "font_color": "#555555", "text_wrap": True})
        for name, df in sheets.items():
            df.to_excel(xl, sheet_name=name, index=False, startrow=2)
            ws = xl.sheets[name]
            ws.write(0, 0, dict(NOTES).get(name, ""), note)
            ws.set_row(0, 30)
            for i, c in enumerate(df.columns):
                ws.write(2, i, str(c), head)
                width = max(len(str(c)) + 2, 11)
                ws.set_column(i, i, min(width, 24))
            ws.freeze_panes(3, 2)
            ws.autofilter(2, 0, 2 + len(df), len(df.columns) - 1)
    return out, {k: len(v) for k, v in sheets.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--company", default="XTRACK")
    ap.add_argument("--out", default="data/processed/xtrack_truck_report.xlsx")
    a = ap.parse_args()
    out, counts = build(a.company, a.out)
    print(f"{out}")
    for k, v in counts.items():
        print(f"  {k:<24}{v:>6} rows")


if __name__ == "__main__":
    main()
