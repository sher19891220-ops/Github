"""The unit-to-VIN map, and therefore which company runs which insured truck.

This closes the gap every insurance question was blocked on. Policies schedule
units by VIN; the P&Ls, the driver roster, the maintenance ledger and the Iron
Lease register all use fleet numbers, and the two share no visible relationship
-- only 5 of the 68 VINs on the master auto-liability policy contain a fleet
number anywhere in them. The group unit workbook carries both columns, so it is
the join.

WHAT THE UNIT WORKBOOK ACTUALLY IS. Not a fleet list: an ASSIGNMENT HISTORY.
One row per driver who has had the truck, with pick-up and drop-off mileage and
dates. ZONE's sheet has 1,137 rows carrying a VIN and 294 distinct VINs, one
truck appearing up to 15 times. Counting rows counts assignments and multiplies
the fleet fourfold.

WHICH COMPANY OWNS A TRUCK IS NOT IN THIS WORKBOOK EITHER. 35 of the 362
distinct VINs appear on more than one company's sheet, because a truck that
moved between authorities stays in both histories. The weekly P&Ls settle it:
whichever company's P&L last carried that unit is the company running it. That
also dates the answer, which matters -- 249 of the 362 VINs appear in no P&L at
all and are history, not fleet.

VALUES ARE FREE TEXT. The Value column holds numbers, '110K$', '$60,000/OO' and
bare 'OO'. 'OO' marks an owner-operator truck, which carries no company physical
damage. money() reads the lot and flags the OO ones rather than dropping them.
"""
import argparse
import collections
import datetime
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cache  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
sys.path.insert(0, str(ROOT / "analysis"))

WORKBOOK = ROOT / "data/raw/be9f8984-group_units_list_and_driver_list.xlsx"
UNIT_SHEETS = [(" Zone Unit List", "ZONE"), ("Xtrack_Unit ", "XTRACK"),
               ("AFG Unit list ", "AFG")]
VIN_LEN = 17
# A VIN is 17 chars from a restricted alphabet -- I, O and Q are never used. The
# column also carries section headers ('NEW WALMART TRUCKS'), which are the right
# length to slip through a bare length test.
VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")


def money(v):
    """(value, is_owner_operator). '110K$', '$60,000/OO' and bare 'OO' all appear."""
    if isinstance(v, (int, float)):
        return float(v), False
    s = str(v or "").strip()
    if not s or s.lower() == "none":
        return None, False
    oo = "oo" in s.lower()
    m = re.search(r"([\d,]+(?:\.\d+)?)\s*[kK]?", s.replace("$", ""))
    if not m:
        return None, oo
    x = float(m.group(1).replace(",", ""))
    if re.search(r"\d\s*[kK]", s) or 10 < x < 1000:      # '110K$' and '110$K'
        x *= 1000
    return x, oo


def read_units():
    """Every row of every unit sheet, keyed by VIN."""
    import openpyxl
    wb = openpyxl.load_workbook(WORKBOOK, data_only=True)
    out = collections.defaultdict(lambda: {"units": set(), "lists": set(),
                                           "value": None, "owner_operator": False,
                                           "make": None, "model": None, "year": None})
    rows_seen = 0
    for sheet, company in UNIT_SHEETS:
        ws = wb[sheet]
        rows = list(ws.iter_rows(min_row=1, values_only=True))
        hdr = [str(c).strip() if c else "" for c in rows[0]]
        ix = {h: i for i, h in enumerate(hdr)}
        ucol = ix.get("Unit Number", ix.get("Unit", 1))
        vcol = ix.get("Vin Number", 6)
        for r in rows[1:]:
            vin = str(r[vcol] or "").strip().upper()
            if not VIN_RE.match(vin):
                continue
            rows_seen += 1
            u = str(r[ucol] or "").strip()
            u = u[:-2] if u.endswith(".0") else u
            rec = out[vin]
            rec["lists"].add(company)
            if u:
                rec["units"].add(u)
            val, oo = money(r[5] if len(r) > 5 else None)
            if val and not rec["value"]:
                rec["value"] = val
            rec["owner_operator"] = rec["owner_operator"] or oo
            for k, i in (("make", 2), ("model", 3), ("year", 4)):
                if rec[k] is None and len(r) > i:
                    rec[k] = r[i]
    return dict(out), rows_seen


def _pnl_workbook_paths():
    from ingest_weekly_pnl import WORKBOOKS
    return [str(ROOT / p) for p in WORKBOOKS.values()]


