"""Controls on the combined multi-year, multi-source per-unit spend picture.

The failures worth guarding: a NaN unit crashing the unit sort (pandas 3.x),
a stray future/past date corrupting a yearly bucket, a split expense-side
counted as a full company cost, and a truck's cost-per-mile computed against
the wrong (or a missing) mileage window.
"""
import sys
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
warnings.filterwarnings("ignore")

import spend_picture as SP   # noqa: E402

pytestmark = pytest.mark.skipif(
    not SP.MASTER.exists(), reason="the master expenses sheet is absent")


@pytest.fixture(scope="module")
def loaded():
    return SP.load_all()


def test_every_row_has_a_real_unit(loaded):
    d, notes = loaded
    assert d.unit.notna().all()
    assert not (d.unit.astype(str) == "nan").any()


def test_dates_are_clipped_to_a_sane_window(loaded):
    d, notes = loaded
    assert d.date.min() >= SP.FLOOR
    assert d.date.max() <= SP.TODAY


def test_split_expense_side_is_not_counted_as_company_cost(loaded):
    d, notes = loaded
    split = d[d.borne_by == "split"]
    assert len(split) > 0
    assert not any("split" in n and "excluded" not in n for n in notes)


def test_unit_type_is_normalized_to_a_small_known_set(loaded):
    d, notes = loaded
    assert set(d.unit_type.unique()) <= {"truck", "trailer", "unknown", "ambiguous"}


def test_stl_bucket_is_reported_not_divided_across_units(loaded):
    d, notes = loaded
    assert not (d.unit == "STL").any()
    assert any("STL" in n for n in notes)


def test_rollup_periods_sum_to_the_same_total_regardless_of_granularity(loaded):
    d, notes = loaded
    d = SP.add_periods(d)
    company = d[d.borne_by == "company"]
    totals = {p: company.groupby(p).amount.sum().sum()
             for p in ("week", "month", "quarter", "year")}
    vals = list(totals.values())
    assert all(v == pytest.approx(vals[0], rel=1e-6) for v in vals), totals


def test_cost_per_mile_has_no_denominator_for_a_truck_with_no_pnl_week(loaded):
    d, notes = loaded
    cpm = SP.truck_cost_per_mile(d)
    unmatched = cpm[cpm.miles_in_pnl_window.isna()]
    assert len(unmatched) > 0
    assert unmatched.cost_per_mile.isna().all()


def test_no_negative_or_implausible_cost_per_mile(loaded):
    d, notes = loaded
    cpm = SP.truck_cost_per_mile(d)
    resolved = cpm[cpm.cost_per_mile.notna()]
    assert (resolved.cost_per_mile >= 0).all()
    assert resolved.cost_per_mile.max() < 10
