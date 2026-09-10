"""Controls on the combined multi-year, multi-source per-unit spend picture.

The failures worth guarding: a NaN unit crashing the unit sort (pandas 3.x),
a stray future/past date corrupting a yearly bucket, a split expense-side
counted as a full company cost, and a truck's cost-per-mile computed against
the wrong (or a missing) mileage window.
"""
import sys
import warnings
from pathlib import Path

import pandas as pd
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


def test_company_rollup_totals_match_the_ungrouped_truck_total(loaded):
    """Regression for the bug found 2026-09-09: co_map was originally built
    separately for the charges frame and the cpm frame (which carries extra
    zero-charge, real-mileage units from the P&L). Real miles for those
    units fell into UNATTRIBUTED while contributing $0 cost, producing a
    nonsense $0.00/mile instead of an uncomputable one."""
    d, notes = loaded
    d = SP.add_periods(d)
    cpm = SP.truck_cost_per_mile(d)
    total, monthly = SP.company_rollup(d, cpm)
    truck_total = d[(d.unit_type == "truck") & (d.borne_by == "company")].amount.sum()
    assert total.total_spend.sum() == pytest.approx(truck_total, rel=1e-6)


def test_unattributed_company_has_no_fabricated_cost_per_mile(loaded):
    d, notes = loaded
    d = SP.add_periods(d)
    cpm = SP.truck_cost_per_mile(d)
    total, monthly = SP.company_rollup(d, cpm)
    assert "UNATTRIBUTED" in total.index
    assert pd.isna(total.loc["UNATTRIBUTED", "cost_per_mile"])
    assert total.drop("UNATTRIBUTED").cost_per_mile.notna().all()


def test_company_rollup_never_feeds_an_exclusively_trailer_unit_to_truck_company(loaded):
    """No trailer registry or trailer P&L block exists in this corpus, so
    company_rollup() must never call truck_company() on a unit that is
    ONLY ever a trailer -- never touched a truck row anywhere.

    Two things this test deliberately does NOT require, because both are
    real and correct, not bugs:
      - cpm.unit legitimately includes trucks with real P&L weeks but zero
        maintenance charges ever, so they carry no unit_type tag at all in
        the charges-only frame `d` -- excluding them from truck_company
        would be wrong, they are real trucks.
      - truck_company() itself is not guaranteed to return None for every
        trailer NUMBER in isolation -- 19 of 504 trailer numbers spuriously
        resolve (e.g. '8131', '15739', '15852') because those same digits
        are ALSO a real truck's unit number elsewhere in the fleet (43 such
        reused numbers are already documented in breakdown_trend.py); that
        collision is expected, since a bare number carries no equipment
        type, and those units ARE legitimately trucks too.
    What must never happen: a unit that appears in `d` exclusively as a
    trailer, never once as a truck, being handed to truck_company()."""
    d, notes = loaded
    d = SP.add_periods(d)
    cpm = SP.truck_cost_per_mile(d)
    exclusively_trailer = (set(d[d.unit_type == "trailer"].unit)
                           - set(d[d.unit_type == "truck"].unit))
    assert len(exclusively_trailer) > 0
    trucks_frame_units = set(d[(d.unit_type == "truck")
                              & (d.borne_by == "company")].unit)
    fed_to_truck_company = trucks_frame_units | set(cpm.unit)
    assert fed_to_truck_company.isdisjoint(exclusively_trailer)
