"""
Known-input/known-output fixtures for the cost allocation & break-even
engine (Section 6's testing requirement: financial math should never be
"trust the dashboard"), plus a parity check against numbers this project has
already established and audited elsewhere (data/processed/cost_breakdown_
view.json) -- the strongest test available for a new formula: does it
reproduce a break-even figure this whole pipeline has already spent weeks
proving correct.
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
from breakeven_engine import (  # noqa: E402
    AllocationMethod, CostInputs, EntityBasis, allocate_overhead,
    breakeven_miles, breakeven_per_day, breakeven_per_mile,
    company_breakeven_per_mile, contribution_per_mile, from_cost_breakdown_view,
    margin_per_mile, profit_per_day,
)


# ---- Section 4.2 / 4.1, textbook case (overhead_pct_of_gross=0.0) ----------
# A truck with $2,000/week fixed cost, $1.50/mile variable, running
# 2,000 miles over a 7-day week: hand-computed, not derived from the engine.

def test_breakeven_per_mile_textbook_case():
    i = CostInputs(fixed_costs_total=2000, variable_cost_per_mile=1.50,
                   miles_driven=2000, days_in_period=7)
    # 2000/2000 + 1.50 = 1.00 + 1.50 = 2.50
    assert breakeven_per_mile(i) == pytest.approx(2.50)


def test_breakeven_per_day_textbook_case():
    i = CostInputs(fixed_costs_total=2000, variable_cost_per_mile=1.50,
                   miles_driven=2000, days_in_period=7)
    # avg miles/day = 2000/7 = 285.714...
    # 2000/7 + 1.50*285.714... = 285.714 + 428.571 = 714.286
    assert breakeven_per_day(i) == pytest.approx(2000 / 7 + 1.50 * (2000 / 7))


def test_breakeven_miles_is_inverse_of_breakeven_per_mile():
    i = CostInputs(fixed_costs_total=2000, variable_cost_per_mile=1.50,
                   miles_driven=2000, days_in_period=7)
    be_rpm = breakeven_per_mile(i)
    # running exactly the break-even RPM at these same miles should require
    # exactly these same miles to break even -- a fixed point.
    assert breakeven_miles(i, be_rpm) == pytest.approx(2000, rel=1e-6)


def test_margin_and_profit_zero_at_breakeven():
    i = CostInputs(fixed_costs_total=2000, variable_cost_per_mile=1.50,
                   miles_driven=2000, days_in_period=7,
                   revenue_per_mile=breakeven_per_mile(
                       CostInputs(fixed_costs_total=2000, variable_cost_per_mile=1.50,
                                  miles_driven=2000, days_in_period=7)))
    assert margin_per_mile(i) == pytest.approx(0.0, abs=1e-9)
    assert profit_per_day(i) == pytest.approx(0.0, abs=1e-6)


def test_margin_positive_above_breakeven_negative_below():
    be = breakeven_per_mile(CostInputs(fixed_costs_total=2000, variable_cost_per_mile=1.50,
                                        miles_driven=2000, days_in_period=7))
    above = CostInputs(fixed_costs_total=2000, variable_cost_per_mile=1.50,
                        miles_driven=2000, days_in_period=7, revenue_per_mile=be + 0.50)
    below = CostInputs(fixed_costs_total=2000, variable_cost_per_mile=1.50,
                        miles_driven=2000, days_in_period=7, revenue_per_mile=be - 0.50)
    assert margin_per_mile(above) > 0
    assert margin_per_mile(below) < 0


# ---- overhead_pct_of_gross generalization ----------------------------------

def test_zero_overhead_pct_matches_literal_prompt_formula():
    """overhead_pct_of_gross=0.0 must reduce breakeven_per_mile to exactly
    Section 4.2 as written: fixed/miles + variable, no other term."""
    i = CostInputs(fixed_costs_total=3000, variable_cost_per_mile=1.20,
                   miles_driven=2500, days_in_period=7)
    assert breakeven_per_mile(i) == pytest.approx(3000 / 2500 + 1.20)


def test_nonzero_overhead_pct_raises_breakeven_rate():
    """A real revenue-linked cut means MORE rate/mile is needed to break
    even, never less -- omitting it would understate what's required."""
    base = CostInputs(fixed_costs_total=3000, variable_cost_per_mile=1.20,
                       miles_driven=2500, days_in_period=7)
    with_pct = CostInputs(fixed_costs_total=3000, variable_cost_per_mile=1.20,
                           miles_driven=2500, days_in_period=7,
                           overhead_pct_of_gross=0.05)
    assert breakeven_per_mile(with_pct) > breakeven_per_mile(base)


def test_overhead_pct_out_of_range_rejected():
    with pytest.raises(ValueError):
        CostInputs(fixed_costs_total=1, variable_cost_per_mile=1,
                   miles_driven=1, days_in_period=1, overhead_pct_of_gross=1.0)
    with pytest.raises(ValueError):
        CostInputs(fixed_costs_total=1, variable_cost_per_mile=1,
                   miles_driven=1, days_in_period=1, overhead_pct_of_gross=-0.1)