@cache.cached("pnl_appearances", _pnl_workbook_paths)
def _pnl_appearances():
    """unit -> [[week, company, block kind], ...] -- EVERY appearance of that
    unit across every company's weekly P&L, not just the most recent one.

    This exists because a single "most recent" answer (last_seen_in_pnl(),
    below) cannot say whether a unit was really running under a given company
    during some OTHER, earlier week -- a later week's appearance under a
    different company overwrites that information entirely. Confirmed a real
    bug from exactly this gap (2026-09-27): 4 units were resolved to AFG via
    their most-recent-ever P&L appearance, then that resolution was used to
    write real tax data for a completely different, earlier week -- one AFG's
    own P&L never actually listed any of those 4 units in. company_for_week()
    below is the fix: an EXACT week match, or nothing, never the nearest one.
    """
    import openpyxl
    from ingest_weekly_pnl import week_key, WORKBOOKS
    from xtrack_diagnosis import read_blocks
    appearances = collections.defaultdict(list)
    for company, path in WORKBOOKS.items():
        wb = openpyxl.load_workbook(ROOT / path, data_only=True)
        for tab in wb.sheetnames:
            wk = week_key(tab)
            if not wk:
                continue
            for b in read_blocks(wb[tab]):
                appearances[b["unit"]].append([wk, company, b["kind"]])
    return dict(appearances)


def last_seen_in_pnl():
    """unit -> (week, company, block kind) of the most recent P&L that carried
    it -- signature and behavior UNCHANGED from before this module tracked
    every appearance, so registry() and every existing caller keep working
    exactly as they did. This is "most recent ever", not "ran under this
    company during week X" -- for the latter, which is what resolving a real
    week's mileage/tax data to a company actually needs, use
    company_for_week() instead. Never use this function's answer as if it
    were true for some OTHER week than the one it names.
    """
    last = {}
    for u, apps in _pnl_appearances().items():
        wk, company, kind = max(apps, key=lambda a: a[0])
        last[u] = (wk, company, kind)
    return last


def company_for_week(unit, target_week):
    """(company, kind) if `unit` appears in EXACTLY `target_week`'s P&L for
    some company -- None if it doesn't, even when the unit has a "most
    recent" appearance elsewhere (last_seen_in_pnl()) that might tempt a
    caller to assume it. Never guesses from the nearest week: an exact match
    or nothing, the same "measurement, not judgement" rule this module
    already applies to VIN-to-unit resolution. `target_week` is the same
    "YYYY-MM-DD" (Monday-anchored) string week_key()/week_start use
    throughout this pipeline.

    THIS IS THE RIGHT CALL for resolving which company a specific week's
    mileage/fuel/tax data belongs to -- last_seen_in_pnl() is not, because it
    only ever knows about each unit's single most recent appearance and says
    nothing about whether that appearance is the same week being processed.
    """
    for wk, company, kind in _pnl_appearances().get(unit, []):
        if wk == target_week:
            return company, kind
    return None


def resolve_unit_for_week(unit, target_week, sub_truck_periods=None):
    """company_for_week(), with the one fallback DispatchHQ's data makes
    possible: a substitute truck.

    A driver whose truck breaks down or goes into the shop keeps running --
    DispatchHQ logs this as a sub_truck_periods row (original_truck ->
    sub_truck, over a date range), but the P&L only ever tracks that driver
    under their ORIGINAL truck number. So real mileage reported under the
    SUBSTITUTE number can never resolve through company_for_week() alone, no
    matter how current the P&L is -- this is a structural gap in what the
    P&L can name, not a staleness gap company_for_week() already exists to
    catch. Confirmed live 2026-09-28: substitute truck 878131 (standing in
    for ZONE unit 484505 since 2026-09-01, reason "Breakdown") already shows
    real ZONE-billed DEF spend in Relay's 2026-09-14 data, and would sit in
    units_unresolved_for_this_exact_week forever without this.

    This checks the substitution log ONLY when the direct P&L lookup fails,
    and then resolves to the ORIGINAL truck's own company_for_week() result
    -- it never invents a company; DispatchHQ only ever supplies the mapping
    from substitute number back to original number, and the P&L still has to
    confirm the original truck for that exact week. Two or more overlapping
    sub_truck_periods rows for the same substitute number is a DispatchHQ
    data ambiguity, not something to guess through -- treated as unresolved.

    `sub_truck_periods`: the real rows from
    pull_dispatchhq.board_fetch_all("sub_truck_periods") (fetch once per
    caller run, not once per unit -- fleet-wide, it is currently 17 rows and
    does not change mid-run). None (the default) means "don't attempt the
    fallback", not "fetch live" -- this function makes no network call
    itself, matching every other function in this module.

    Returns None, or a dict: {"company", "kind", "resolved_via" ("direct" or
    "sub_truck_period"), "original_truck" (only set for the latter)}.
    """
    direct = company_for_week(unit, target_week)
    if direct is not None:
        company, kind = direct
        return {"company": company, "kind": kind, "resolved_via": "direct"}
    if not sub_truck_periods:
        return None

    week_start = datetime.date.fromisoformat(target_week)
    week_end = (week_start + datetime.timedelta(days=6)).isoformat()
    matches = [r for r in sub_truck_periods if r.get("sub_truck") == unit
              and r.get("start_date", "9999") <= week_end
              and (not r.get("end_date") or r["end_date"] >= target_week)]
    if len(matches) != 1:
        return None
    original = matches[0].get("original_truck")
    resolved = company_for_week(original, target_week)
    if resolved is None:
        return None
    company, kind = resolved
    return {"company": company, "kind": kind, "resolved_via": "sub_truck_period",
            "original_truck": original}


