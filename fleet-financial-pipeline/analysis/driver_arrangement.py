"""
Cost and break-even for a truck under a NAMED lease/ownership arrangement --
owner-operator (OO), lease-to-purchase (LTP), or lease-to-walk-away (LTWA)
-- from the rate cards in config/driver_arrangement_rates.json, fed into
analysis/breakeven_engine.py's already-tested CostInputs/break-even math.

WHY THIS DOESN'T TOUCH cost_structure.py/truck_breakeven.py. Those two price
a COMPANY-DRIVER truck, measured from the weekly P&L's own CD columns --
the one arrangement the sheet prices cleanly. docs/ACCOUNTING_MODEL.md
Section 3 names three more arrangements with fundamentally different
economics (the company charges a STATED rate here; it does not measure
one), and config/driver_arrangement_rates.json already carries that stated
rate card for each -- nothing before this module turned it into a cost or
break-even figure.

WHAT THIS DOES NOT DO: say which of the group's actual trucks is on which
arrangement. That needs a real roster -- the operator's own "Iron lease
Leased trucks" Google Sheet (id 1X28pWOL4DDTpml9ZcNyqiukUVLxrSn5qmu0riI-
gAOg) is the named candidate, per config/driver_arrangement_rates.json's
own note -- and this pipeline has not ingested it. Every function here
takes the arrangement as an explicit argument: it prices "a truck on
LTP," not "truck 2703." A truck's arrangement can also change mid-life
(docs/ACCOUNTING_MODEL.md Section 3), so a roster join would need to be
per-week, not a static unit -> arrangement map, once one exists.

THE 'LO' MARKER IN COLUMN A IS NOT AN ARRANGEMENT FLAG -- checked and
ruled out 2026-09-22 (see analysis/xtrack_diagnosis.py's corrected
docstring): it sits at a varying position inside a truck's per-load row
sequence, usually carrying a real dollar figure, not once at a fixed
position the way a per-driver flag would. Do not resurrect it as a
classifier for CD/OO/LTP/LTWA.

STATED RATES, NOT MEASURED ONES. Every number here is what the operator
SAID the arrangement charges (chat, 2026-09-08 and 2026-09-21) -- not yet
reconciled against real settlements. The rate card's own file already
flags one concrete mismatch: the lease-to-purchase sheet shows truck 2703
charged $1,500/week against its $75,000 balance, not the $1,000
'truck_payment' stated here. Treat these as the current policy, not
confirmed billing.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
from breakeven_engine import CostInputs  # noqa: E402

RATES_FILE = ROOT / "config/driver_arrangement_rates.json"
ARRANGEMENTS = ("owner_operator", "lease_to_purchase", "lease_to_walk_away")


def load_rates():
    return json.loads(RATES_FILE.read_text())


def _rate_card(arrangement, rates):
    rates = rates if rates is not None else load_rates()
    if arrangement not in ARRANGEMENTS:
        raise KeyError(f"unknown arrangement {arrangement!r} -- expected one of {ARRANGEMENTS}")
    return rates[arrangement]


def fixed_cost_per_week(arrangement, rates=None):
    """The stated weekly fixed charge for this arrangement -- truck
    rent/payment + insurance + trailer rent + admin fee, whatever that
    arrangement's own rate card itemizes. Owner-operator carries no truck
    charge at all: the driver owns or finances their own equipment."""
    return _rate_card(arrangement, rates)["total_fixed"]


def variable_cost_per_mile(arrangement, rates=None):
    """Only lease-to-walk-away's rate card states a per-mile charge
    ($0.13/mi) in this file. Lease-to-purchase and owner-operator are
    flat-fee only here -- 0.0, not missing. STL's own $1,000 + $0.15/mi
    figure for a lease-to-purchase truck (operator, 2026-09-21) is a
    DIFFERENT, not-yet-reconciled source and is never folded in silently;
    pass it explicitly via the `rates` override if a caller needs it."""
    return _rate_card(arrangement, rates).get("mileage_charge_cpm", 0.0)


def cost_inputs(arrangement, miles_driven, revenue=None, revenue_per_mile=None,
                days_in_period=7, overhead_pct_of_gross=0.0, rates=None):
    """A CostInputs for analysis/breakeven_engine.py, built from the named
    arrangement's stated rate card instead of a measured company-driver
    figure. overhead_pct_of_gross defaults to 0.0 -- the revenue-linked
    company-overhead share (docs/ACCOUNTING_MODEL.md Section 4) was
    measured from company-driver economics only and has not been checked
    against any of these three arrangements; pass it explicitly once it
    has, rather than assuming it carries over."""
    rates = rates if rates is not None else load_rates()
    return CostInputs(
        fixed_costs_total=fixed_cost_per_week(arrangement, rates),
        variable_cost_per_mile=variable_cost_per_mile(arrangement, rates),
        miles_driven=miles_driven,
        days_in_period=days_in_period,
        revenue=revenue,
        revenue_per_mile=revenue_per_mile,
        overhead_pct_of_gross=overhead_pct_of_gross,
    )
