"""
Builds the payload for the dashboard's operator-supplied overhead panel.

This is NOT a re-derivation of `cost_structure.py`'s per-company fixed
overhead and break-even table -- that table is a P&L residual
(gross - net - CD block - OO cost) computed straight from the weekly sheets,
and it does not read `config/overhead.json` at all. This view exists
precisely because that gap means a real pay change to a named person on the
US staff/shop roster (Frank, Ilfat, ...) never shows up anywhere else in the
dashboard. It reads `analysis/breakeven.py`'s own `load_overhead()` so this
panel can never disagree with what that script would print on the command
line, and reuses the same verified cash and P&L sources `breakeven.py` takes
on the CLI.

THE SHOP IS EXCLUDED FROM THE HEADLINE GROUP FIGURE, ON PURPOSE, matching
`breakeven.py`'s own default and the operator's own instruction recorded in
`config/overhead.json` ("we will calculate shop independently"). Both the
shop-excluded and shop-included numbers are computed and shown side by side
so a mechanic's raise is never silently invisible just because the shop
happens to be the excluded default.
"""
import csv
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import breakeven as BE  # noqa: E402

TRUCKS = 90
SINCE = "2026-01-01"
MAINT_PER_MILE = 0.220


def f(r, k="amount"):
    try:
        return float(r[k]) if r.get(k) else 0.0
    except (ValueError, TypeError):
        return 0.0


def equipment_fixed(cash_csv):
    rows = [r for r in csv.DictReader(Path(cash_csv).open())
            if f(r) < 0 and r["date"] >= SINCE and r["account"] in BE.TRUCKING]
    d0 = datetime.fromisoformat(min(r["date"] for r in rows))
    d1 = datetime.fromisoformat(max(r["date"] for r in rows))
    weeks = max((d1 - d0).days / 7, 1)
    per_cat = {k: sum(abs(f(r)) for r in rows if r["category"] == k) / weeks
               for k in BE.EQUIP_CATS}
    return {"period": [d0.date().isoformat(), d1.date().isoformat()],
            "weeks": round(weeks, 1), "by_category": per_cat,
            "total_per_week": sum(per_cat.values())}


def variable_per_mile(pnl_dir):
    pr = []
    for e in ("ZONE", "XTRACK", "AFG"):
        p = Path(pnl_dir) / f"pnl_unit_week_{e}.csv"
        if not p.exists():
            continue
        for r in csv.DictReader(p.open()):
            if (r.get("week_start", "") >= SINCE and f(r, "gross") > 500
                    and f(r, "mileage") > 100
                    and f(r, "driver_salary") / f(r, "gross") < BE.OO_THRESHOLD):
                pr.append(r)
    miles = sum(f(r, "mileage") for r in pr)
    gross = sum(f(r, "gross") for r in pr)
    per_mile = {k: sum(f(r, k) for r in pr) / miles
                for k in ("def_fuel_fee", "driver_salary", "toll_scale")}
    per_mile["maintenance_modeled"] = MAINT_PER_MILE
    total_var = sum(per_mile.values())
    rpm = gross / miles
    cm_exact = rpm - total_var
    return {"unit_weeks": len(pr), "miles": round(miles),
            "revenue_per_mile": round(rpm, 3), "per_mile": {k: round(v, 3) for k, v in per_mile.items()},
            "total_variable_per_mile": round(total_var, 3),
            "contribution_per_mile": round(cm_exact, 3), "_contribution_per_mile_exact": cm_exact}


def group_figures(eq_total, oh, cm_exact, trucks):
    """`cm_exact` must be the UNROUNDED contribution per mile -- breakeven.py's
    own CLI divides by the unrounded value, and this view exists precisely so
    it can never disagree with what that script prints."""
    fixed_wk = eq_total + oh
    per_truck = fixed_wk / trucks
    be_miles = per_truck / cm_exact
    return {"fixed_per_week": round(fixed_wk, 2), "fixed_per_truck_week": round(per_truck, 2),
            "fixed_per_year": round(fixed_wk * 52, 2),
            "breakeven_miles_per_truck_week": round(be_miles),
            "fleet_breakeven_miles_per_week": round(fixed_wk / cm_exact)}


def roster_detail(cfg):
    """Named lines the operator can actually recognize by name -- not the
    rolled-up totals load_overhead() returns, since the whole point of this
    view is to make an individual raise visible."""
    def line(x, extra=None):
        d = {"name": x["name"], "role": x.get("role") or x.get("basis"),
             "amount": x["amount"], "period": x["period"]}
        if extra:
            d.update(extra)
        if "_note" in x:
            d["note"] = x["_note"]
        return d

    us_staff = [line(x) for x in cfg["us_staff_1099"]]
    shop = [line(x, {"rate": x.get("rate"), "hours": x.get("hours")} if x.get("basis") == "hourly" else None)
            for x in cfg["entities"]["shop"]["labour"]]
    return {"us_staff_1099": us_staff, "shop_labour": shop}