@cache.cached("fleet_registry", lambda: [str(WORKBOOK)] + [
    str(p) for p in sorted(Path(ROOT / "data/raw/pnl").glob("*.xlsx"))])
def registry():
    units, rows_seen = read_units()
    last = last_seen_in_pnl()
    out = []
    for vin, rec in units.items():
        hits = sorted(((last[u][0], last[u][1], last[u][2], u)
                       for u in rec["units"] if u in last), reverse=True)
        out.append({"vin": vin, "units": sorted(rec["units"]),
                    "unit": hits[0][3] if hits else (sorted(rec["units"])[0]
                                                     if rec["units"] else None),
                    "on_lists": sorted(rec["lists"]),
                    "company": hits[0][1] if hits else None,
                    "last_week": hits[0][0] if hits else None,
                    "kind": hits[0][2] if hits else None,
                    "value": rec["value"], "owner_operator": rec["owner_operator"],
                    "make": rec["make"], "model": rec["model"], "year": rec["year"]})
    return out, rows_seen


def controls(reg, rows_seen):
    fails = []
    if len(reg) >= rows_seen:
        fails.append(("the workbook is being read as a fleet list, not an "
                      "assignment history", f"{len(reg)} VINs from {rows_seen} rows"))
    multi = [r for r in reg if len(r["on_lists"]) > 1]
    if not multi:
        fails.append(("no VIN appears on two company sheets -- the histories may "
                      "have been split, so company attribution needs rechecking", 0))
    bad = [r["vin"] for r in reg if not VIN_RE.match(r["vin"])]
    if bad:
        fails.append(("values in the VIN column that are not VINs", bad[:5]))
    if any(r["value"] and r["value"] < 1000 for r in reg):
        fails.append(("stated values below $1,000 -- a 'K' suffix was not expanded",
                      [r["unit"] for r in reg if r["value"] and r["value"] < 1000][:5]))
    return fails


def active(reg, since="2026-07-06"):
    return [r for r in reg if r["last_week"] and r["last_week"] >= since]


def insured_value_by_company(reg, since="2026-07-06", exclude=()):
    """The physical-damage allocation basis: stated value of the company-owned
    trucks each company is actually running. Owner-operator units carry their
    own physical damage and are excluded."""
    g = collections.defaultdict(lambda: {"units": 0, "value": 0.0})
    for r in active(reg, since):
        if r["owner_operator"] or not r["value"] or r["company"] in exclude:
            continue
        g[r["company"]]["units"] += 1
        g[r["company"]]["value"] += r["value"]
    total = sum(x["value"] for x in g.values())
    for x in g.values():
        x["share"] = x["value"] / total if total else 0.0
    return dict(g), total


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", default="data/processed/fleet_registry.json")
    ap.add_argument("--since", default="2026-07-06")
    a = ap.parse_args()
    reg, rows_seen = registry()
    print(f"{rows_seen:,} assignment rows -> {len(reg)} distinct VINs")
    for what, v in controls(reg, rows_seen):
        print(f"  CONTROL: {what}: {v}")
    act = active(reg, a.since)
    print(f"  {len(act)} seen in a P&L since {a.since}; "
          f"{sum(1 for r in reg if not r['last_week'])} appear in no P&L at all")
    print(f"  {sum(1 for r in reg if len(r['on_lists']) > 1)} VINs sit on more than "
          f"one company's sheet (trucks that moved authority)")

    print("\n== ACTIVE COMPANY-OWNED FLEET, THE PHYSICAL-DAMAGE BASIS ==")
    g, total = insured_value_by_company(reg, a.since)
    for co, x in sorted(g.items(), key=lambda kv: -kv[1]["value"]):
        print(f"  {str(co):<9}{x['units']:>4} units  ${x['value']:>12,.0f}  {100 * x['share']:>6.1f}%")
    print(f"  {'TOTAL':<9}{sum(x['units'] for x in g.values()):>4} units  ${total:>12,.0f}")

    g2, t2 = insured_value_by_company(reg, a.since, exclude=("AFG",))
    print("\n== EXCLUDING AFG (the group physical-damage policy does not cover it) ==")
    for co, x in sorted(g2.items(), key=lambda kv: -kv[1]["value"]):
        print(f"  {str(co):<9}{x['units']:>4} units  ${x['value']:>12,.0f}  {100 * x['share']:>6.1f}%")
    print(f"  {'TOTAL':<9}{sum(x['units'] for x in g2.values()):>4} units  ${t2:>12,.0f}")

    out = ROOT / a.json
    out.parent.mkdir(parents=True, exist_ok=True)
    json.dump(reg, out.open("w"), indent=1, default=str)
    print(f"\n-> {a.json}")


if __name__ == "__main__":
    main()
