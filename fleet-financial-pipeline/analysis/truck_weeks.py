"""Every truck, every week: what it earned, what it cost, and what it was doing.

Three sources, joined on the truck number, which is the same identifier in all
three (51 of XTRACK's 52 rostered trucks match its P&L units exactly):

  weekly P&L blocks   money -- gross, miles and the cost columns, 27 weeks
                      2026-02-23 .. 2026-08-24
  dispatch day rows   time  -- what the truck was doing each day, 13 weeks
                      2026-06-01 .. 2026-08-24, so the money series is twice as
                      long as the day series and the two must not be averaged
                      over the same window without saying which
  Iron Lease rate card contract -- the base rent and per-mile rate the truck is
                      supposed to be charged

WHAT THE JOIN CAN AND CANNOT DO

- A truck moves between operating companies. 1500 and 1722 appear in XTRACK and
  AFG, 15909 and 7605 in XTRACK and ZONE, 4716 and 1431 in ZONE and AFG. So
  "XTRACK's trucks" is a per-week fact, not a list, and an Iron Lease rent
  charge belongs to whoever was running the truck that week.
- A driver, not a truck, is what the dispatch export keys on, and `drivers.csv`
  gives one truck per driver with no history. `sub_truck_periods` shows drivers
  moving to a substitute truck after a breakdown, so during those spans the day
  rows describe the DRIVER's activity on a different truck than the one named.
  Nine such spans exist; they are flagged, not silently joined.
- Two of the 22 trucks on the rate card (5007, 6379) appear in no P&L at all.

THE COST COLUMNS DIFFER BY BLOCK TYPE. A company-driver block charges the
company for fuel, rent and tolls; an owner-operator block charges the operator
and shows the company's cut. They are not comparable per truck and are never
summed together here -- see analysis/xtrack_diagnosis.py for the layouts.
"""
import argparse
import json
import sys
from pathlib import Path

import openpyxl
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
sys.path.insert(0, str(ROOT / "analysis"))
from ingest_weekly_pnl import week_key, WORKBOOKS
from xtrack_diagnosis import read_blocks, CD_COST_FIELDS

# Operator-supplied 2026-09-04. Base rent is per truck-week; the rate is per
# mile. Two tiers, and which tier a truck is on is a property of the truck.
IRON_RATE_CARD = {
    **{u: (735.0, 0.10) for u in
       ("15739", "4772", "6867", "15909", "15852", "15862", "9859", "6799")},
    **{u: (900.0, 0.12) for u in
       ("4716", "1489", "7605", "1431", "1645", "1568", "1542", "5007",
        "5269", "6379", "1500", "3773", "4549", "1722")},
}
# 4 weeks out then 4 days home: a 32-day cycle carrying 4 home days.
POLICY_CYCLE_DAYS = 32
POLICY_HOME_DAYS = 4


def truck_weeks(company="XTRACK"):
    """One row per truck per week, from the P&L unit blocks."""
    wb = openpyxl.load_workbook(WORKBOOKS[company], data_only=True)
    rows = []
    for tab in sorted([t for t in wb.sheetnames if week_key(t)], key=week_key):
        wk = week_key(tab)
        for b in read_blocks(wb[tab]):
            r = {"week": wk, "company": company, "unit": b["unit"], "kind": b["kind"],
                 "driver": b.get("driver_name", ""), "gross": b.get("gross", 0.0),
                 "miles": b.get("miles", 0.0), "odo": b.get("odo", 0.0),
                 "gallons": b.get("gallons", 0.0), "result": b.get("result", 0.0)}
            for f in CD_COST_FIELDS:
                r[f] = b.get(f, 0.0)
            r["company_charge"] = b.get("company_charge", 0.0)
            rows.append(r)
    d = pd.DataFrame(rows)
    d["rpm"] = (d.gross / d.miles).where(d.miles > 0)
    d["mpg"] = (d.odo / d.gallons).where(d.gallons > 0)
    d["cost"] = d[list(CD_COST_FIELDS)].sum(axis=1)
    base = d.unit.map(lambda u: IRON_RATE_CARD.get(u, (None, None))[0])
    rate = d.unit.map(lambda u: IRON_RATE_CARD.get(u, (None, None))[1])
    d["iron_leased"] = base.notna()
    d["iron_rent_due"] = base + rate * d.miles
    return d


def day_rows():
    """Dispatch days, classified, with the truck the driver is rostered on."""
    sys.path.insert(0, str(ROOT / "analysis"))
    import load_days
    days, _ = load_days.load()
    days["unit"] = days.truck.astype("Int64").astype(str)
    return days


