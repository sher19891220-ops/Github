"""Controls on the per-company cost structure.

The failures worth guarding: double-counting a cost that is already inside the
sheet, and letting a filing that is MISSING read as a cost of zero.
"""
import sys
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import cost_structure as C      # noqa: E402
import truck_breakeven as B     # noqa: E402

pytestmark = pytest.mark.skipif(
    not (ROOT / "data/raw/pnl/88206141-Xtrack_LLC_download.xlsx").exists(),
    reason="P&L workbooks absent")


@pytest.fixture(scope="module")
def ss():
    return {c: C.structure(c, 13) for c in C.COMPANIES}


def test_every_company_passes_its_controls(ss):
    for c, s in ss.items():
        assert not C.controls(s), (c, C.controls(s))


def test_the_sheet_lines_sum_to_the_sheets_own_totals(ss):
    """If the fixed lines drift from the model's break-even base, or the
    per-mile lines from its cost per mile, something is counted twice."""
    for c, s in ss.items():
        m = s["m"]
        assert s["fixed_total"] == pytest.approx(
            m["running_fixed"] + m["fixed_overhead_per_truck_week"], abs=1), c
        assert s["variable_total"] == pytest.approx(m["cost_per_mile"], abs=1e-6), c


def test_outside_costs_are_added_on_top_never_inside(ss):
    """Registration, fuel tax and Oregon have no column in the P&L and cannot be
    inside overhead -- overhead is a residual of the sheet's own gross and net,
    so a cost the sheet never recorded is not in it."""
    for c, s in ss.items():
        assert s["outside_fixed_total"] > 0, c
        assert s["outside_variable_total"] > 0, c
        assert (s["fixed_total"] + s["outside_fixed_total"]) > s["fixed_total"], c


def test_a_missing_filing_reads_as_missing_not_as_zero(ss):
    """AFG has no Oregon account. If that became $0.00 it would look like the
    cheapest company to run rather than the least documented."""
    assert ss["AFG"]["oregon"] is None
    assert ss["AFG"]["outside_variable"]["Oregon weight-mile tax"] is None
    assert ss["ZONE"]["outside_variable"]["Oregon weight-mile tax"] > 0


def test_true_break_even_is_always_above_the_sheets_own(ss):
    """Adding a cost can only raise the miles needed to cover it."""
    for c, s in ss.items():
        rpm = s["m"]["rpm"]
        assert C.true_breakeven(s, rpm) > B.breakeven_miles(s["m"], rpm), c


def test_fuel_tax_is_priced_per_mile_not_per_truck(ss):
    """It is a tax on distance. Per-truck would charge a parked truck for it."""
    for c, s in ss.items():
        f = s["fuel"]
        assert f and f["per_mile"] == pytest.approx(f["tax"] / f["miles"])
        assert 0.0001 < f["per_mile"] < 0.05, c


def test_the_registration_rate_states_its_own_coverage(ss):
    """The file names 48 trucks against a group fleet of 93, so its per-truck
    figure is the cost of a truck it COVERS and the coverage must be visible."""
    for c, s in ss.items():
        assert s["reg"]["trucks"] > 0
        assert s["reg"]["per_truck_week"] == pytest.approx(
            s["reg"]["annual"] / s["reg"]["trucks"] / C.WEEKS_PER_YEAR)