# ---- Section 4.3, company-level -------------------------------------------

def test_company_breakeven_per_mile_matches_hand_sum():
    trucks = [
        CostInputs(fixed_costs_total=2000, variable_cost_per_mile=1.50,
                   miles_driven=2000, days_in_period=7),
        CostInputs(fixed_costs_total=2200, variable_cost_per_mile=1.40,
                   miles_driven=2500, days_in_period=7),
    ]
    total_cost = (2000 + 1.50 * 2000) + (2200 + 1.40 * 2500)
    total_miles = 2000 + 2500
    assert company_breakeven_per_mile(trucks) == pytest.approx(total_cost / total_miles)


def test_company_breakeven_applies_pct_once_not_per_truck():
    trucks = [
        CostInputs(fixed_costs_total=2000, variable_cost_per_mile=1.50,
                   miles_driven=2000, days_in_period=7),
    ]
    without = company_breakeven_per_mile(trucks, overhead_pct_of_gross=0.0)
    with_pct = company_breakeven_per_mile(trucks, overhead_pct_of_gross=0.05)
    assert with_pct == pytest.approx(without / 0.95)


# ---- Section 3.3, overhead allocation --------------------------------------

def test_allocate_per_truck_splits_evenly_by_count():
    entities = [EntityBasis(name="ZONE", truck_count=30), EntityBasis(name="XTRACK", truck_count=45),
                EntityBasis(name="AFG", truck_count=15)]
    out = allocate_overhead(9000, AllocationMethod.PER_TRUCK, entities)
    assert out["ZONE"] == pytest.approx(3000)
    assert out["XTRACK"] == pytest.approx(4500)
    assert out["AFG"] == pytest.approx(1500)


def test_allocate_per_revenue_share():
    entities = [EntityBasis(name="A", revenue=100_000), EntityBasis(name="B", revenue=300_000)]
    out = allocate_overhead(4000, AllocationMethod.PER_REVENUE_SHARE, entities)
    assert out["A"] == pytest.approx(1000)
    assert out["B"] == pytest.approx(3000)


def test_allocate_per_mile():
    entities = [EntityBasis(name="A", miles=1000), EntityBasis(name="B", miles=1000)]
    out = allocate_overhead(500, AllocationMethod.PER_MILE, entities)
    assert out["A"] == pytest.approx(250)
    assert out["B"] == pytest.approx(250)


def test_allocation_always_sums_back_to_the_pool():
    entities = [EntityBasis(name="ZONE", truck_count=29.8, revenue=283_426, miles=2818),
                EntityBasis(name="XTRACK", truck_count=27.1, revenue=386_295, miles=2546),
                EntityBasis(name="AFG", truck_count=5.8, revenue=104_579, miles=3280)]
    for method in AllocationMethod:
        out = allocate_overhead(51_656, method, entities)
        assert sum(out.values()) == pytest.approx(51_656)


def test_allocate_rejects_zero_total_basis():
    entities = [EntityBasis(name="A", truck_count=0), EntityBasis(name="B", truck_count=0)]
    with pytest.raises(ValueError):
        allocate_overhead(1000, AllocationMethod.PER_TRUCK, entities)


# ---- Parity against this project's own already-established numbers --------
# This is the strongest check available: feed the engine ZONE/XTRACK/AFG's
# real, already-audited fixed cost, variable cost, current miles and rate,
# and confirm it reproduces the SAME break-even miles this dashboard has
# been showing (cost_breakdown_view.json / facts.json's own
# breakeven/miles_at_current_rate, produced by analysis/cost_structure.py's
# true_breakeven()). This does NOT check against facts.json's separate
# breakeven/rate_at_current_miles figure -- that one comes from
# analysis/truck_breakeven.py, a different, independently-fitted fixed/
# variable model that this project has not reconciled with cost_structure.py's
# (see COST_METHODOLOGY.md's "Two break-even models" section) -- comparing
# this engine to that figure would be comparing it against the wrong model,
# not testing this engine.

COST_BREAKDOWN_VIEW = ROOT / "data/processed/cost_breakdown_view.json"


@pytest.mark.skipif(not COST_BREAKDOWN_VIEW.exists(),
                     reason="cost_breakdown_view.json not built -- run analysis/build_cost_breakdown_view.py")
@pytest.mark.parametrize("company", ["ZONE", "XTRACK", "AFG"])
def test_parity_with_established_breakeven_miles(company):
    view = json.loads(COST_BREAKDOWN_VIEW.read_text())["companies"][company]
    inputs = from_cost_breakdown_view(view)
    established = view["breakeven"]["miles_at_current_rate"]
    got = breakeven_miles(inputs, inputs.rpm())
    # cost_breakdown_view.json's own fixed/variable/rate figures are already
    # rounded (to the dollar, to 4dp, to 3dp) before this test re-derives
    # break-even from them, so a little compounding rounding drift is
    # expected -- the same rounding-order effect docs/FINDINGS.md already
    # documents for this pipeline's own group_figures() helper. Tolerate
    # +/-1 mile; anything more would mean the formula itself disagrees.
    assert abs(round(got) - established) <= 1
