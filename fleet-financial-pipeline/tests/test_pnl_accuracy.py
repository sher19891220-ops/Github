"""Controls on the P&L accuracy audit.

The audit's own failure modes are what these guard: comparing a sheet to a
return it does not cover, comparing loaded miles to a filing that counts every
mile, counting one return three times because it sits under three paths, and
condemning a return on a residual too small to carry a verdict.
"""
import sys
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import pnl_accuracy as A          # noqa: E402
import parse_tax_and_insurance as X   # noqa: E402

pytestmark = pytest.mark.skipif(
    not (ROOT / "data/raw/pnl/88206141-Xtrack_LLC_download.xlsx").exists(),
    reason="P&L workbooks absent")


@pytest.fixture(scope="module")
def returns():
    return A._returns()


def test_both_ifta_form_layouts_are_read(returns):
    """ZONE files through OH|TAX eServices, which has no Step 2 division line.
    The Step-2 reader returned an empty dict on those and they dropped out
    SILENTLY -- the largest company had no external mileage check at all."""
    forms = {r.get("form", "Step 2") for r in returns}
    assert "OH|TAX eServices" in forms
    assert len(forms) > 1
    names = {(r.get("legal_name") or "").split()[0] for r in returns}
    assert {"ZONE-OH", "XTRACK", "AFG"} <= names


def test_the_same_return_under_three_paths_is_counted_once(returns):
    """ZONE's Ohio returns sit in data/raw/ifta/ohio/ AND inside the CT Reports
    archive. Summing the list without deduping tripled ZONE's miles."""
    keys = [(r.get("legal_name"), str(r.get("period_end")), r.get("total_miles"))
            for r in returns]
    assert len(keys) == len(set(keys))


def test_the_ohio_form_recomputes_its_own_stated_mpg(returns):
    """Total distance and gallons are scraped off one line. Recomputing the mpg
    the form prints is the check that the two numbers are the ones meant."""
    oh = [r for r in returns if r.get("form") == "OH|TAX eServices"]
    assert oh
    for r in oh:
        assert r["computed_mpg"] == pytest.approx(r["stated_mpg"], abs=0.01)


def test_a_quarter_the_sheet_only_partly_covers_is_skipped_not_compared():
    """XTRACK's and ZONE's sheets start 2026-02-23, so they hold 6 of Q1's 13
    weeks. Comparing that to a full-quarter return measures the missing weeks
    and would read as a 55% error."""
    for co in ("ZONE", "XTRACK"):
        q1 = [r for r in A.ifta_check(co) if r["quarter"] == "2026Q1"]
        assert q1, co
        assert "skipped" in q1[0], co
        assert q1[0]["weeks_in_sheet"] < A.MIN_WEEKS_FOR_A_QUARTER


def test_owner_operator_miles_are_scaled_to_all_miles():
    """IFTA counts every mile of every truck. The sheet keeps odometer miles for
    company drivers and LOADED miles for owner-operators, so comparing raw
    loaded miles understates the sheet by the empty ratio -- on XTRACK the
    owner-operators are 43% of the fleet."""
    for co in ("ZONE", "XTRACK", "AFG"):
        for r in A.ifta_check(co):
            if "skipped" in r:
                continue
            assert r["empty_ratio"] > 1.0, co
            assert r["sheet_miles"] > r["cd_odo"] + r["oo_loaded"], co


def test_the_miles_tie_for_every_company():
    """The strongest external check in the corpus. If this fails the sheets'
    mileage is wrong, and every cost-per-mile figure with it."""
    for co in ("ZONE", "XTRACK", "AFG"):
        for r in A.ifta_check(co):
            if "skipped" in r:
                continue
            assert abs(r["miles_gap_pct"]) <= A.IFTA_MILES_TOL, (co, r["miles_gap_pct"])


def test_the_fuel_verdict_is_on_gallons_not_on_a_residual_mpg():
    """The implied owner-operator mpg divides by a small residual and swings.
    AFG's miles tie to 0.6% and its gallons to 2.4%, and judging it on the
    residual called a return that ties 'not a truck'."""
    afg = [r for r in A.ifta_check("AFG") if "skipped" not in r][0]
    assert abs(afg["gallons_gap_pct"]) <= A.IFTA_GALLONS_TOL
    share = (afg["oo_loaded"] * afg["empty_ratio"]) / afg["sheet_miles"]
    assert share < A.OO_SHARE_TO_JUDGE


def test_the_two_returns_miss_in_opposite_directions():
    """One authority filing too many gallons and another too few, in the same
    quarter, is one fuel split the wrong way -- not two errors."""
    gaps = {}
    for co in ("ZONE", "XTRACK"):
        r = [x for x in A.ifta_check(co) if "skipped" not in x][0]
        gaps[co] = r["gallons_gap"]
    assert gaps["ZONE"] > 0 and gaps["XTRACK"] < 0


def test_internal_checks_run_on_every_week():
    for co in ("ZONE", "XTRACK", "AFG"):
        ks, rows = A.internal(co)
        assert len(rows) == len(ks) > 0
        for r in rows:
            assert set(r) >= {"week", "gross", "gross_vs_units", "net_identity"}


def test_the_panel_and_the_unit_rows_disagree_only_on_xtrack():
    """ZONE and AFG tie to the dollar every week; XTRACK does not on 10 of 27.
    If this ever changes it is a finding, not a broken test."""
    off = {}
    for co in ("ZONE", "XTRACK", "AFG"):
        _, rows = A.internal(co)
        off[co] = [r for r in rows if abs(r["gross_vs_units"]) > A.TIE]
    assert off["ZONE"] == [] and off["AFG"] == []
    assert len(off["XTRACK"]) > 0


def test_week_coverage_finds_a_hole():
    assert A.week_coverage(["2026-06-01", "2026-06-08", "2026-06-22"])[0] \
        == [("2026-06-08", "2026-06-22", 14)]
    assert A.week_coverage(["2026-06-01", "2026-06-08"])[0] == []
