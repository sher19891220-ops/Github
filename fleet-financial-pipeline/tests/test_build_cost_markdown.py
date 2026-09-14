"""Regression test for the exact float-vs-int-vs-str unit-number bug this
module found in its own per-unit table: each company's pnl_unit_week CSV
stores 'unit' in a different dtype (ZONE float64, XTRACK int64, AFG str),
so concatenating them raw splits one physical truck (e.g. 496635) into two
separate rows instead of merging them under one company-joined row. See
CLAUDE.md's "A REAL BUG THIS SESSION FOUND IN ITS OWN NEW CODE" note for the
same failure mode in ingest/parse_truckmax_invoices.py.
"""
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
from build_cost_markdown import normalize_unit  # noqa: E402


def test_whole_number_float_matches_int_and_str():
    assert normalize_unit(496635.0) == normalize_unit(496635) == normalize_unit("496635") == "496635"


def test_non_numeric_unit_passes_through():
    assert normalize_unit("LO") == "LO"


def test_nan_returns_none():
    assert normalize_unit(float("nan")) is None


def test_non_whole_number_float_is_not_truncated():
    # Not expected in this corpus's unit column, but must not silently drop a
    # fractional digit the way int() truncation would.
    assert normalize_unit(15862.5) == "15862.5"


def test_grouping_merges_across_dtypes():
    df = pd.DataFrame({"unit": [496635, 496635.0, "496635"], "company": ["XTRACK", "ZONE", "AFG"]})
    df["unit"] = df["unit"].apply(normalize_unit)
    assert df["unit"].nunique() == 1
