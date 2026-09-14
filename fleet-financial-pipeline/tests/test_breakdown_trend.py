"""Controls on the worst-to-best maintenance/breakdown ranking and trend call.

The failure worth guarding: a unit with even one row mistagged to the OTHER
unit_type (truck 8093 has 66 truck rows plus one stray $237.50 trailer row)
must not have its whole total double-counted into both the truck and
trailer tables.
"""
import sys
import warnings
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
warnings.filterwarnings("ignore")

import spend_picture as SP        # noqa: E402
import breakdown_trend as BT      # noqa: E402

pytestmark = pytest.mark.skipif(
    not SP.MASTER.exists(), reason="the master expenses sheet is absent")


@pytest.fixture(scope="module")
def data():
    d, notes = SP.load_all()
    d = SP.add_periods(d)
    return d


def test_shared_unit_numbers_are_not_double_counted(data):
    """Some unit numbers (e.g. 8093, 8131, 15739) genuinely belong to both a
    truck and a separate trailer in this fleet's numbering -- that overlap
    is real, not a bug. What must never happen is the SAME dollar total
    appearing under both, which is what the original bug did (a stray
    mistagged row pulled a unit's whole total into both tables)."""
    table = BT.build(data)
    trucks = table[table.unit_type == "truck"].set_index("unit").total_spend
    trailers = table[table.unit_type == "trailer"].set_index("unit").total_spend
    shared = set(trucks.index) & set(trailers.index)
    assert len(shared) > 0, "expected some genuinely reused unit numbers"
    identical = [u for u in shared if trucks[u] == pytest.approx(trailers[u], abs=0.01)]
    assert not identical, f"units with an identical (double-counted) total in both tables: {identical}"


def test_a_mistagged_stray_row_does_not_inflate_the_dominant_type(data):
    """Regression for the exact bug found 2026-09-08: unit 8093 has 66 rows
    tagged truck ($33,539.06) and 1 stray row tagged trailer ($237.50) --
    the truck total must exclude the stray row, not include it."""
    series = BT.monthly_series(data, "8093", "truck")
    assert series.sum() == pytest.approx(33539.06, abs=1.0)


def test_a_single_priced_month_is_always_one_time(data):
    table = BT.build(data)
    singles = table[table.months_with_charges == 1]
    assert len(singles) > 0
    assert (singles.trend == "one-time").all()


def test_total_spend_matches_the_sum_of_its_own_monthly_series(data):
    table = BT.build(data)
    sample = table.sample(min(15, len(table)), random_state=0)
    for _, r in sample.iterrows():
        series = BT.monthly_series(data, r.unit, r.unit_type)
        assert series.sum() == pytest.approx(r.total_spend, rel=1e-6)


def test_trend_labels_are_a_known_set(data):
    table = BT.build(data)
    assert set(table.trend.unique()) <= {"one-time", "worsening", "improving", "steady"}


def test_no_trailer_carries_a_cost_per_mile_column(data):
    table = BT.build(data)
    trailers = table[table.unit_type == "trailer"]
    assert "cost_per_mile" not in trailers.columns or trailers.cost_per_mile.isna().all()
