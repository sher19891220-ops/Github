"""
Dispatch board (Supabase) -> per-unit revenue, miles and utilization.

Reads either CSV exports or, on a machine that can reach Postgres, the live
tables via the read-only `pnl_reader` role. Same transforms either way.

FOUR THINGS THE RAW DATA WILL GET WRONG IF TAKEN AT FACE VALUE
--------------------------------------------------------------
1. Only `entry_type = 'loadday'` is revenue. `nonrevenue`, `transit` and `note`
   rows also carry a pickup_gross column, and summing the column blindly mixes
   them in. The non-revenue rows are still valuable — they are utilization, and
   a truck with many of them is idle, which is its own bleeding point — so they
   are counted separately rather than dropped.

2. OO and LO drivers' gross is NOT company revenue. An owner-operator keeps
   most of the linehaul; the company earns a percentage or a flat fee. Roughly
   a third of drivers are OO/LO, so counting their gross as company revenue
   overstates the top line badly. Gross is stored with pay_type attached and
   the split is applied downstream, deliberately — the split rates are a
   business rule, not something to guess here.

3. A driver's truck changes. `sub_truck_periods` records when a driver ran a
   substitute unit. Attributing revenue through `drivers.truck` alone puts that
   revenue on the truck that was in the shop, and takes it off the one that
   actually earned it — inverting exactly the per-unit comparison this pipeline
   exists to make.

4. Entity comes from `drivers.mc`, not from the truck.

Usage:
    python ingest/ingest_dispatch.py --csv-dir /path/to/exports
    python ingest/ingest_dispatch.py --dsn "$DISPATCH_DSN"        # on the Mac Mini
"""
import argparse
import sqlite3
import sys
from datetime import datetime, date
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parent.parent))

DB_PATH = Path(__file__).resolve().parent.parent / "db" / "fleet_financials.db"

# drivers.mc -> our entity_id.
# "ZONE OH LLC" is the same legal entity as Zone LLC, confirmed by the owner —
# it is a naming variant, not a separate company, so it maps to ZONE. The two
# statement sets (Zone_statements, ZONE_OH_statements) are two ACCOUNTS of one
# entity; keep them distinct as account_ids, never as entities.
MC_TO_ENTITY = {
    "xtrack llc": "XTRACK",
    "zone oh llc": "ZONE",
    "zone llc": "ZONE",
    "zone": "ZONE",
    "afg": "AFG",
    "afg transportco": "AFG",
    "afg transportco llc": "AFG",
}

REVENUE_ENTRY_TYPE = "loadday"
TABLES = ["load_entries", "weeks", "drivers", "sub_truck_periods",
          "dispatcher_history", "hidden_week_periods"]


def load_frames(args):
    import pandas as pd
    if args.csv_dir:
        d = Path(args.csv_dir)
        out = {}
        for t in TABLES:
            hits = list(d.rglob(f"{t}.csv"))
            if hits:
                out[t] = pd.read_csv(hits[0], dtype=str, keep_default_na=False)
        missing = [t for t in ("load_entries", "weeks", "drivers") if t not in out]
        if missing:
            raise SystemExit(f"missing required export(s): {', '.join(missing)}")
        return out
    if not args.dsn:
        raise SystemExit("give --csv-dir or --dsn")
    import psycopg2
    conn = psycopg2.connect(args.dsn)
    out = {}
    for t in TABLES:
        try:
            out[t] = pd.read_sql(f"select * from {t}", conn).astype(str)
        except Exception as e:
            # pnl_reader may only be granted the three core tables
            print(f"  note: could not read {t} ({str(e).splitlines()[0][:60]})")
    conn.close()
    return out


def _d(s):
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s.split("T")[0], fmt).date()
        except ValueError:
            continue
    return None


def build_sub_truck_index(sub_df):
    """driver_id -> [(start, end, sub_truck, original_truck)]. An open end_date
    means the substitution is still in effect."""
    idx = {}
    if sub_df is None:
        return idx
    for _, r in sub_df.iterrows():
        idx.setdefault(str(r["driver_id"]), []).append(
            (_d(r.get("start_date")), _d(r.get("end_date")),
             str(r.get("sub_truck", "")).strip(), str(r.get("original_truck", "")).strip()))
    return idx


