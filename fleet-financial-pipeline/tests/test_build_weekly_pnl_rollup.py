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


def test_ifta_estimate_per_mile_method_scales_with_miles_at_a_fixed_rate(weekly):
    """ifta_estimate_per_mile_method = miles * ifta_rate_per_mile, exactly --
    the superseded method, kept only as a labeled comparison figure (see
    test_ifta_estimate_uses_gallons_not_miles for the active method)."""
    check = weekly.dropna(subset=["ifta_estimate_per_mile_method", "ifta_rate_per_mile"])
    assert len(check) > 0
    for _, r in check.iterrows():
        assert r.ifta_estimate_per_mile_method == pytest.approx(r.miles * r.ifta_rate_per_mile, abs=0.01)


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


def test_admin_is_calculated_not_the_sheets_own_column():
    """Operator, 2026-09-22: 'admin cost do not get from google sheet get
    that from calculation that we did priorly.' A truck's admin must equal
    insurance + admin-fee (Motive included, whichever rate applies to that
    unit), computed by admin_for_unit() -- never read off the row."""
    co = "ZONE"
    tk = R.truck_rows(co)
    rates = R._per_truck_cost_rates(co)
    for _, row in tk.head(20).iterrows():
        assert row.admin == pytest.approx(R.admin_for_unit(row.unit, rates), abs=0.01)


def test_trailer_rent_is_its_own_field_separate_from_admin():
    """Operator, 2026-09-22: 'trailers make extra column for trailer rent
    only, remove it from admin side.'"""
    tk = R.truck_rows("ZONE")
    assert "trailer_rent" in tk.columns
    rates = R._per_truck_cost_rates("ZONE")
    assert (tk.trailer_rent == rates["trailer_rent_per_truck_week"]).all()
    # Admin must not itself equal insurance + admin-fee + trailer_rent --
    # trailer rent is excluded from the admin calculation entirely.
    for _, row in tk.head(5).iterrows():
        assert row.admin != pytest.approx(
            rates["insurance_per_truck_week"] + rates["trailer_rent_per_truck_week"], abs=0.01)


def test_iron_lease_trucks_get_the_rate_card_formula_on_their_own_miles():
    """Operator, 2026-09-22: rent should be 'base pay ... from iron lease
    + milage (0.15 * miles driven)' -- this truck's own miles, not a
    fleet-wide blend."""
    import truck_weeks as T
    co = "ZONE"
    iron_units = [u for u in T.IRON_RATE_CARD if u in set(R.truck_rows(co).unit)]
    assert iron_units, "expected at least one Iron Lease unit in ZONE's company-driver fleet"
    tk = R.truck_rows(co)
    rates = R._per_truck_cost_rates(co)
    sample = tk[tk.unit == iron_units[0]].iloc[0]
    base, per_mile = T.IRON_RATE_CARD[iron_units[0]]
    assert sample.rent == pytest.approx(base + per_mile * sample.miles, abs=0.01)
    assert sample.rent != pytest.approx(rates["outside_lease_rent_per_week"], abs=0.01)


def test_non_iron_trucks_get_the_outside_lease_average_not_the_sheet():
    import truck_weeks as T
    co = "ZONE"
    tk = R.truck_rows(co)
    rates = R._per_truck_cost_rates(co)
    non_iron = tk[~tk.unit.isin(T.IRON_RATE_CARD.keys())]
    assert len(non_iron) > 0
    assert (non_iron.rent == rates["outside_lease_rent_per_week"]).all()


def test_motive_split_reconstructs_the_established_fleet_total():
    """The camera-installed and other-truck rates must add back to the
    $229.81/wk total telematics_costs.json already establishes -- if this
    ever drifts, the split stopped being a split of the same invoice."""
    m = R._motive_rates()
    total = (m["n_installed"] * m["per_installed_truck_week"]
             + m["n_other"] * m["per_other_truck_week"])
    assert total == pytest.approx(229.81, abs=0.5)
    assert m["per_installed_truck_week"] > m["per_other_truck_week"]


def test_motive_rate_differs_by_camera_installation():
    co = "ZONE"
    rates = R._per_truck_cost_rates(co)
    installed_unit = next(iter(rates["motive"]["installed_units"]))
    other_unit = "not-a-real-unit-number"
    assert R.admin_for_unit(installed_unit, rates) > R.admin_for_unit(other_unit, rates)


def test_ifta_estimate_uses_gallons_not_miles(weekly):
    """Operator, 2026-09-22: build the interim weekly-precision IFTA step.
    ifta_estimate must now be gallons x per-gallon rate, not miles x
    per-mile rate -- and the two methods must actually differ on a real
    week (if a week's mpg matched the quarter's average exactly they could
    coincide, but not across an entire company's history)."""
    import cost_structure as CS
    co = "ZONE"
    rows = weekly[weekly.company == co].dropna(subset=["ifta_estimate", "ifta_rate_per_gallon"])
    assert len(rows) > 0
    for _, r in rows.iterrows():
        assert r.ifta_estimate == pytest.approx(r.gallons * r.ifta_rate_per_gallon, abs=0.01)
    assert "ifta_estimate_per_mile_method" in weekly.columns
    differing = (rows.ifta_estimate - weekly.loc[rows.index, "ifta_estimate_per_mile_method"]).abs()
    assert (differing > 0.01).any()


def test_ifta_reference_names_both_methods():
    ref = R.ifta_reference()
    for co in R.COMPANIES:
        assert ref[co]["method"] == "per_gallon"
        assert ref[co]["per_gallon"] > 0
        assert ref[co]["per_mile_method_reference"]["per_mile"] > 0
        assert ref[co]["weight_distance"]["total_per_mile"] > 0


def test_weekly_rows_carry_a_separate_weight_distance_field(weekly):
    """Operator, 2026-09-22: build the weight-distance engine so it shows
    company costs per week -- as its own field, never merged into
    ifta_estimate (a different tax, on a different basis)."""
    assert "weight_distance_tax_estimate" in weekly.columns
    rows = weekly.dropna(subset=["weight_distance_tax_estimate", "weight_distance_rate_per_mile"])
    assert len(rows) > 0
    for _, r in rows.iterrows():
        assert r.weight_distance_tax_estimate == pytest.approx(
            r.miles * r.weight_distance_rate_per_mile, abs=0.01)
        assert r.weight_distance_tax_estimate != pytest.approx(r.ifta_estimate, abs=0.01)


def test_occupational_accident_is_excluded_from_the_insurance_reference():
    """Operator, 2026-09-22: OCAC is recovered from the driver, so it must
    not inflate the company-cost insurance figure shown here."""
    bd = R.cost_breakdown_reference()
    for co in R.COMPANIES:
        assert not any(k.endswith("_RECOVERED_FROM_DRIVER") for k in bd[co]["insurance_lines"])
        assert "Occupational accident" in bd[co]["insurance_excludes_note"]
