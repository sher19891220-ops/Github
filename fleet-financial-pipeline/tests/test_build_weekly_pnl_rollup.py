"""Tests for analysis/build_weekly_pnl_rollup.py -- weekly P&L and its
month/quarter/year aggregation, built entirely from already-validated
pipeline modules (truck_weeks.py, cost_structure.py).
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import build_weekly_pnl_rollup as R  # noqa: E402

pytestmark = pytest.mark.skipif(
    not (ROOT / "data/raw/pnl/88206141-Xtrack_LLC_download.xlsx").exists(),
    reason="P&L workbooks not in container")


@pytest.fixture(scope="module")
def weekly():
    return R.all_weekly_rows()


def test_every_company_has_weekly_rows(weekly):
    for co in R.COMPANIES:
        assert (weekly.company == co).sum() > 0


def test_only_company_driver_trucks_are_counted(weekly):
    """This module is explicit that OO/LTP/LTWA trucks are excluded --
    a sanity check that trucks_running never exceeds what a company-
    driver-only count should look like (well under the full fleet size)."""
    assert (weekly.trucks_running <= 50).all()


def test_mpg_is_recomputed_from_summed_inputs_not_averaged(weekly):
    """A week's mpg must equal miles/gallons for THAT week (module rounds
    to 2 decimals) -- not some other figure smuggled in from a per-truck
    average."""
    check = weekly.dropna(subset=["mpg"])
    assert len(check) > 0
    for _, r in check.iterrows():
        assert r.mpg == pytest.approx(r.miles / r.gallons, abs=0.005)


def test_ifta_estimate_scales_with_miles_at_a_fixed_rate(weekly):
    """ifta_estimate = miles * ifta_rate_per_mile, exactly -- this module
    doesn't invent its own IFTA math, it applies cost_structure.py's
    already-established per-mile rate."""
    check = weekly.dropna(subset=["ifta_estimate", "ifta_rate_per_mile"])
    assert len(check) > 0
    for _, r in check.iterrows():
        assert r.ifta_estimate == pytest.approx(r.miles * r.ifta_rate_per_mile, abs=0.01)


@pytest.mark.parametrize("granularity", ["month", "quarter", "year"])
def test_rollup_sums_match_the_weekly_rows_it_was_built_from(weekly, granularity):
    """The whole point of a rollup: no week's dollar gets lost or
    double-counted going from weekly to any coarser granularity."""
    r = R.rollup(weekly, granularity)
    assert r.gross.sum() == pytest.approx(weekly.gross.sum(), abs=0.01)
    assert r.miles.sum() == pytest.approx(weekly.miles.sum(), abs=0.01)


def test_quarter_periods_use_the_established_qn_format(weekly):
    r = R.rollup(weekly, "quarter")
    for p in r.period:
        year, q = p.split("-")
        assert year.isdigit() and len(year) == 4
        assert q[0] == "Q" and q[1] in "1234"


def test_year_rollup_has_one_row_per_company(weekly):
    r = R.rollup(weekly, "year")
    assert len(r) == r.company.nunique()


def test_truck_rows_sum_to_the_matching_weekly_row():
    """The drill-down (truck_rows) must reconcile exactly to the summary
    (weekly_rows) it drills into -- no truck silently dropped or
    double-counted going from one grain to the other."""
    co = "ZONE"
    wk = R.weekly_rows(co)
    tk = R.truck_rows(co)
    for _, w in wk.iterrows():
        truck_gross = tk[tk.week == w.week].gross.sum()
        assert truck_gross == pytest.approx(w.gross, abs=0.01)


def test_truck_rows_carry_a_driver_name():
    tk = R.truck_rows("XTRACK")
    assert (tk.driver.str.len() > 0).any()


def test_cost_breakdown_reference_names_every_company():
    bd = R.cost_breakdown_reference_with_rent()
    for co in R.COMPANIES:
        assert co in bd
        for key in ("truck_rent_per_truck_week", "insurance_per_truck_week",
                    "admin_fee_measured_per_truck_week", "trailer_rent_per_truck_week",
                    "admin_insurance_trailer_booked_per_truck_week"):
            assert bd[co][key] is not None


def test_cost_breakdown_pieces_do_not_silently_match_the_booked_figure():
    """This is the whole point of the reference: the sheet's one bundled
    column and the sum of independently-sourced pieces are DIFFERENT
    numbers. A future data refresh that makes them match by coincidence
    is fine; this test guards against the two ever being conflated by an
    implementation bug (e.g. one computed from the other)."""
    bd = R.cost_breakdown_reference_with_rent()
    for co in R.COMPANIES:
        d = bd[co]
        pieces = d["insurance_per_truck_week"] + d["admin_fee_measured_per_truck_week"] + d["trailer_rent_per_truck_week"]
        booked = d["admin_insurance_trailer_booked_per_truck_week"]
        assert pieces != pytest.approx(booked, abs=0.01), (co, pieces, booked)


def test_a_week_spanning_two_months_is_credited_to_one_month_only():
    """_period_key is a pure function of the week-ending date -- confirms
    it never double-assigns a week to two periods."""
    assert R._period_key("2026-01-31", "month") == "2026-01"
    assert R._period_key("2026-02-01", "month") == "2026-02"
    assert R._period_key("2026-03-31", "quarter") == "2026-Q1"
    assert R._period_key("2026-04-01", "quarter") == "2026-Q2"
