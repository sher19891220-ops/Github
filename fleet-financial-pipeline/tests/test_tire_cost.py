"""
Regression + sanity tests for analysis/tire_cost.py. Skipped when the raw
maintenance ledger isn't in the corpus (container reclaim, data/raw is
gitignored) -- same pattern as every other raw-corpus-dependent test here.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))

RAW_LEDGER = ROOT / "data/raw/pnl/gs-ZONE_master_truck_trailer_expenses.xlsx"
pytestmark = pytest.mark.skipif(not RAW_LEDGER.exists(),
                                 reason="raw maintenance ledger not in corpus")

import tire_cost as TC  # noqa: E402


def test_every_company_has_a_positive_cost_per_mile():
    figures = TC.company_figures()
    for co, f in figures.items():
        assert f["company_borne_total"] > 0, co
        assert f["cost_per_mile"] > 0, co


def test_cost_per_mile_is_a_small_fraction_of_a_dollar():
    """Sanity bound, not a measured fact: tire cost per mile for one repair
    category should be a small piece of the ~$1.70-1.80/mile total variable
    cost this pipeline measures elsewhere (cost_structure.py) -- if this
    ever came back above, say, $0.20/mile, that would mean the join or the
    category regex broke, not that tires got dramatically more expensive."""
    figures = TC.company_figures()
    for co, f in figures.items():
        assert f["cost_per_mile"] < 0.20, co


def test_by_unit_type_sums_to_the_company_total():
    figures = TC.company_figures()
    for co, f in figures.items():
        assert sum(f["by_unit_type"].values()) == pytest.approx(f["company_borne_total"])


def test_fleet_figure_aggregates_company_figures_correctly():
    figures = TC.company_figures()
    fleet = TC.fleet_figure(figures)
    assert fleet["total"] == pytest.approx(sum(f["company_borne_total"] for f in figures.values()))
    assert fleet["miles"] == sum(f["miles_in_window"] for f in figures.values())
    assert fleet["cost_per_mile"] == pytest.approx(fleet["total"] / fleet["miles"], abs=1e-4)


def test_fleet_rate_is_lower_than_the_superseded_industry_benchmark():
    """Regression guard for the actual finding: the real measured rate
    ($0.0159/mile) is well under the $0.03-0.04/mile industry-benchmark
    placeholder COST_METHODOLOGY.md used before this module existed. If a
    future ledger update pushed the real rate ABOVE that benchmark, that
    would be worth a second look, not a silent pass."""
    fleet = TC.fleet_figure(TC.company_figures())
    assert fleet["cost_per_mile"] < 0.03
