"""Controls on the truck-day ledger.

Each of these encodes a way the day export has already been misread.
"""
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import load_days as L

pytestmark = pytest.mark.skipif(not (ROOT / "data/raw/ops/load_entries.csv").exists(),
                                reason="dispatch export absent")


@pytest.fixture(scope="module")
def data():
    return L.load()


def test_one_row_per_driver_week_day(data):
    days, _ = data
    assert not days.groupby(["driver_id", "week_id", "day_index"]).size().gt(1).any()


def test_gross_and_miles_only_on_loaddays(data):
    days, _ = data
    off = days[days.entry_type != "loadday"]
    assert off.pickup_gross.fillna(0).eq(0).all()
    assert off.pickup_miles.fillna(0).eq(0).all()


def test_a_zero_gross_loadday_is_not_counted_as_revenue(data):
    """740 of 4,684 'loadday' rows carry no gross. Trusting the label overstates
    revenue days by a fifth and understates the idle rate by the same."""
    days, _ = data
    bad = days[(days.entry_type == "loadday") & (days.pickup_gross.fillna(0) <= 0)
               & (days.klass == "revenue")]
    assert bad.empty, f"{len(bad)} zero-gross loaddays counted as revenue"
    assert (days[days.klass == "revenue"].pickup_gross > 0).all()


def test_a_zero_gross_loadday_with_an_idle_reason_is_idle(data):
    days, _ = data
    z = days[(days.entry_type == "loadday") & (days.pickup_gross.fillna(0) <= 0)
             & days.nr_reason.notna()]
    assert not z.empty and (z.klass == "idle").all()


def test_unexplained_days_are_never_silently_assigned(data):
    """A zero-gross loadday with no reason goes in its own bucket, not into
    either total, so the disclosure cannot be lost."""
    days, _ = data
    u = days[days.klass == "unexplained"]
    assert not u.empty
    assert u.pickup_gross.fillna(0).eq(0).all()
    assert u.nr_reason.isna().all()
    parts = days.klass.value_counts()
    assert parts.sum() == len(days)


def test_vacation_spans_carry_no_day_rows(data):
    """Hidden periods are DELETED from the export, not marked. If that ever
    changes, the denominator silently starts including holidays."""
    days, _ = data
    hidden = pd.read_csv(ROOT / "data/raw/ops/hidden_week_periods.csv")
    for _, h in hidden[hidden.reason == "Vacation"].iterrows():
        rows = days[(days.driver_id == h.driver_id) & (days.week_id >= h.start_date)
                    & (days.week_id <= h.end_date)]
        assert rows.empty, f"driver {h.driver_id} has rows inside a Vacation span"


def test_the_trailing_partial_week_is_dropped(data):
    """The export's last week held a fifth of a normal week's rows; averaging it
    in halves every rate."""
    days, _ = data
    n = days.groupby("week_id").size()
    assert n.min() > 0.5 * n.max(), n.to_dict()
    assert "2026-08-31" not in set(days.week_id)


def test_stable_cohort_is_present_in_every_week(data):
    days, _ = data
    s = L.stable_cohort(days, "XTRACK")
    per = s.groupby("driver_id").week_id.nunique()
    assert per.nunique() == 1 and per.iloc[0] == days.week_id.nunique()


def test_every_day_row_has_a_company(data):
    days, _ = data
    assert days["co"].notna().all()


def test_utilisation_parts_sum_to_days(data):
    days, _ = data
    u = L.utilisation(days)
    assert (u.revenue + u.transit + u.idle + u.unexpl == u.days).all()
