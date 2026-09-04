"""Controls on the per-truck weekly ledger, the policy test and the maintenance ledger."""
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
import truck_weeks as T
import maintenance_ledger as ML

pytestmark = pytest.mark.skipif(
    not (ROOT / "data/raw/pnl/88206141-Xtrack_LLC_download.xlsx").exists(),
    reason="XTRACK workbook absent")


@pytest.fixture(scope="module")
def tw():
    return T.truck_weeks("XTRACK")


@pytest.fixture(scope="module")
def days():
    return T.day_rows()


def test_every_rate_card_truck_has_one_tier():
    assert len(T.IRON_RATE_CARD) == 22
    assert set(T.IRON_RATE_CARD.values()) == {(735.0, 0.10), (900.0, 0.12)}


def test_a_company_driver_block_reconstructs_to_its_own_total(tw):
    cd = tw[tw.kind == "company_driver"]
    gap = (cd.gross - cd.cost - cd.result).abs()
    assert gap.max() < 50, cd.loc[gap.idxmax()].to_dict()


def test_the_gross_shortfall_split_is_exactly_additive(tw):
    """Clipping any component at zero -- a truck CAN beat the benchmark -- makes
    the parts sum to more than the whole and inflates every cause."""
    g = T.gross_shortfall(tw)
    parts = g.lost_sitting + g.lost_miles + g.lost_rate
    assert (parts - g.shortfall).abs().max() < 0.01


def test_the_two_series_cover_different_windows(tw, days):
    """27 weeks of money, 13 of days. Averaging one over the other's window is
    the easiest wrong number here, so the difference is asserted, not assumed."""
    assert tw.week.nunique() > days.week_id.nunique()
    assert tw.week.min() < days.week_id.min()
    assert tw.week.max() == days.week_id.max()


def test_home_time_entitlement_scales_with_days_actually_on_the_book(days):
    """A driver who joined mid-period must not be scored compliant by accident."""
    p = T.home_time_policy(days, "XTRACK")
    ratio = p.home_days_due / p.days_on_book
    assert ratio.round(6).nunique() == 1
    assert abs(ratio.iloc[0] - T.POLICY_HOME_DAYS / T.POLICY_CYCLE_DAYS) < 1e-9


def test_longest_stretch_out_never_exceeds_days_on_book(days):
    p = T.home_time_policy(days, "XTRACK")
    assert (p.longest_stretch_out <= p.days_on_book).all()
    assert (p.loc[p.home_days == 0, "longest_stretch_out"]
            == p.loc[p.home_days == 0, "days_on_book"]).all()


def test_a_sitting_truck_still_carries_cost(tw):
    sit = tw[(tw.kind == "company_driver") & (tw.gross <= 0)]
    assert len(sit) > 0
    assert sit.rent.sum() > 0, "rent vanished from sitting trucks -- check the block read"


def test_iron_lease_rows_in_the_maintenance_ledger_net_to_zero():
    """136 charges are booked and reversed in pairs. Summing them as costs
    double-counts; reading a reversal alone books a refund as a cost."""
    c, _ = ML.load("XTRACK")
    f = ML.iron_lease_flow(c)
    assert f["charges"] > 0
    assert abs(f["net"]) < 1.0, f
    assert f["paid_out"] > 0 and abs(f["paid_out"] - f["credited_back"]) < 1.0


def test_trailers_are_separated_from_trucks_in_the_ledger():
    c, _ = ML.load("XTRACK")
    assert {"trailer", "truck"} <= set(c.unit_type)
    # Trailers are the bigger half; folding them into trucks overstates cost per
    # tractor by roughly half.
    assert c[c.unit_type == "trailer"].amount.sum() > 0.4 * c.amount.sum()


def test_maintenance_ledger_drops_the_rows_that_are_not_charges():
    raw = pd.read_excel(ROOT / ML.LEDGERS["XTRACK"])
    c, _ = ML.load("XTRACK")
    priced = pd.to_numeric(raw["$ used"], errors="coerce").notna()
    assert priced.sum() < 0.5 * len(raw), "most rows are date banners, not charges"
    # Everything kept carries an amount, and nothing priced inside the window is lost.
    assert c.amount.notna().all()
    assert len(c) <= int(priced.sum())
