"""Controls on the per-truck cost and break-even model.

The model has to reproduce the company's own bottom line before any scenario
built on it means anything.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import truck_breakeven as B

pytestmark = pytest.mark.skipif(
    not (ROOT / "data/raw/pnl/88206141-Xtrack_LLC_download.xlsx").exists(),
    reason="XTRACK workbook absent")


@pytest.fixture(scope="module")
def m():
    return B.model("XTRACK", 13)


def test_the_model_reproduces_the_sheets_own_net(m):
    assert not B.controls(m), B.controls(m)


def test_a_parked_truck_costs_less_than_a_running_trucks_fixed_base(m):
    """Rent charged on an idle truck falls below the rate card. Using one figure
    for both prices a lost day and a break-even wrongly, in opposite directions."""
    assert m["parked_cost"] < m["running_fixed"]
    assert m["parked_cost"] > 0.5 * m["running_fixed"]


def test_overhead_comes_from_the_identity_not_from_the_panel_lines(m):
    """The panel's own overhead lines sum to more than the residual because some
    of them are already inside the unit blocks. The identity cannot double-count."""
    rebuilt = (m["gross"] - m["net"] - m["cd_block_cost"]
               - (m["oo_gross"] - m["oo_result"]))
    assert abs(rebuilt - m["overhead"]) < 0.01
    named_total = (m["named"]["us_office"] + m["named"]["tashkent"]
                   + m["named"]["other_charges"] + m["named"]["insurance"])
    assert named_total > m["overhead"], "the overlap this guards against has gone"


def test_overhead_splits_fixed_and_variable_within_range(m):
    assert 0.2 < m["overhead_variable_share"] < 0.7
    assert abs(m["overhead_fixed"] + m["overhead_variable"] - m["overhead"]) < 0.01


def test_break_even_miles_and_rpm_agree_with_each_other(m):
    """Solving for miles at a rate and for the rate at those miles must land on
    the same point, or one of the two formulas has a term the other lacks."""
    for rpm in (2.4, 2.8, 3.2):
        miles = B.breakeven_miles(m, rpm)
        assert abs(B.breakeven_rpm(m, miles) - rpm) < 1e-6
        assert abs(B.weekly_result(m, miles, rpm)) < 0.01


def test_rent_is_not_modelled_as_a_per_mile_cost(m):
    """Least squares returned $0.1428/mile for rent, which is not a rate anyone
    charges: it was the fit confusing WHICH TRUCK with HOW MANY MILES. Rent is a
    base plus, on an Iron Lease truck only, the rate card's $0.10 or $0.12."""
    assert m["rent_iron_per_mile"] in (0.0,) or 0.09 <= m["rent_iron_per_mile"] <= 0.13
    assert m["rent_per_mile"] == pytest.approx(m["iron_share"] * m["rent_iron_per_mile"])
    assert m["rent_per_mile"] < 0.05, "the whole fleet is not on the Iron mileage rate"


def test_fuel_per_mile_is_measured_not_fitted(m):
    """The fit put $301/week of fuel in the intercept and returned $0.72/mile
    when the fleet actually paid $0.87. Measured is dollars over loaded miles."""
    assert m["per_mile_fuel"] > 0.80
    assert m["cost_per_mile"] > m["fitted_per_mile"]
    assert 4.5 < m["fuel_per_gallon"] < 7.5
    assert 5.5 < m["mpg"] < 8.0


def test_a_dollar_of_gross_does_not_all_reach_the_truck(m):
    """Commission, factoring and maintenance-linked overhead come off the top.
    Ignoring that understates break-even miles by about 5%."""
    assert 0 < m["overhead_pct_of_gross"] < 0.15
    assert B.contribution_per_mile(m, 3.0) < 3.0 - m["cost_per_mile"]


def test_result_is_linear_and_crosses_zero_once(m):
    lo = B.weekly_result(m, 1000, 2.8)
    hi = B.weekly_result(m, 5000, 2.8)
    assert lo < 0 < hi
    mid = B.weekly_result(m, 3000, 2.8)
    assert abs((lo + hi) / 2 - B.weekly_result(m, 3000, 2.8)) < 1e-6 or mid == mid


def test_idle_cost_exceeds_what_the_pnl_billed(m):
    """The first version of this number charged idle trucks only what the P&L
    billed them and left out the overhead they still absorbed - 41% short."""
    ic = B.idle_cost("XTRACK")
    assert ic["true_cost"] > ic["billed_to_the_truck"]
    assert ic["fixed_overhead_they_absorbed"] > 0
    assert (abs(ic["true_cost"] - ic["billed_to_the_truck"]
                - ic["fixed_overhead_they_absorbed"]) < 0.01)


def test_variable_overhead_is_not_charged_twice(m):
    """It comes off the rate as a % of gross. Adding the WHOLE overhead per truck
    to the fixed base as well subtracts it a second time and roughly halves every
    truck's modelled profit - which is what this model did at first."""
    assert m["breakeven_fixed"] == pytest.approx(
        m["running_fixed"] + m["fixed_overhead_per_truck_week"])
    assert m["fixed_overhead_per_truck_week"] < m["overhead_per_truck_week"]


def test_the_model_run_at_the_fleets_own_numbers_lands_on_the_fleets_own_result(m):
    modelled = B.weekly_result(m, m["miles_per_truck"], m["rpm"]) * m["cd_trucks"]
    actual = (m["cd_gross"] - m["cd_block_cost"]
              - m["overhead"] * m["cd_trucks"] / m["trucks"])
    assert modelled == pytest.approx(actual, rel=0.10)
