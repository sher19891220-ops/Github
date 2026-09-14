"""Truck-days: how many were worked, how many were lost, and to what.

WHY THIS SOURCE MATTERS. Everything else in the corpus is weekly or monthly. The
dispatch export is a DAY: one row per driver per day, 7,491 of them across 13
complete weeks (2026-06-01 .. 2026-08-24), each marked

    loadday      a load was booked -- the only rows carrying gross and miles
    transit      running a load booked on an earlier day
    nonrevenue   the truck earned nothing, with a coded reason
    note         not a day at all (day_index 99, free text)

That makes it the only place in the corpus that can say WHY miles per truck
fell. The weekly P&L can only show that they did.

FIVE THINGS THAT WILL MISLEAD A READER OF THIS FILE

1. VACATION IS DELETED, NOT MARKED. A driver inside a `hidden_week_periods` span
   has NO rows at all -- verified across all eleven spans. So the denominator is
   days a driver was expected to work, and the non-revenue rate is not inflated
   by holidays. It also means the truck standing idle through a 7-week vacation
   is INVISIBLE here while still accruing rent and insurance. Roughly 217
   driver-days over the period are missing this way.

2. A BREAKDOWN OFTEN COSTS NO DAYS. `sub_truck_periods` gives the driver another
   truck and they keep working: driver 107 ran 49 days on a substitute after a
   26 June breakdown and booked just two `oos` days. So `shop` + `oos` days are
   a FLOOR on mechanical disruption, not a measure of it -- the real cost landed
   as maintenance and rent instead.

3. COMPANY ATTRIBUTION IS A SNAPSHOT. `drivers.csv` carries one `mc` per driver
   with no history, so a driver who moved between authorities is attributed to
   the current one for every past week.

4. COVERAGE GREW WHILE THE FLEET DID NOT. In June the export held 37 XTRACK
   drivers against 45-51 trucks on the P&L and ran 7.5% below it on gross; by
   late August it held 45 against 48 and matched within 0.1%. The system was
   still being adopted. DOLLAR comparisons against the P&L are therefore only
   safe from 2026-07-13 on, and any trend in a raw weekly count is partly the
   export filling up. Use stable_cohort() -- the drivers present in every week --
   for anything that has to be a trend.

5. GROSS AND MILES SIT ONLY ON `loadday` ROWS. Averaging them over all rows
   silently divides by transit and idle days too.

6. `entry_type` IS NOT THE ANSWER TO "DID THIS TRUCK EARN?". 740 of the 4,684
   rows typed `loadday` -- one in six -- carry ZERO gross and zero miles. Of
   those, 316 also carry an idle reason (`home`, `shop`, `stuck` ...), which
   makes them idle days wearing the wrong type; the other 424 carry no reason at
   all and cannot be explained from this file. Counting every `loadday` as a
   revenue day understates the idle rate by a fifth. So this module classifies
   on the MONEY, not the label:

       revenue     entry_type == loadday AND gross > 0
       idle        entry_type == nonrevenue, OR a zero-gross loadday with a reason
       transit     entry_type == transit  (a load booked on an earlier day)
       unexplained a zero-gross loadday with no reason -- reported, never assigned
"""
import argparse
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OPS = ROOT / "data/raw/ops"
MC = {"Xtrack LLC": "XTRACK", "ZONE OH LLC": "ZONE", "AFG": "AFG"}
NOTE_DAY = 99
# Reasons that are the truck's own mechanical state, as opposed to the driver's
# availability or a booking failure. See trap 2: this is a floor.
MECHANICAL = ("shop", "oos")


def load(last_week=None):
    """Day rows joined to their driver, company and pay type.

    last_week trims a trailing partial week -- the export's final week held 131
    rows against ~650 for a full one, and averaging it in halves every rate.
    """
    le = pd.read_csv(OPS / "load_entries.csv")
    dr = pd.read_csv(OPS / "drivers.csv")
    d = le.merge(
        dr[["id", "mc", "name", "pay_type", "dispatcher", "truck", "driver_status"]]
        .rename(columns={"id": "driver_id", "pay_type": "pt", "dispatcher": "disp"}),
        on="driver_id", how="left", suffixes=("", "_dr"))
    d["co"] = d["mc"].map(MC)
    days = d[d.day_index != NOTE_DAY].copy()
    days["klass"] = classify_day(days)
    if last_week is None:                       # drop a trailing partial week
        n = days.groupby("week_id").size()
        full = n[n >= 0.5 * n.max()].index
        days = days[days.week_id.isin(full)]
    else:
        days = days[days.week_id <= last_week]
    return days, d[d.day_index == NOTE_DAY]


def classify_day(days):
    """Trap 6: the money decides, not `entry_type`."""
    gross = days.pickup_gross.fillna(0)
    reason = days.nr_reason.notna()
    k = pd.Series("transit", index=days.index)
    k[days.entry_type == "loadday"] = "unexplained"
    k[(days.entry_type == "loadday") & (gross > 0)] = "revenue"
    k[(days.entry_type == "loadday") & (gross <= 0) & reason] = "idle"
    k[days.entry_type == "nonrevenue"] = "idle"
    return k


