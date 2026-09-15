"""
Builds the dashboard's IFTA coverage board -- "what works and what doesn't"
across every filed IFTA return and every Oregon return this corpus holds.

Reads ONLY analysis/pnl_accuracy.py's ifta_check() (the sheet vs. the filed
return -- mileage and fuel/mpg tie, per quarter) and analysis/oregon_gap.py's
gaps() (Oregon weight-mile coverage, priced off the same IFTA returns).
Nothing here recomputes a number; both of those modules are already tested
and already the numbers CLAUDE.md/docs/FINDINGS.md report. This script only
reshapes their output into the JSON the dashboard board wants, and classifies
each row ok/warn/crit against the SAME tolerances pnl_accuracy.py itself
uses (IFTA_MILES_TOL, IFTA_GALLONS_TOL = 5%) -- no new threshold invented.

Cold run cost: ifta_check() extracts ~177 PDFs the first time (functools.lru_
cache + ingest/cache.py's own on-disk cache make every run after that fast,
same as every other module that reads this corpus's IFTA returns).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import oregon_gap as OG      # noqa: E402
import pnl_accuracy as PA    # noqa: E402

COMPANIES = ("ZONE", "XTRACK", "AFG")


def _status(pct, tol):
    if pct is None:
        return "unknown"
    if abs(pct) <= tol:
        return "ok"
    if abs(pct) <= tol * 2:
        return "warn"
    return "crit"


def reconciliation_rows():
    rows = []
    for co in COMPANIES:
        for r in PA.ifta_check(co):
            row = {"company": co, "quarter": r["quarter"], "source": r["source"]}
            if r.get("skipped"):
                row.update({"status": "incomplete", "note": r["skipped"],
                            "weeks_in_sheet": r["weeks_in_sheet"]})
                rows.append(row)
                continue
            row.update({
                "weeks_in_sheet": r["weeks_in_sheet"],
                "filed_miles": round(r["filed_miles"]),
                "sheet_miles": round(r["sheet_miles"]),
                "miles_gap_pct": round(r["miles_gap_pct"] * 100, 2),
                "miles_status": _status(r["miles_gap_pct"], PA.IFTA_MILES_TOL),
                "filed_gallons": round(r["filed_gallons"]) if r.get("filed_gallons") else None,
                "sheet_gallons": round(r["sheet_gallons"]) if r.get("sheet_gallons") else None,
                "gallons_gap_pct": round(r["gallons_gap_pct"] * 100, 2)
                                   if r.get("gallons_gap_pct") is not None else None,
                "gallons_status": _status(r.get("gallons_gap_pct"), PA.IFTA_GALLONS_TOL),
                "filed_mpg": round(r["filed_mpg"], 2) if r.get("filed_mpg") else None,
                "sheet_mpg": round(r["sheet_mpg"], 2) if r.get("sheet_mpg") else None,
            })
            row["status"] = "ok" if row["miles_status"] == "ok" and row["gallons_status"] == "ok" else \
                            ("crit" if "crit" in (row["miles_status"], row["gallons_status"]) else "warn")
            rows.append(row)
    return rows


def oregon_rows():
    rows, rate = OG.gaps()
    out = []
    for r in rows:
        status = "ok" if r["gap_miles"] <= 0 else ("crit" if r["tax_at_risk"] > 100 else "warn")
        out.append({
            "company": r["company"], "quarter": r["quarter"], "filed_in": r["filed_in"],
            "ifta_or_miles": round(r["ifta_or_miles"]),
            "oregon_returns_held": r["oregon_returns_held"],
            "oregon_miles_on_them": round(r["oregon_miles_on_them"])
                                     if r["oregon_miles_on_them"] is not None else None,
            "months_with_no_return": r["months_with_no_return"],
            "gap_miles": round(r["gap_miles"]),
            "tax_at_risk": round(r["tax_at_risk"], 2),
            "status": status,
        })
    return out, rate


def main():
    recon = reconciliation_rows()
    oregon, rate = oregon_rows()
    out = {
        "reconciliation": recon,
        "oregon": oregon,
        "oregon_rate": rate,
        "tolerances": {"miles_pct": PA.IFTA_MILES_TOL * 100, "gallons_pct": PA.IFTA_GALLONS_TOL * 100},
        "note": "Every row here is read from analysis/pnl_accuracy.py's ifta_check() and "
                "analysis/oregon_gap.py's gaps() -- both already tested, both the source of "
                "the same numbers in docs/FINDINGS.md. Nothing is recomputed. 'Reconciliation' "
                "checks the weekly P&L sheet against the return actually FILED with a state "
                "under penalty of perjury -- the strongest check in this corpus. 'Oregon' "
                "prices the gap between what the group's own IFTA filings say ran through "
                "Oregon and what Oregon returns this corpus actually holds; a gap here means "
                "'no return in this corpus', not necessarily 'no return filed.'",
    }
    out_path = ROOT / "data" / "processed" / "ifta_board_view.json"
    out_path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")
    print(f"  {len(recon)} reconciliation rows, {len(oregon)} Oregon rows")


if __name__ == "__main__":
    main()
