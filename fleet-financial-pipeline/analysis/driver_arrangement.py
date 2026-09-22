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

WHICH TRUCK IS ON WHICH ARRANGEMENT: partially resolved 2026-09-22. The
operator's own "Iron lease Leased trucks" Google Sheet (pulled via
Claude's Google Drive connector, never the forbidden GSHEETS_SERVICE_
ACCOUNT key -- see CLAUDE.md) is a real, weekly-snapshotted roster of
every lease-to-purchase driver, parsed by ingest/
ingest_iron_lease_ltp_roster.py. `known_arrangements()` below gives the
CURRENT lease_to_purchase/lease_to_walk_away status for every truck on
that roster. It does NOT cover plain owner-operator trucks -- those never
appear on this roster at all, and no OO roster exists anywhere in this
pipeline yet. Every pricing function below still takes the arrangement as
an explicit argument rather than looking it up itself, since a truck's
arrangement can change mid-life (Samuel Muhoza's did, twice, after an
accident -- docs/ACCOUNTING_MODEL.md Section 3) and the caller should
decide which snapshot it wants priced, not have one silently assumed.

THE 'LO' MARKER IN THE WEEKLY P&L'S COLUMN A IS NOT AN ARRANGEMENT FLAG --
checked and ruled out 2026-09-22 (see analysis/xtrack_diagnosis.py's
corrected docstring): it sits at a varying position inside a truck's
per-load row sequence, usually carrying a real dollar figure, not once at
a fixed position the way a per-driver flag would.

'LO' MEANS SOMETHING ELSE ENTIRELY IN A DIFFERENT DOCUMENT: on the Iron
Lease "Leased trucks" roster's own Comments column, 'LO' is this
operator's shorthand for LEASE-TO-WALKAWAY -- confirmed directly by the
accounting team, 2026-09-22 ("LO- lease to walkaway"). Same two letters,
two unrelated documents, two unrelated meanings. See ingest/
ingest_iron_lease_ltp_roster.py, which reads that roster and is the
source for `known_arrangements()` below.

STATED RATES, MEASURED ROSTER. The per-arrangement dollar amounts here are
still what the operator SAID each arrangement charges (chat, 2026-09-08
and 2026-09-21) -- not yet reconciled against real settlements in general.
One specific figure IS now reconciled: the lease-to-purchase rate card
says $1,000/week, but truck 2703's real contract (confirmed by the
accounting team, and matching the roster's own weekly deltas) is
$1,500/week regular payment plus a separate $2,000 catch-up deposit he is
behind on. `known_arrangements()` tells you WHICH truck is on which
arrangement; it does not yet correct the $1,000 rate card itself to
$1,500 -- that would need every driver's own contract confirmed the same
way, not just one.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
from breakeven_engine import CostInputs  # noqa: E402

RATES_FILE = ROOT / "config/driver_arrangement_rates.json"
ARRANGEMENTS = ("owner_operator", "lease_to_purchase", "lease_to_walk_away")


def known_arrangements():
    """{unit: arrangement} for every Iron-Lease-financed truck this
    pipeline can currently classify, from the operator's own "Iron lease
    Leased trucks" roster (ingest/ingest_iron_lease_ltp_roster.py) --
    lease-to-purchase and lease-to-walk-away only. Says nothing about
    plain owner-operator trucks, which never appear on that roster at
    all; there is still no roster for those. A truck's arrangement can
    change (Samuel Muhoza's did, twice, after an accident), so this is
    the CURRENT snapshot, not a fact fixed for all time -- re-call it
    rather than caching the result across sessions."""
    sys.path.insert(0, str(ROOT / "ingest"))
    import ingest_iron_lease_ltp_roster as roster  # noqa: E402
    return roster.unit_arrangements()


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