def main():
    cash_csv = ROOT / "data/processed/cash_categorized.csv"
    pnl_dir = ROOT / "data/processed"
    overhead_cfg = ROOT / "config/overhead.json"

    ov = BE.load_overhead(str(overhead_cfg))
    cfg = ov["cfg"]
    eq = equipment_fixed(cash_csv)
    var = variable_per_mile(pnl_dir)
    cm_exact = var.pop("_contribution_per_mile_exact")

    tashkent = ov["tashkent"]
    # ov["us_total"] is staff + w2 + OWNERS + yard (see breakeven.load_overhead) --
    # it already includes owners, so it must be netted back out here before
    # "owners" is added as its own line, matching the same fix applied to
    # breakeven.py's CLI (it had exactly this double-count) and how
    # company_pnl.py / build_pnl_view.py already use this field with no
    # separate owners addition at all.
    owners = ov["owners"]
    us = ov["us_total"] - owners
    shop = ov["shop"]
    oh_excl = tashkent + us + owners
    oh_incl = oh_excl + shop

    recent_changes = [
        {"name": "Samuel Gonzalez Frank", "role": "US staff (fleet and staff)",
         "field": "amount_per_week", "old": 1000, "new": 1150,
         "changed": "2026-09-14"},
        {"name": "Ilfat", "role": "shop mechanic", "field": "hourly_rate",
         "old": 32, "new": 35, "hours": 54,
         "old_amount_per_week": 1728, "new_amount_per_week": 1890,
         "changed": "2026-09-14"},
    ]
    # "Before" is derived by subtracting each change's own delta back out of the
    # CURRENT roster totals, using this run's own corrected (post-bugfix)
    # arithmetic throughout -- never a second, independently-computed baseline
    # that could drift from it. Frank's delta sits in "us" (US staff); Ilfat's
    # sits in "shop", which is excluded from the group figure by default, so
    # only the shop-included scenario ever reflects it.
    delta_us = sum(c["new"] - c["old"] for c in recent_changes if c["field"] == "amount_per_week")
    delta_shop = sum(c["new_amount_per_week"] - c["old_amount_per_week"]
                      for c in recent_changes if c["field"] == "hourly_rate")
    us_before = us - delta_us
    shop_before = shop - delta_shop
    oh_excl_before = tashkent + us_before + owners
    oh_incl_before = oh_excl_before + shop_before

    out = {
        "as_of": cfg["as_of"],
        "trucks_assumed": TRUCKS,
        "source": "operator-supplied roster (config/overhead.json), read through "
                  "analysis/breakeven.py's own load_overhead() -- never recomputed "
                  "separately, so this panel cannot disagree with the CLI script.",
        "note": "This is NOT the same 'fixed overhead' as the True-cost view's "
                "per-company table. That one is a P&L residual and does not "
                "read this roster at all, so a named raise here (Frank, Ilfat) "
                "never moves it. This view exists so a roster change is visible "
                "somewhere.",
        "recent_changes": recent_changes,
        "roster": roster_detail(cfg),
        "equipment_fixed": eq,
        "overhead": {
            "tashkent_per_week": round(tashkent, 2),
            "us_staff_and_office_per_week": round(us, 2),
            "us_staff_and_office_before_per_week": round(us_before, 2),
            "owners_per_week": round(owners, 2),
            "shop_per_week": round(shop, 2),
            "shop_before_per_week": round(shop_before, 2),
            "total_excl_shop_per_week": round(oh_excl, 2),
            "total_incl_shop_per_week": round(oh_incl, 2),
        },
        "variable": var,
        "group_breakeven": {
            "before": group_figures(eq["total_per_week"], oh_excl_before, cm_exact, TRUCKS),
            "shop_excluded": group_figures(eq["total_per_week"], oh_excl, cm_exact, TRUCKS),
            "shop_included": group_figures(eq["total_per_week"], oh_incl, cm_exact, TRUCKS),
        },
        "shop_excluded_note": "The shop is excluded from the headline group figure by the "
            "operator's own instruction ('we will calculate shop independently') -- it is "
            "costed as its own entity, not a line of trucking overhead. The shop-included "
            "figure above shows what folding it in would do, but the default the operator "
            "asked for is shop-excluded.",
    }

    out_path = ROOT / "data" / "processed" / "overhead_view.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=None, separators=(",", ":")))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")
    print(f"  group fixed/truck-week, shop excluded: ${out['group_breakeven']['shop_excluded']['fixed_per_truck_week']:,.2f}, "
          f"break-even {out['group_breakeven']['shop_excluded']['breakeven_miles_per_truck_week']:,} mi/wk")
    print(f"  group fixed/truck-week, shop included: ${out['group_breakeven']['shop_included']['fixed_per_truck_week']:,.2f}, "
          f"break-even {out['group_breakeven']['shop_included']['breakeven_miles_per_truck_week']:,} mi/wk")


if __name__ == "__main__":
    main()
