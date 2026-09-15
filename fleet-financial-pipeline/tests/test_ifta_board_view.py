"""Tests for analysis/build_ifta_board_view.py's own logic -- the status
classification (ok/warn/crit) and the reshaping of pnl_accuracy.py's and
oregon_gap.py's already-tested output. Skipped when the raw IFTA corpus
isn't present (container reclaim, data/raw is gitignored), same pattern as
every other raw-corpus-dependent test here.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))

RAW_IFTA = ROOT / "data/raw/ifta"
pytestmark = pytest.mark.skipif(not RAW_IFTA.exists(), reason="raw IFTA corpus not in container")

import build_ifta_board_view as BV  # noqa: E402


def test_status_ok_within_tolerance():
    assert BV._status(0.03, 0.05) == "ok"


def test_status_warn_within_double_tolerance():
    assert BV._status(0.08, 0.05) == "warn"


def test_status_crit_beyond_double_tolerance():
    assert BV._status(0.15, 0.05) == "crit"


def test_status_unknown_on_none():
    assert BV._status(None, 0.05) == "unknown"


def test_status_is_sign_agnostic():
    """A gap in either direction is judged the same way -- gallons_gap_pct
    on XTRACK's real 2026Q2 quarter is -27.53%, and that must read as
    exactly as bad as +27.53%, not as a pass because it's negative."""
    assert BV._status(-0.20, 0.05) == BV._status(0.20, 0.05) == "crit"


def test_reconciliation_rows_have_known_companies_and_quarters():
    rows = BV.reconciliation_rows()
    assert rows  # the real corpus always has at least some data
    for r in rows:
        assert r["company"] in BV.COMPANIES
        assert r["quarter"][:4].isdigit()


def test_incomplete_quarters_carry_no_numeric_comparison():
    """A quarter covering under ~13 weeks must be reported as incomplete,
    never compared -- comparing it would measure the missing weeks, not
    accuracy (see pnl_accuracy.py's own MIN_WEEKS_FOR_A_QUARTER note)."""
    rows = BV.reconciliation_rows()
    incomplete = [r for r in rows if r["status"] == "incomplete"]
    for r in incomplete:
        assert "miles_gap_pct" not in r
        assert "note" in r


def test_oregon_rows_no_gap_is_ok_even_with_zero_returns():
    """A quarter with zero Oregon miles per its own IFTA filing is not a
    gap, even if zero Oregon returns are held -- there was nothing to
    file. CLAUDE.md/docs/FINDINGS.md: "A QUARTER WITH NO OREGON OPERATION
    IS NOT A GAP." """
    rows, _ = BV.oregon_rows()
    no_operation = [r for r in rows if r["ifta_or_miles"] == 0]
    assert no_operation  # the real corpus has at least one such quarter
    for r in no_operation:
        assert r["status"] == "ok"


def test_oregon_total_tax_at_risk_matches_known_figure():
    """Regression guard for the number this project has already quoted
    elsewhere (CLAUDE.md/docs/FINDINGS.md: "$2,287 of tax")."""
    rows, _ = BV.oregon_rows()
    total = sum(r["tax_at_risk"] for r in rows)
    assert total == pytest.approx(2287.43, abs=0.5)