def truck_days(days, company=None):
    d = days[days.co == company] if company else days
    g = d.groupby(["unit", "week_id"])
    t = pd.DataFrame({
        "driver": g.name.first(),
        "days": g.size(),
        "active": g.klass.apply(lambda s: s.isin(["revenue", "transit"]).sum()),
        "idle": g.klass.apply(lambda s: (s == "idle").sum()),
    })
    idle = d[d.klass == "idle"]
    for r in ("home", "shop", "oos", "stuck", "office", "newdriver", "leftcompany",
              "health", "hos", "cancelled", "ready", "rescheduled", "late", "deadhead"):
        t[r] = idle[idle.nr_reason == r].groupby(["unit", "week_id"]).size().reindex(t.index).fillna(0).astype(int)
    t["mechanical"] = t.shop + t.oos
    return t.reset_index().rename(columns={"week_id": "week"})


def home_time_policy(days, company=None):
    """Does each driver take the 4-days-home-per-4-weeks-out the policy sets?

    Two different failures hide in one average, so both are measured:
      too FEW home days -- the driver is not getting the rest the policy promises
      too MANY          -- the truck is parked more than the policy funds
    A driver's expected entitlement is scaled to the days they actually appear,
    because drivers join and leave mid-period and a flat 91-day denominator
    would score a joiner as compliant by accident.
    """
    d = days[days.co == company] if company else days
    g = d.groupby("driver_id")
    out = pd.DataFrame({
        "driver": g.name.first(), "unit": g.truck.first().astype("Int64").astype(str),
        "pay_type": g.pt.first(), "dispatcher": g.disp.first(),
        "days_on_book": g.size(),
        "home_days": g.apply(lambda x: ((x.klass == "idle") & (x.nr_reason == "home")).sum(),
                             include_groups=False),
    })
    out["home_days_due"] = out.days_on_book * POLICY_HOME_DAYS / POLICY_CYCLE_DAYS
    out["variance"] = out.home_days - out.home_days_due
    out["home_pct"] = 100 * out.home_days / out.days_on_book
    # Longest run of consecutive days with no home day, per driver: the policy
    # is about the CYCLE, and a driver can hit the right total while running
    # nine weeks straight and then taking eight days.
    runs = {}
    for did, x in d.sort_values(["week_id", "day_index"]).groupby("driver_id"):
        best = cur = 0
        for is_home in ((x.klass == "idle") & (x.nr_reason == "home")):
            cur = 0 if is_home else cur + 1
            best = max(best, cur)
        runs[did] = best
    out["longest_stretch_out"] = pd.Series(runs)
    return out.sort_values("variance")


def gross_shortfall(tw, kind="company_driver"):
    """Split each truck's gross shortfall into sitting, short miles, and rate.

    Against a benchmark of the fleet's own median running truck, so it measures
    dispersion inside the fleet rather than against an outside standard. The
    three steps are applied in order and are exactly additive -- clipping any of
    them at zero (a truck CAN beat the benchmark) breaks the identity and makes
    the parts sum to more than the whole.
    """
    d = tw[tw.kind == kind].copy()
    run = d[d.gross > 0]
    ben_mi = run.groupby("week").apply(lambda x: x.miles.sum() / len(x),
                                       include_groups=False).median()
    ben_rpm = run.gross.sum() / run.miles.sum()
    g = d.groupby("unit").agg(driver=("driver", "last"), weeks=("week", "size"),
                              sat=("gross", lambda s: (s <= 0).sum()),
                              gross=("gross", "sum"), miles=("miles", "sum"))
    g["ran"] = g.weeks - g.sat
    g["potential"] = g.weeks * ben_mi * ben_rpm
    g["lost_sitting"] = g.sat * ben_mi * ben_rpm
    g["lost_miles"] = (g.ran * ben_mi - g.miles) * ben_rpm
    g["lost_rate"] = g.miles * ben_rpm - g.gross
    g["shortfall"] = g.potential - g.gross
    g.attrs["benchmark_miles"] = ben_mi
    g.attrs["benchmark_rpm"] = ben_rpm
    return g


# The P&L writes a STATUS into the Driver cell when no driver is assigned to the
# truck that week. It is not a name and must not be read as one.
TRUCK_STATUS = ("Active", "Shop", "Dealer")


def sitting_runs(tw, days=None, company=None, benchmark=None):
    """Consecutive weeks a truck earned nothing, with the status and the day detail.

    A run, not a week, is the unit that matters: twelve separate idle weeks and
    one twelve-week outage cost the same money and mean completely different
    things operationally.
    """
    sit = tw[(tw.kind == "company_driver") & (tw.gross <= 0)].copy()
    sit["cost"] = sit[list(CD_COST_FIELDS)].sum(axis=1)
    if days is not None:
        sit = sit.merge(truck_days(days, company), on=["unit", "week"],
                        how="left", suffixes=("", "_ops"))
    order = {w: i for i, w in enumerate(sorted(tw.week.unique()))}
    out = []
    for (unit, status), x in sit.groupby(["unit", "driver"]):
        wks = sorted(x.week)
        run = [wks[0]]
        for w in wks[1:]:
            if order[w] == order[run[-1]] + 1:
                run.append(w)
            else:
                out.append((unit, status, run))
                run = [w]
        out.append((unit, status, run))
    rows = []
    for unit, status, run in out:
        x = sit[(sit.unit == unit) & sit.week.isin(run)]
        r = {"unit": unit, "status": status, "first_week": run[0], "last_week": run[-1],
             "weeks": len(run), "cost_charged": x.cost.sum(),
             "rent": x.rent.sum(), "admin_insurance": x.admin.sum(),
             "driver_pay": x.driver_pay.sum(), "fuel": x.fuel.sum()}
        if benchmark:
            r["gross_forgone_at_benchmark"] = len(run) * benchmark
        if days is not None:
            r["dispatch_day_rows"] = x.days.sum()
            r["no_driver_on_the_truck"] = bool(x.days.isna().all())
            for c in ("active", "idle", "home", "shop", "oos", "stuck", "office",
                      "newdriver", "leftcompany"):
                r[c] = x[c].sum()
        rows.append(r)
    return pd.DataFrame(rows).sort_values(["weeks", "cost_charged"], ascending=False)


