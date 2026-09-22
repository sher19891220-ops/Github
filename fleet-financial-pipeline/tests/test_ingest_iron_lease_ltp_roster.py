"""Tests for ingest/ingest_iron_lease_ltp_roster.py -- parsing the operator's
"Iron lease Leased trucks" sheet (pulled via Claude's Google Drive connector,
2026-09-22) into per-driver-week rows, status, and measured weekly paydown.
"""
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
import ingest_iron_lease_ltp_roster as L  # noqa: E402

pytestmark = pytest.mark.skipif(not L.SNAPSHOT_FILE.exists(),
                                 reason="Iron Lease LTP roster snapshot not in container")


@pytest.fixture(scope="module")
def df():
    return L.parse()


def test_parses_every_snapshot_and_every_driver(df):
    assert df.snapshot_date.nunique() == 12
    assert df.driver_name.nunique() == 12


def test_money_parser_handles_the_sheet_s_own_formats():
    assert L._money("$ 75,000.00") == 75000.0
    assert L._money("$ -") == 0.0
    assert L._money("0") == 0.0
    assert L._money(None) is None
    assert L._money("") is None


def test_terminated_status_is_never_read_as_a_cost_input(df):
    aldens = df[df.driver_name == "Norgaisse Aldens"]
    assert (aldens.status == L.TERMINATED).all()
    assert (aldens.charged_amount == 0.0).all()


def test_lo_in_this_sheet_means_lease_to_walkaway_not_lease_to_own(df):
    """Confirmed by the accounting team, 2026-09-22: 'LO- lease to
    walkaway'. Petit Noel Judeler's rows carry this comment for most of
    the snapshot history."""
    judeler = df[df.driver_name == "Petit Noel Judeler"]
    lo_rows = judeler[judeler.comment.str.contains("working as LO", case=False, na=False)]
    assert len(lo_rows) > 0
    assert (lo_rows.status == L.TEMP_LTWA).all()


def test_a_drivers_truck_number_can_change_mid_contract(df):
    """Petit Noel Judeler moved from truck 8091 to 8132 between the
    08.04.26 and 08.11.26 snapshots -- same contract, same driver."""
    judeler = df[df.driver_name == "Petit Noel Judeler"].sort_values("snapshot_date")
    units = judeler.unit.unique()
    assert set(units) == {"8091", "8132"}
    assert judeler.iloc[0].unit == "8091"
    assert judeler.iloc[-1].unit == "8132"


def test_missing_snapshot_row_is_nan_never_assumed_zero(df):
    """Evanuel Derilus has no Charged/Left amount recorded on 08.18.26 --
    pandas stores the parser's None as NaN in a float column, which is
    still "missing," not the stated zero a '$ -' cell would produce."""
    row = df[(df.driver_name.str.strip() == "Evanuel Derilus")
             & (df.snapshot_date == "2026-08-18")]
    assert len(row) == 1
    assert pd.isna(row.iloc[0].charged_amount)


def test_weekly_paydown_excludes_intervals_touching_a_non_active_status(df):
    """Samuel Muhoza spends most of the snapshot history paused (temp CD,
    then temp lease-to-walkaway) -- almost none of his consecutive
    snapshot pairs should count as a real LTP paydown interval."""
    pay = L.weekly_paydown(df)
    muhoza = pay[pay.driver_name == "Samuel Muhoza"]
    assert len(muhoza) <= 1


def test_nelson_reginald_s_measured_rate_matches_the_accounting_teams_contract(df):
    """Accounting team, 2026-09-22: truck 2703's contract is $1,500/week
    regular payment (plus a separate $2,000 catch-up deposit he is behind
    on, which is NOT a weekly rate and must not show up as one here)."""
    pay = L.weekly_paydown(df)
    reginald = pay[pay.driver_name == "Nelson Reginald"]
    assert len(reginald) > 0
    # Most weeks should be exactly $1,500 -- a few can be $0 (skipped weeks),
    # but nothing should look like the $2,000 deposit got folded into a
    # weekly figure.
    common = reginald.per_week.round(-1)  # nearest 10, absorbs day-count rounding
    assert (common.isin([1500.0, 0.0])).all(), reginald[["from", "to", "delta", "per_week"]]


def test_weekly_paydown_skips_a_snapshot_with_no_reported_figure(df):
    """Evanuel Derilus has no charged_amount on 08.18.26 (pandas stores it
    as NaN in the float column, not None) -- a naive `is not None` check
    would let that NaN leak into a delta/per_week figure instead of being
    excluded. Only the one clean interval (08.25.26 -> 09.01.26, both
    reported) should count, and it must be a real number, not NaN."""
    pay = L.weekly_paydown(df)
    derilus = pay[pay.driver_name.str.strip() == "Evanuel Derilus"]
    assert len(derilus) == 1
    assert not derilus.per_week.isna().any()
    assert derilus.iloc[0].per_week == pytest.approx(2000.0)


def test_latest_status_is_one_row_per_driver(df):
    latest = L.latest_status(df)
    assert len(latest) == df.driver_name.nunique()
    assert latest.driver_name.is_unique
