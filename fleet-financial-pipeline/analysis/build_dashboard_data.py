"""
Aggregate every verified source into one JSON bundle for the dashboard.

Monthly granularity throughout: it is the coarsest grain that still shows the
trends the findings rest on, and it keeps the payload small enough to ship
inside the page. Nothing here recomputes anything -- it reads the outputs the
ingesters already produced, so the dashboard cannot disagree with the analysis.

Every figure carries where it came from, because the dashboard separates what a
bank statement proves from what a hand-kept sheet asserts, and a reader has to
be able to tell which they are looking at.
"""
import csv
import json
import collections
from pathlib import Path
import argparse


def rd(p):
    p = Path(p)
    return list(csv.DictReader(p.open())) if p.exists() else []


def f(r, k):
    try:
        return float(r[k]) if r.get(k) not in (None, "") else 0.0
    except (ValueError, TypeError):
        return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--intake", required=True)
    ap.add_argument("--pnl", required=True)
    ap.add_argument("--ironlease", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    I, P, L = Path(a.intake), Path(a.pnl), Path(a.ironlease)
    D = {}

    # ---- per-entity P&L, monthly -----------------------------------------
    ents = {}
    for e in ("ZONE", "XTRACK", "AFG"):
        rows = [r for r in rd(P / f"pnl_unit_week_{e}.csv") if r.get("week_start")]
        if not rows:
            continue
        m = collections.defaultdict(lambda: collections.defaultdict(float))
        units = collections.defaultdict(set)
        for r in rows:
            k = r["week_start"][:7]
            for c in ("gross", "driver_salary", "def_fuel_fee", "truck_rental",
                      "toll_scale", "insur_admin_trl", "total", "mileage"):
                m[k][c] += f(r, c)
            if r.get("unit"):
                units[k].add(r["unit"])
        months = sorted(m)
        ents[e] = {
            "months": months,
            "series": {c: [round(m[k][c], 2) for k in months]
                       for c in ("gross", "driver_salary", "def_fuel_fee",
                                 "truck_rental", "toll_scale", "insur_admin_trl",
                                 "total", "mileage")},
            "units": [len(units[k]) for k in months],
            "unit_weeks": len(rows),
            "period": [months[0], months[-1]],
        }
        idle = [r for r in rows if f(r, "gross") == 0 and f(r, "total") < 0]
        ents[e]["idle_unit_weeks"] = len(idle)
        ents[e]["idle_cost"] = round(sum(f(r, "total") for r in idle), 2)
    D["entities"] = ents

    # ---- verified cash, by category and entity ---------------------------
    cash = rd(I / "cash_categorized.csv")
    NOT_SPEND = {"intercompany", "internal_transfer", "card_payment"}
    cat = collections.defaultdict(float)
    cat_n = collections.Counter()
    for r in cash:
        v = f(r, "amount")
        if v < 0:
            cat[r["category"]] += v
            cat_n[r["category"]] += 1
    D["cash"] = {
        "outflow_by_category": sorted(
            [{"category": k, "amount": round(v, 2), "txns": cat_n[k],
              "spend": k not in NOT_SPEND} for k, v in cat.items()],
            key=lambda x: x["amount"]),
        "revenue_in": round(sum(f(r, "amount") for r in cash
                                if r["category"] == "revenue" and f(r, "amount") > 0), 2),
        "txns": len(cash),
        "period": [min(r["date"] for r in cash), max(r["date"] for r in cash)],
    }
    bym = collections.defaultdict(lambda: collections.defaultdict(float))
    for r in cash:
        v = f(r, "amount")
        k = r["date"][:7]
        if r["category"] == "revenue" and v > 0:
            bym[k]["revenue"] += v
        elif v < 0 and r["category"] not in NOT_SPEND:
            bym[k]["spend"] += -v
    mk = sorted(bym)
    D["cash"]["monthly"] = {"months": mk,
                            "revenue": [round(bym[k]["revenue"], 2) for k in mk],
                            "spend": [round(bym[k]["spend"], 2) for k in mk]}

    # ---- utilization from odometers --------------------------------------
    odo = [r for r in rd(I / "odometers.csv") if r.get("flag") == "ok"]
    yr = collections.defaultdict(lambda: [0.0, 0, set(), 0])
    wks = collections.defaultdict(set)
    for r in odo:
        y = r["week_start"][:4]
        yr[y][0] += f(r, "miles")
        yr[y][1] += 1
        yr[y][2].add(r["unit"])
        if f(r, "miles") == 0:
            yr[y][3] += 1
        wks[y].add(r["week_start"])
    D["utilization"] = [
        {"year": y, "miles": round(yr[y][0]), "unit_weeks": yr[y][1],
         "trucks_per_week": round(yr[y][1] / max(len(wks[y]), 1)),
         "miles_per_truck_week": round(yr[y][0] / max(yr[y][1], 1)),
         "idle_pct": round(yr[y][3] / max(yr[y][1], 1) * 100, 1),
         "miles_per_week": round(yr[y][0] / max(len(wks[y]), 1))}
        for y in sorted(yr)]

    # ---- fuel, both rails ------------------------------------------------
    efs = [r for r in rd(I / "efs_fuel.csv") if r.get("item") == "ULSD" and f(r, "qty") > 0]
    rel = [r for r in rd(I / "relay_txns.csv") if r.get("product") == "Diesel" and f(r, "gallons") > 0]
    fm = collections.defaultdict(lambda: [0.0, 0.0, 0.0, 0.0, 0.0])
    for r in efs:
        k = r["txn_date"][:7]
        fm[k][0] += f(r, "qty")
        fm[k][1] += abs(f(r, "amount"))
    for r in rel:
        k = r["txn_date"][:7]
        fm[k][2] += f(r, "gallons")
        fm[k][3] += abs(f(r, "amount"))
        fm[k][4] += f(r, "discount")
    fk = sorted(fm)
    D["fuel"] = {"months": fk,
                 "efs_gal": [round(fm[k][0]) for k in fk],
                 "efs_amt": [round(fm[k][1], 2) for k in fk],
                 "relay_gal": [round(fm[k][2]) for k in fk],
                 "relay_amt": [round(fm[k][3], 2) for k in fk],
                 "relay_discount": [round(fm[k][4], 2) for k in fk]}

    # ---- breakdowns ------------------------------------------------------
    cases = rd(I / "cases.csv")
    sv = collections.defaultdict(lambda: [0.0, 0])
    cm = collections.defaultdict(lambda: [0.0, 0, 0])
    payer = collections.defaultdict(float)
    for r in cases:
        s = (r.get("service") or "(blank)").title()
        sv[s][0] += f(r, "cost_total")
        sv[s][1] += 1
        k = r.get("month") or "?"
        cm[k][0] += f(r, "cost_total")
        cm[k][1] += 1
        if s in ("Road Call", "Towing"):
            cm[k][2] += 1
        for p in ("zone", "stl", "driver", "dealer"):
            payer[p] += f(r, f"cost_{p}")
    order = ["January", "February", "March", "April", "May", "June", "July",
             "August", "September"]
    D["breakdowns"] = {
        "by_service": sorted([{"service": k, "cost": round(v[0], 2), "events": v[1]}
                              for k, v in sv.items()], key=lambda x: -x["cost"])[:6],
        "by_payer": {k: round(v, 2) for k, v in payer.items()},
        "months": [k for k in order if k in cm],
        "cost": [round(cm[k][0], 2) for k in order if k in cm],
        "events": [cm[k][1] for k in order if k in cm],
        "roadside": [cm[k][2] for k in order if k in cm],
        "total": round(sum(f(r, "cost_total") for r in cases), 2)}

    # ---- Iron Lease ------------------------------------------------------
    led = rd(L / "iron_lease_ledger.csv")
    wk = rd(L / "iron_lease_weekly.csv")
    ent_led = [r for r in led if r["entity"] in ("ZONE", "XTRACK", "AFG")]
    idle = [r for r in wk if f(r, "miles") == 0 and f(r, "truck_rent") > 0]
    D["iron_lease"] = {
        "invoiced": round(sum(f(r, "invoiced") for r in ent_led), 2),
        "paid": round(sum(f(r, "paid") for r in ent_led), 2),
        "by_entity": [{"entity": e,
                       "invoiced": round(sum(f(r, "invoiced") for r in ent_led if r["entity"] == e), 2),
                       "paid": round(sum(f(r, "paid") for r in ent_led if r["entity"] == e), 2)}
                      for e in ("ZONE", "XTRACK", "AFG")],
        "truck_weeks": len(wk),
        "idle_truck_weeks": len(idle),
        "idle_rent": round(sum(f(r, "truck_rent") for r in idle), 2),
        "miles": round(sum(f(r, "miles") for r in wk)),
        "rent": round(sum(f(r, "truck_rent") for r in wk), 2),
        "efs_maint": round(sum(f(r, "efs_maintenance") for r in wk), 2)}

    # ---- tolls -----------------------------------------------------------
    tolls = rd(I / "bestpass_tolls.csv")
    ag = collections.defaultdict(float)
    tm = collections.defaultdict(float)
    for r in tolls:
        ag[r.get("agency") or "?"] += abs(f(r, "amount"))
        tm[r["post_date"][:7]] += abs(f(r, "amount"))
    tk = sorted(tm)
    D["tolls"] = {"total": round(sum(ag.values()), 2), "txns": len(tolls),
                  "top_agencies": sorted([{"agency": k, "amount": round(v, 2)}
                                          for k, v in ag.items()],
                                         key=lambda x: -x["amount"])[:8],
                  "months": tk, "amount": [round(tm[k], 2) for k in tk]}

    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(D, separators=(",", ":")))
    print(f"wrote {a.out}  {Path(a.out).stat().st_size / 1024:.0f} KB")
    for k in D:
        print(f"  {k}")


if __name__ == "__main__":
    main()
