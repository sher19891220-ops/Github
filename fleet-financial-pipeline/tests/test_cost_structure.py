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


def test_rent_is_a_weighted_average_of_two_different_rents(ss):
    """Iron Lease units are priced from the RATE CARD, everything else is
    measured in the P&L. One blended 'rent' would be wrong for both."""
    for c, s in ss.items():
        m = s["m"]
        assert m["rent_base_per_week"] == pytest.approx(
            m["iron_share"] * m["rent_iron_base"]
            + (1 - m["iron_share"]) * m["rent_outside_per_week"], abs=0.01), c
        # The Iron tier is genuinely cheaper per week; that is the whole point
        # of the rate card and why the mix matters.
        assert m["rent_iron_base"] < m["rent_outside_per_week"], c


def test_overhead_is_the_residual_and_the_identity_closes(ss):
    """gross - net - CD block cost - OO cost. Every term measured, nothing
    allocated by judgement."""
    for c, s in ss.items():
        m = s["m"]
        assert m["overhead"] == pytest.approx(
            m["gross"] - m["net"] - m["cd_block_cost"]
            - (m["oo_gross"] - m["oo_result"]), abs=1), c


def test_overhead_fixed_and_variable_add_back_to_the_whole(ss):
    """The variable half is charged as a % of gross and the fixed half per
    truck. Counting either in both places is the error this guards."""
    for c, s in ss.items():
        m = s["m"]
        assert m["overhead_fixed"] + m["overhead_variable"] == pytest.approx(
            m["overhead"], abs=1), c
        assert 0 < m["overhead_variable_share"] < 1, c


def test_the_explain_walkthrough_reproduces_every_headline(ss):
    """Whatever --explain prints must be the arithmetic that produced the
    table, not a second derivation that can drift from it."""
    for c, s in ss.items():
        m, r = s["m"], s["reg"]
        assert s["fixed"]["truck rent, base"] == m["rent_base_per_week"]
        assert s["fixed"]["admin / insurance / trailer"] == m["admin_per_truck_week"]
        assert s["fixed"]["fixed company overhead"] == m["fixed_overhead_per_truck_week"]
        assert m["fixed_overhead_per_truck_week"] == pytest.approx(
            m["overhead_fixed"] / m["trucks"], abs=0.01), c
        assert s["outside_fixed"]["IRP plates + HVUT"] == pytest.approx(
            r["annual"] / r["trucks"] / C.WEEKS_PER_YEAR, abs=0.01), c
