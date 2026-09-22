"""Tests for analysis/driver_arrangement.py -- pricing owner-operator,
lease-to-purchase and lease-to-walk-away trucks from their stated rate
cards (config/driver_arrangement_rates.json), fed into the already-tested
breakeven_engine.py.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import driver_arrangement as D  # noqa: E402
import breakeven_engine as B    # noqa: E402


def test_load_rates_has_all_three_arrangements():
    rates = D.load_rates()
    for a in D.ARRANGEMENTS:
        assert a in rates


def test_unknown_arrangement_raises_not_silently_defaults():
    with pytest.raises(KeyError):
        D.fixed_cost_per_week("company_driver")
    with pytest.raises(KeyError):
        D.variable_cost_per_mile("not_a_real_arrangement")


def test_fixed_cost_matches_the_stated_rate_card():
    rates = D.load_rates()
    assert D.fixed_cost_per_week("lease_to_walk_away", rates) == 1650
    assert D.fixed_cost_per_week("lease_to_purchase", rates) == 1750
    assert D.fixed_cost_per_week("owner_operator", rates) == 650


def test_owner_operator_carries_no_truck_charge():
    """docs/ACCOUNTING_MODEL.md Section 3: an owner-operator owns or
    finances their own equipment -- the company's rate card for OO has no
    truck_rent/truck_payment component, unlike LTP and LTWA."""
    rates = D.load_rates()
    assert "truck_rent" not in rates["owner_operator"]
    assert "truck_payment" not in rates["owner_operator"]


def test_only_lease_to_walk_away_states_a_mileage_charge():
    assert D.variable_cost_per_mile("lease_to_walk_away") == pytest.approx(0.13)
    assert D.variable_cost_per_mile("lease_to_purchase") == 0.0
    assert D.variable_cost_per_mile("owner_operator") == 0.0


def test_total_fixed_equals_the_sum_of_its_own_named_components():
    """A control on the config file itself: total_fixed must equal what
    the rate card's own line items add up to, or the stated total has
    drifted from its own components."""
    rates = D.load_rates()
    ltwa = rates["lease_to_walk_away"]
    assert ltwa["total_fixed"] == pytest.approx(
        ltwa["truck_rent"] + ltwa["insurance"] + ltwa["trailer_rent"] + ltwa["admin_fee"])
    ltp = rates["lease_to_purchase"]
    assert ltp["total_fixed"] == pytest.approx(
        ltp["truck_payment"] + ltp["insurance"] + ltp["trailer_rent"] + ltp["admin_fee"])
    oo = rates["owner_operator"]
    assert oo["total_fixed"] == pytest.approx(
        oo["insurance"] + oo["trailer_rent"] + oo["admin_fee"])


def test_cost_inputs_builds_a_usable_breakeven_engine_input():
    ci = D.cost_inputs("lease_to_walk_away", miles_driven=2500, revenue_per_mile=2.50)
    assert isinstance(ci, B.CostInputs)
    assert ci.fixed_costs_total == 1650
    assert ci.variable_cost_per_mile == pytest.approx(0.13)
    # Runs cleanly through the existing, already-tested break-even math --
    # this module's whole point is not needing its own formulas.
    be = B.breakeven_per_mile(ci)
    assert be > 0


def test_lease_to_walk_away_crosses_over_lease_to_purchase_as_miles_rise():
    """LTWA's fixed cost (1650) is $100 below LTP's (1750), but LTWA also
    carries a $0.13/mi surcharge LTP does not -- so LTWA needs a LOWER
    rate/mile at low weekly mileage (the fixed gap dominates) and a
    HIGHER one once mileage is high enough that the surcharge outweighs
    that $100 (crossover at 100/0.13 ~ 769 mi/week). This fleet's real
    company-driver trucks run ~2,000-3,000 mi/week (see truck_breakeven.py
    model()'s miles_per_truck across ZONE/XTRACK/AFG), well past that
    crossover -- so at a realistic weekly mileage, LTP is the cheaper
    rate/mile of the two, not LTWA."""
    low_miles, high_miles = 500, 2500
    assert (B.breakeven_per_mile(D.cost_inputs("lease_to_walk_away", low_miles))
            < B.breakeven_per_mile(D.cost_inputs("lease_to_purchase", low_miles)))
    assert (B.breakeven_per_mile(D.cost_inputs("lease_to_walk_away", high_miles))
            > B.breakeven_per_mile(D.cost_inputs("lease_to_purchase", high_miles)))


def test_owner_operator_breakeven_is_far_below_lease_arrangements():
    """OO carries no truck charge at all -- its break-even rate/mile at
    the same miles must be well below LTP/LTWA, which both carry a truck
    charge on top of the same insurance/trailer/admin base."""
    miles = 2500
    be_oo = B.breakeven_per_mile(D.cost_inputs("owner_operator", miles))
    be_ltp = B.breakeven_per_mile(D.cost_inputs("lease_to_purchase", miles))
    be_ltwa = B.breakeven_per_mile(D.cost_inputs("lease_to_walk_away", miles))
    assert be_oo < be_ltp
    assert be_oo < be_ltwa