def policy_band(variance):
    """Two failures hide in one average, so the bands are symmetric."""
    if variance <= -3:
        return "well under"
    if variance < -1:
        return "under"
    if variance <= 1:
        return "on policy"
    if variance < 3:
        return "over"
    return "well over"


def iron_rent_check(tw):
    """Contract rent vs what the P&L actually charged the truck."""
    d = tw[tw.iron_leased & (tw.kind == "company_driver")].copy()
    d["rent_gap"] = d.rent - d.iron_rent_due
    return d


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--company", default="XTRACK")
    ap.add_argument("--csv", help="write the per-truck-week table here")
    a = ap.parse_args()
    co = a.company

    tw = truck_weeks(co)
    days = day_rows()
    td = truck_days(days, co)
    m = tw.merge(td, on=["unit", "week"], how="left", suffixes=("", "_ops"))
    wk = sorted(tw.week.unique())
    print(f"{co}: {len(tw):,} truck-weeks, {tw.unit.nunique()} units, "
          f"{len(wk)} weeks {wk[0]} .. {wk[-1]}")
    print(f"   day data joined on {m.days.notna().sum():,} of them "
          f"({sorted(td.week.unique())[0]} .. {sorted(td.week.unique())[-1]})")
    fmt = lambda v: f"{v:,.0f}"
    g = gross_shortfall(tw)
    t = g[["potential", "gross", "shortfall", "lost_sitting", "lost_miles", "lost_rate"]].sum()
    print(f"\nbenchmark: the fleet's own median running truck, "
          f"{g.attrs['benchmark_miles']:,.0f} loaded miles/week at "
          f"${g.attrs['benchmark_rpm']:.3f}")
    print("== WHY GROSS FELL SHORT (company drivers) ==")
    print(f"  potential                     ${t.potential:>12,.0f}")
    print(f"  actual                        ${t.gross:>12,.0f}")
    for lab, k in (("weeks the truck sat", "lost_sitting"),
                   ("short miles when running", "lost_miles"),
                   ("rate below the fleet average", "lost_rate")):
        print(f"    {lab:<28}${t[k]:>12,.0f}   {100 * t[k] / t.shortfall:>5.0f}%")
    print(f"  shortfall                     ${t.shortfall:>12,.0f}")

    sit = tw[(tw.kind == "company_driver") & (tw.gross <= 0)]
    carried = sit[list(CD_COST_FIELDS)].sum().sum()
    print(f"\n== WHAT A SITTING TRUCK STILL COSTS ==")
    print(f"  {len(sit)} of {(tw.kind == 'company_driver').sum()} truck-weeks earned nothing "
          f"({100 * len(sit) / (tw.kind == 'company_driver').sum():.1f}%)")
    print(f"  cost charged to them anyway   ${carried:,.0f} "
          f"(${carried / len(sorted(tw.week.unique())):,.0f} a week)")
    for f in ("rent", "admin", "driver_pay", "other"):
        print(f"    {f:<28}${sit[f].sum():>12,.0f}")
    print("  status written in the driver cell of those weeks:")
    for k, v in sit.driver.value_counts().head(5).items():
        print(f"    {str(k):<28}{v:>5} weeks")

    r = iron_rent_check(tw)
    if len(r):
        print("\n== IRON LEASE RENT: CONTRACT vs CHARGED ==")
        q = r.groupby("unit").agg(weeks=("week", "size"), miles=("miles", "sum"),
                                  due=("iron_rent_due", "sum"), charged=("rent", "sum"))
        q["gap"] = q.charged - q.due
        q["sat"] = r[r.gross <= 0].groupby("unit").size().reindex(q.index).fillna(0).astype(int)
        print(q.to_string(float_format=fmt))
        print(f"  contract ${q.due.sum():,.0f}, charged ${q.charged.sum():,.0f}, "
              f"gap ${q.gap.sum():,.0f}")

    if a.csv:
        m.to_csv(a.csv, index=False)
        print(f"\n-> {a.csv}")
    return m


if __name__ == "__main__":
    main()