def resolve_truck(driver_id, usual_truck, week_start, sub_index):
    """Which unit actually earned this week's revenue."""
    for start, end, sub, orig in sub_index.get(str(driver_id), []):
        if not sub or not start:
            continue
        if week_start >= start and (end is None or week_start <= end):
            return sub, True
    return usual_truck, False


def run(args):
    import pandas as pd
    f = load_frames(args)
    le, wk, dr = f["load_entries"], f["weeks"], f["drivers"]
    sub_index = build_sub_truck_index(f.get("sub_truck_periods"))

    weeks = {str(r["id"]): (_d(r["monday"]), str(r.get("month", "")).strip())
             for _, r in wk.iterrows()}
    drivers = {str(r["id"]): {
        "name": str(r.get("name", "")).strip(),
        "truck": str(r.get("truck", "")).strip(),
        "pay_type": str(r.get("pay_type", "")).strip(),
        "entity": MC_TO_ENTITY.get(str(r.get("mc", "")).strip().lower()),
        "mc": str(r.get("mc", "")).strip(),
    } for _, r in dr.iterrows()}

    le["_gross"] = pd.to_numeric(le["pickup_gross"], errors="coerce").fillna(0.0)
    le["_miles"] = pd.to_numeric(le["pickup_miles"], errors="coerce").fillna(0.0)

    agg, unknown_mc, orphan_driver, no_week = {}, set(), set(), 0
    # Utilization is counted per UNIT-DAY. Two drivers on one truck in a week is
    # normal (handoff, mid-week swap) and summing their day counts reports more
    # days than the calendar has. day_states maps (unit, week, day) -> best type.
    day_states, unit_drivers = {}, {}
    for _, r in le.iterrows():
        wid, did = str(r["week_id"]), str(r["driver_id"])
        if wid not in weeks:
            no_week += 1
            continue
        week_start, month = weeks[wid]
        d = drivers.get(did)
        if not d:
            orphan_driver.add(did)
            continue
        if d["entity"] is None and d["mc"]:
            unknown_mc.add(d["mc"])
        truck, is_sub = resolve_truck(did, d["truck"], week_start, sub_index)
        if not truck:
            continue
        k = (truck, week_start, did)
        a = agg.setdefault(k, {"entity": d["entity"], "month": month, "name": d["name"],
                               "pay_type": d["pay_type"], "gross": 0.0, "miles": 0.0,
                               "load": 0, "nonrev": 0, "transit": 0, "sub": is_sub})
        et = str(r["entry_type"]).strip().lower()
        di = str(r.get("day_index", "")).strip()
        if di and et in ("loadday", "nonrevenue", "transit"):
            dk = (truck, week_start, di)
            # A day that carried any load outranks a non-revenue mark on the
            # same day from another driver.
            rank = {"loadday": 3, "transit": 2, "nonrevenue": 1}
            if rank[et] > rank.get(day_states.get(dk, ""), 0):
                day_states[dk] = et
            unit_drivers.setdefault((truck, week_start), set()).add(did)
        if et == REVENUE_ENTRY_TYPE:
            a["gross"] += float(r["_gross"]); a["miles"] += float(r["_miles"]); a["load"] += 1
        elif et == "nonrevenue":
            a["nonrev"] += 1
        elif et == "transit":
            a["transit"] += 1

    # collapse day_states to unit-week utilization
    util = {}
    for (truck, ws, _), et in day_states.items():
        u = util.setdefault((truck, ws), {"load": 0, "nonrev": 0, "transit": 0})
        u["load" if et == "loadday" else ("transit" if et == "transit" else "nonrev")] += 1

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA foreign_keys = ON")
    rows = [(("dispatch"), t, v["entity"], ws.isoformat(), v["month"], did, v["name"],
             v["pay_type"], round(v["gross"], 2), round(v["miles"], 1), v["load"],
             v["nonrev"], v["transit"], 1 if v["sub"] else 0,
             datetime.now().isoformat(timespec="seconds"))
            for (t, ws, did), v in agg.items()]
    conn.executemany("""
        INSERT INTO unit_revenue (source, unit_number, entity_id, week_start, month,
            driver_id, driver_name, pay_type, gross, miles, load_days,
            nonrevenue_days, transit_days, is_sub_truck, loaded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (source, unit_number, week_start, driver_id) DO UPDATE SET
            gross=excluded.gross, miles=excluded.miles, load_days=excluded.load_days,
            nonrevenue_days=excluded.nonrevenue_days, transit_days=excluded.transit_days,
            is_sub_truck=excluded.is_sub_truck, entity_id=excluded.entity_id,
            loaded_at=excluded.loaded_at
    """, rows)
    ent_of = {}
    mon_of = {}
    for (t, ws, did), v in agg.items():
        ent_of.setdefault((t, ws), v["entity"]); mon_of.setdefault((t, ws), v["month"])
    urows = [("dispatch", t, ent_of.get((t, ws)), ws.isoformat(), mon_of.get((t, ws)),
              u["load"], u["nonrev"], u["transit"], u["load"] + u["nonrev"] + u["transit"],
              len(unit_drivers.get((t, ws), ())), datetime.now().isoformat(timespec="seconds"))
             for (t, ws), u in util.items()]
    conn.executemany("""
        INSERT INTO unit_utilization (source, unit_number, entity_id, week_start, month,
            load_days, nonrevenue_days, transit_days, covered_days, driver_count, loaded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (source, unit_number, week_start) DO UPDATE SET
            load_days=excluded.load_days, nonrevenue_days=excluded.nonrevenue_days,
            transit_days=excluded.transit_days, covered_days=excluded.covered_days,
            driver_count=excluded.driver_count, loaded_at=excluded.loaded_at
    """, urows)
    conn.commit()

    # ---- report -----------------------------------------------------------
    tot_gross = sum(v["gross"] for v in agg.values())
    oo_lo = {k: v for k, v in agg.items() if v["pay_type"] in ("OO", "LO")}
    oo_gross = sum(v["gross"] for v in oo_lo.values())
    subs = sum(1 for v in agg.values() if v["sub"])

    print(f"\nLoaded {len(rows)} unit-week rows from {len(le)} dispatch entries.")
    print(f"  weeks {min(w for w,_ in weeks.values())} .. {max(w for w,_ in weeks.values())}"
          f"  ({len(weeks)} weeks)")
    print(f"  units with revenue: {len({t for t,_,_ in agg})}")
    multi = sum(1 for v in unit_drivers.values() if len(v) > 1)
    print(f"  unit-weeks: {len(urows)} ({multi} had more than one driver — utilization is")
    print(f"     counted per unit-DAY so those days are not double counted)")
    print(f"  gross on loaddays:  ${tot_gross:,.2f}")
    print()
    print(f"  OWNER/LEASE OPERATOR EXPOSURE: ${oo_gross:,.2f} "
          f"({100*oo_gross/tot_gross:.1f}% of gross) across {len(oo_lo)} unit-weeks.")
    print(f"     This is NOT company revenue — the operator keeps most of it. Apply your")
    print(f"     OO/LO split before using gross as a revenue figure.")
    if subs:
        print(f"  {subs} unit-weeks were reattributed to a SUBSTITUTE truck; without that,")
        print(f"     the revenue would have landed on the unit that was out of service.")
    if unknown_mc:
        print(f"  UNMAPPED mc values (no entity): {', '.join(sorted(unknown_mc))}")
    if orphan_driver:
        print(f"  {len(orphan_driver)} load entries reference a driver_id not in drivers.csv")
    if no_week:
        print(f"  {no_week} entries reference a week_id not in weeks.csv")
    conn.close()


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=str(DB_PATH))
    p.add_argument("--csv-dir")
    p.add_argument("--dsn")
    run(p.parse_args())


if __name__ == "__main__":
    main()
