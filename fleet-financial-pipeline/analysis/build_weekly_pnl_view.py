"""
Builds the payload for the dashboard's week-by-week P&L table.

The "Profit & Loss" view's income statement is a single 2026-YTD column per
company -- useful for the headline, useless for "did last week go bad, and
which line did it." This reads the same weekly workbooks `cost_structure.py`
and `truck_breakeven.py` already trust (`xtrack_trend.load()`, cached, one row
per tab) and keeps every week separate instead of collapsing them.

WHY THE COMPANY-DRIVER COST LINES, NOT A WHOLE-COMPANY ONE. Driver pay, fuel,
rent and tolls are read from the COMPANY-DRIVER blocks only (`cd_driver_pay`
etc.) -- exactly the caveat `build_pnl_view.py` and CLAUDE.md's owner-operator
section already carry: an owner-operator's "driver pay" is a settlement
result that can be legitimately negative, its rent and fuel are recovered
from the driver, not borne by the company, and summing an OO block's columns
into these cost lines would either invert a sign or double-count a recovery.
Owner-operator trucks appear on their own line (`oo_result`) instead, exactly
as the sheet itself keeps them apart.

A WEEK IS FLAGGED, NEVER SILENTLY DROPPED, WHEN THE SHEET FAILS ITS OWN
CONTROL. `xtrack_trend.controls()` already checks the panel's own gross
against its unit rows, the CD block's arithmetic, and the other-expense
itemisation -- XTRACK fails 12 of 27 weeks (CLAUDE.md: a real $48,100
disagreement, not a parsing bug). Those weeks are marked `flags` rather than
excluded, so a reader sees exactly which week's numbers the sheet itself does
not reconcile.
"""
import json
import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import truck_breakeven as B  # noqa: E402
import xtrack_trend as X     # noqa: E402

COMPANIES = ("ZONE", "XTRACK", "AFG")


def weekly_rows(company):
    wk = X.load(B.ROOT / B.WORKBOOK[company])
    fails = X.controls(wk)
    flags_by_week = {}
    for f in fails:
        flags_by_week.setdefault(f[0], []).append({"what": f[1], "detail": f[2]})

    rows = []
    for k in sorted(wk):
        d = wk[k]
        rows.append({
            "week": k,
            "cd_trucks": d["cd_trucks"], "oo_trucks": d["oo_trucks"],
            "gross": round(d["gross"], 2),
            "driver_pay": round(d["cd_driver_pay"], 2),
            "fuel": round(d["cd_fuel"], 2),
            "rent": round(d["cd_rent"], 2),
            "toll": round(d["cd_toll"], 2),
            "admin": round(d["cd_admin"], 2),
            "other": round(d["cd_additional"] + d["cd_other"], 2),
            "cd_gross": round(d["cd_gross"], 2),
            "cd_result": round(d["cd_result"], 2),
            "cd_miles": round(d["cd_miles"]),
            "oo_gross": round(d["oo_gross"], 2),
            "oo_result": round(d["oo_result"], 2),
            "overhead": round(d["overhead"], 2),
            "maintenance": round(d["maintenance"], 2),
            "insurance": round(d["insurance"], 2),
            "trailer": round(d["trailer"], 2),
            "factoring": round(d["factoring"], 2),
            "net": round(d["net"], 2),
            "unallocated": round(d["unallocated"], 2),
            "flags": flags_by_week.get(k, []),
        })
    return rows


def main():
    companies = {}
    for c in COMPANIES:
        rows = weekly_rows(c)
        flagged = sum(1 for r in rows if r["flags"])
        companies[c] = {"weeks": rows, "flagged_weeks": flagged}
        print(f"  {c}: {len(rows)} weeks, {flagged} flagged by the sheet's own controls, "
              f"{rows[0]['week']}..{rows[-1]['week']}")

    out = {
        "companies": companies,
        "note": "Driver pay, fuel, truck rent and tolls here are the "
                "COMPANY-DRIVER blocks only -- an owner-operator's settlement "
                "recovers rent and fuel from the driver rather than bearing "
                "them, so folding OO columns into these lines would double-count "
                "a recovery or invert a sign. Owner-operator result sits on its "
                "own line. A week marked with a flag failed one of the sheet's "
                "own reconciliation checks (its panel total does not match its "
                "own unit rows, or its own itemisation does not sum) -- that "
                "week's numbers are the sheet's own assertion, not a verified figure.",
    }
    out_path = ROOT / "data" / "processed" / "weekly_pnl_view.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=None, separators=(",", ":")))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
