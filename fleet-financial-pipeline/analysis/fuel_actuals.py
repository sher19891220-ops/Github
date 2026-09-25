"""Real per-truck fuel cost for a given week, from the live Relay Payments
API -- an alternative to the P&L sheet's own hand-entered fuel column,
for the same reason admin/insurance/rent were already pulled off the sheet
(see build_weekly_pnl_rollup.py's _per_truck_cost_rates docstring): the
sheet figure is typed in by hand, and a real transaction feed is the actual
money.

WHAT THIS DOES NOT YET COVER. Relay is one of at least two fuel-card rails
this fleet uses -- EFS/WEX is the other (ingest/ingest_efs_fuel.py). The most
recent EFS export in this corpus stops 2026-04, so for any current week this
module can only see the Relay portion. A truck that fuels on a WEX card
during the week it's asked about would show LESS Relay fuel than it actually
spent, or none at all. So a unit with NO matching Relay transactions is left
on the sheet's own fuel figure rather than zeroed -- silence from Relay is
"not seen on this rail," never "spent nothing." `fuel_source` on every row
says which happened. A fresh EFS export would close this gap the same way
this module already closes the Relay one; nothing here special-cases Relay
over EFS, it is just the only one with a live pull today.

UNIT -> COMPANY IS NEVER RELAY'S OWN linked_org. Confirmed 2026-09-25: every
transaction in a real multi-company week comes back tagged linked_org
"ZONE-OH LLC" regardless of whether the truck is ZONE's, XTRACK's, or AFG's
-- same pattern CLAUDE.md already documented for Samsara ("a vendor billed to
ZONE-OH does not mean ZONE's fleet alone"). Attribution has to come from this
project's own fleet registry (ingest/fleet_registry.py), matched on the
truck/unit number Relay's own `prompts` array reports (see
pull_relay_fuel.parse_transaction).

FUEL ONLY -- not tolls, not scale fees, not other Relay-carried charges.
Only rows parse_transaction() marks type=="Fuel" (diesel + DEF line items)
are summed here; a non-fuel Relay charge (a CAT Scale weigh, an EFS-carried
lumper fee) is a different P&L line and does not belong in a fuel figure.
"""
import datetime
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
sys.path.insert(0, str(ROOT / "analysis"))

import pull_relay_fuel as RF  # noqa: E402


def week_bounds(week_start):
    """A P&L week tab's Monday-anchored start date -> the [dtstart, dtend)
    RFC3339 pair Relay's endpoint requires, covering all 7 calendar days."""
    d = datetime.datetime.strptime(week_start, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
    return d, d + datetime.timedelta(days=7)


def relay_fuel_by_unit(dtstart, dtend):
    """{unit: {"fuel_cost": $, "gallons": g, "fee": $, "rows": n}} for every
    unit with at least one real Relay FUEL transaction in [dtstart, dtend).
    A unit absent from this dict was not seen on the Relay rail that week --
    it may still have fueled elsewhere (see module docstring)."""
    rows = RF.pull_transactions(dtstart, dtend)
    out = {}
    for r in rows:
        if r["type"] != "Fuel":
            continue
        u = str(r["truck"]).strip() if r["truck"] else None
        if not u:
            continue
        d = out.setdefault(u, {"fuel_cost": 0.0, "gallons": 0.0, "fee": 0.0, "rows": 0})
        d["fuel_cost"] += abs(r["amount"] or 0.0)
        d["gallons"] += r["gallons"] or 0.0
        d["fee"] += r["fee"] or 0.0
        d["rows"] += 1
    for d in out.values():
        d["fuel_cost"] = round(d["fuel_cost"], 2)
        d["gallons"] = round(d["gallons"], 2)
        d["fee"] = round(d["fee"], 2)
    return out


def augment_truck_rows_with_relay_fuel(rows, week_start):
    """rows: a list of per-truck dicts for ONE week (each carrying at least
    `unit`, `gross`, `driver_pay`, `admin`, `fuel`, `rent`, `trailer_rent`,
    `toll`, `additional`, `other`, `miles`) -- returns a NEW list, same
    shape, with `fuel`/`gallons`/`mpg`/`result` replaced by the real Relay
    figure for any unit Relay actually saw that week, and `fuel_source`
    added to every row ("relay" or "sheet"). Never mutates the input."""
    dtstart, dtend = week_bounds(week_start)
    relay = relay_fuel_by_unit(dtstart, dtend)
    out = []
    for r in rows:
        row = dict(r)
        u = str(row.get("unit", "")).strip()
        hit = relay.get(u)
        if hit:
            row["fuel"] = hit["fuel_cost"]
            row["gallons"] = hit["gallons"]
            row["mpg"] = round(row["miles"] / hit["gallons"], 2) if hit["gallons"] else None
            row["fuel_source"] = "relay"
            row["fuel_relay_rows"] = hit["rows"]
        else:
            row["fuel_source"] = "sheet"
        row["result"] = round(
            row["gross"] - row["driver_pay"] - row["admin"] - row["fuel"] - row["rent"]
            - row["trailer_rent"] - row["toll"] + row["additional"] + row["other"], 2)
        out.append(row)
    return out
