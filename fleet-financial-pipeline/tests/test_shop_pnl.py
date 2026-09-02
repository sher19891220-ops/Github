"""Tests for the shop entity's economics."""
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "analysis"))
from shop_pnl import shop_economics, breakeven_at


def test_parts_are_the_gap_between_work_handled_and_own_cost():
    e = shop_economics(cost_per_week=1000, events_total=30000,
                       event_weeks=10, fleet_miles=100000)
    assert e["events_per_week"] == 3000
    assert e["parts_implied_per_week"] == 2000


def test_per_mile_rates_use_the_same_window():
    e = shop_economics(cost_per_week=100, events_total=20000,
                       event_weeks=10, fleet_miles=200000)
    assert e["events_per_mile"] == pytest.approx(0.10)
    assert e["labour_facility_per_mile"] == pytest.approx(0.005)


def test_shop_cheaper_than_its_own_cost_gives_negative_parts():
    """A shop handling less work than it costs is not hiding parts -- it is idle.
    The sign must survive so the caller can see it rather than clamp it away."""
    e = shop_economics(cost_per_week=5000, events_total=10000,
                       event_weeks=10, fleet_miles=100000)
    assert e["parts_implied_per_week"] == -4000


@pytest.mark.parametrize("weeks,miles", [(0, 100), (-1, 100), (10, 0), (10, -5)])
def test_degenerate_windows_raise(weeks, miles):
    with pytest.raises(ValueError):
        shop_economics(1000, 5000, weeks, miles)


def test_lower_maintenance_rate_lowers_breakeven():
    lo, c_lo = breakeven_at(1133.15, 2.717, 1.602, 0.102)
    hi, c_hi = breakeven_at(1133.15, 2.717, 1.602, 0.220)
    assert c_lo > c_hi
    assert lo < hi
    assert c_hi == pytest.approx(0.895, abs=0.001)   # the rate the model has used


def test_breakeven_matches_hand_arithmetic():
    be, c = breakeven_at(1000.0, 3.0, 1.5, 0.5)
    assert c == pytest.approx(1.0)
    assert be == pytest.approx(1000.0)


def test_no_contribution_raises_rather_than_returning_nonsense():
    with pytest.raises(ValueError, match="no break-even"):
        breakeven_at(1000.0, 2.0, 1.8, 0.3)
