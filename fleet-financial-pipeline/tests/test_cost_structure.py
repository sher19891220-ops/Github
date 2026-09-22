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


def test_fuel_tax_per_gallon_is_the_weekly_precision_alternative():
    """The interim weekly IFTA step (operator, 2026-09-22): tax/gallons from
    the same filed returns as fuel_tax_per_mile(), so a week's own real
    gallons -- not an assumed quarterly-average mpg -- drives the estimate."""
    for co in C.COMPANIES:
        g = C.fuel_tax_per_gallon(co)
        m = C.fuel_tax_per_mile(co)
        assert g and m
        assert g["per_gallon"] == pytest.approx(g["tax"] / g["gallons"])
        assert g["quarters"] == m["quarters"]
        # Same filed returns, so tax/gallons implied by return_mpg must
        # reconstruct tax/miles: (tax/gallons) / mpg == tax/miles.
        assert g["per_gallon"] / g["return_mpg"] == pytest.approx(m["per_mile"], rel=0.02)
        assert 0.01 < g["per_gallon"] < 1.0, co


def test_weight_distance_tax_is_a_separate_charge_from_standard_ifta():
    """Operator, 2026-09-22, after uploading a blank IFTA calculator that
    confirmed OR/CT/NM/NY/KY charge a SEPARATE weight-distance tax on top
    of (Oregon: instead of) standard IFTA fuel tax. Every state's line must
    use a real mile count from the filed returns' own jurisdictions dict,
    and the five lines must sum to the reported total."""
    for co in C.COMPANIES:
        wd = C.weight_distance_tax_per_mile(co)
        assert wd
        assert set(wd["lines"]) == {"OR", "CT", "NM", "NY", "KY"}
        assert wd["total_per_mile"] == pytest.approx(sum(v["per_mile"] for v in wd["lines"].values()))
        for state, line in wd["lines"].items():
            assert line["miles"] >= 0
            assert line["per_mile"] >= 0
        assert 0 < wd["total_per_mile"] < 0.05, co


def test_oregons_weight_distance_line_prefers_the_real_filed_return():
    """ZONE has a real filed Oregon return in this corpus -- its OR line
    must come from that (oregon_per_mile), not the schedule-rate estimate
    every other state uses."""
    wd = C.weight_distance_tax_per_mile("ZONE")
    assert wd["lines"]["OR"]["source"] == "real_filed_oregon_return"
    fuel = C.fuel_tax_per_mile("ZONE")
    real_oregon = C.oregon_per_mile("ZONE", fuel)
    assert wd["lines"]["OR"]["per_mile"] == pytest.approx(real_oregon["per_mile"])
    # AFG has no Oregon account on record -- must fall back to the schedule
    # estimate, never to zero.
    wd_afg = C.weight_distance_tax_per_mile("AFG")
    assert wd_afg["lines"]["OR"]["source"] == "schedule_estimate"
    assert wd_afg["lines"]["OR"]["per_mile"] > 0


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


def test_corrected_registration_is_one_rate_for_every_company(ss):
    """registration_corrected_per_truck_week() answers who-actually-bears-it,
    2026-09-10 -- a single group-wide rate (the equal-company-split pool
    spread over the whole running fleet), not a per-company average the way
    the plain registration figure is. All three companies must see the
    identical corrected rate."""
    rates = {c: s["reg_corrected"] for c, s in ss.items()}
    assert len(set(rates.values())) == 1
    assert next(iter(rates.values())) > 0


def test_corrected_fixed_total_is_lower_than_the_uncorrected_one(ss):
    """Every company's own registered-truck average folds in owner-operator
    and investor trucks that no longer belong in a company's own cost --
    the corrected figure, which excludes them, must not exceed the original
    for any company (it can equal it only in the impossible case of an
    identical rate)."""
    for c, s in ss.items():
        assert s["fixed_total_corrected"] <= s["fixed_total"] + s["outside_fixed_total"] + 0.01, c


def test_corrected_breakeven_never_exceeds_the_original(ss):
    for c, s in ss.items():
        rpm = s["m"]["rpm"]
        assert C.true_breakeven_corrected(s, rpm) <= C.true_breakeven(s, rpm) + 0.01, c