def controls(days, notes):
    """Everything that must hold before a rate here is quoted."""
    fails = []
    cells = days.groupby(["driver_id", "week_id", "day_index"]).size()
    if (cells > 1).any():
        fails.append(("more than one entry in a driver-week-day cell", int((cells > 1).sum())))
    if days["co"].isna().any():
        fails.append(("rows whose driver has no company", int(days["co"].isna().sum())))
    off = days[days.entry_type != "loadday"]
    if off.pickup_gross.fillna(0).ne(0).any() or off.pickup_miles.fillna(0).ne(0).any():
        fails.append(("gross or miles on a non-loadday row",
                      int(off.pickup_gross.fillna(0).ne(0).sum())))
    if not notes.empty and (notes.day_index != NOTE_DAY).any():
        fails.append(("a note row outside day_index 99", int((notes.day_index != NOTE_DAY).sum())))
    lost = int((days.klass == "unexplained").sum())
    if lost:
        fails.append(("zero-gross `loadday` rows with no reason (trap 6) -- "
                      "excluded from both revenue and idle days", lost))
    hidden = pd.read_csv(OPS / "hidden_week_periods.csv")
    leaked = sum(len(days[(days.driver_id == h.driver_id)
                          & (days.week_id >= h.start_date) & (days.week_id <= h.end_date)])
                 for _, h in hidden.iterrows() if h.reason == "Vacation")
    if leaked:
        fails.append(("day rows inside a Vacation span (expected none)", leaked))
    return fails


def utilisation(days, by=("co",)):
    by = list(by)
    g = days.groupby(by)
    out = pd.DataFrame({
        "drivers": g.driver_id.nunique(),
        "days": g.size(),
        "revenue": g.klass.apply(lambda s: (s == "revenue").sum()),
        "transit": g.klass.apply(lambda s: (s == "transit").sum()),
        "idle": g.klass.apply(lambda s: (s == "idle").sum()),
        "unexpl": g.klass.apply(lambda s: (s == "unexplained").sum()),
        "gross": g.pickup_gross.sum(),
        "miles": g.pickup_miles.sum(),
    })
    out["idle%"] = 100 * out.idle / out.days
    out["$/day"] = out.gross / out.days
    out["$/revday"] = out.gross / out.revenue
    out["mi/driver"] = out.miles / out.drivers
    out["rpm"] = out.gross / out.miles
    return out


def reasons(days, by="co"):
    nr = days[days.klass == "idle"]
    t = pd.crosstab(nr.nr_reason, nr[by], margins=True)
    return t.sort_values("All", ascending=False)


def stable_cohort(days, co=None):
    """Drivers present in EVERY week -- the only honest basis for a trend.

    A raw weekly count mixes the real trend with the export filling up (trap 4).
    Holding the cohort fixed removes that entirely.
    """
    d = days[days.co == co] if co else days
    n = d.groupby("driver_id").week_id.nunique()
    return d[d.driver_id.isin(n[n == d.week_id.nunique()].index)]


def opportunity(days, co):
    """What the lost days would have been worth, stated as a RANGE, not a number.

    An idle day converted to a working day earns the company's revenue per
    LOADDAY, not its revenue per available day -- but it also costs fuel and a
    driver, and an idle truck is idle for reasons that would not all yield to
    better dispatch. So this brackets rather than asserts: gross at stake, and
    the same days valued at the peer company's non-revenue rate.
    """
    u = utilisation(days, ("co",))
    me = u.loc[co]
    best = u["idle%"].min()
    excess_days = me.days * (me["idle%"] - best) / 100
    weeks = days.week_id.nunique()
    return {
        "idle_days": int(me.idle),
        "gross_per_revenue_day": me["$/revday"],
        "gross_at_stake_per_week": me.idle * me["$/revday"] / weeks,
        "best_peer_idle_pct": best,
        "excess_days_vs_best_peer": excess_days,
        "gross_if_matched_best_peer_per_week": excess_days * me["$/revday"] / weeks,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--company", default="XTRACK")
    a = ap.parse_args()

    days, notes = load()
    wk = sorted(days.week_id.unique())
    print(f"{len(days):,} truck-days, {len(wk)} weeks {wk[0]} .. {wk[-1]}, "
          f"{days.driver_id.nunique()} drivers")
    fails = controls(days, notes)
    print("controls: all pass" if not fails else "CONTROLS FAILED:")
    for what, n in fails:
        print(f"  {what}: {n}")

    fmt = lambda v: f"{v:,.1f}"
    print("\n== TRUCK-DAYS BY COMPANY ==")
    print(utilisation(days).to_string(float_format=fmt))
    print("\n== IDLE DAYS BY REASON ==")
    print(reasons(days).to_string())
    print("\n== IDLE RATE BY PAY TYPE ==")
    print(utilisation(days, ("pt",))[["drivers", "days", "idle%", "$/revday"]]
          .to_string(float_format=fmt))

    co = a.company
    s = stable_cohort(days, co)
    print(f"\n== {co}: SAME {s.driver_id.nunique()} DRIVERS, EVERY WEEK ==")
    t = utilisation(s, ("week_id",))[["days", "idle", "idle%", "miles", "mi/driver", "gross"]]
    nr = s[s.klass == "idle"]
    for r in ("home", "shop", "oos", "stuck"):
        t[r] = nr[nr.nr_reason == r].groupby("week_id").size().reindex(t.index).fillna(0).astype(int)
    print(t.to_string(float_format=fmt))

    print(f"\n== {co}: IDLE RATE BY DISPATCHER (min 100 days) ==")
    g = utilisation(days[days.co == co], ("disp",))
    g = g[g.days >= 100][["drivers", "days", "idle", "idle%", "$/day"]]
    print(g.sort_values("idle%", ascending=False).to_string(float_format=fmt))
    print("  Association, not cause: driver mix, truck condition and home-time")
    print("  policy differ by desk and are not held constant here.")

    print(f"\n== {co}: WHAT THE IDLE DAYS ARE WORTH ==")
    for k, v in opportunity(days, co).items():
        print(f"  {k:<38}{v:>12,.1f}")


if __name__ == "__main__":
    main()
