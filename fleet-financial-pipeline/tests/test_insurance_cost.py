"""Controls on the per-company insurance cost.

Every line is priced on a different basis. The failures worth guarding are all
the same shape: applying one basis to a line that is priced on another.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import insurance_cost as I


@pytest.fixture(scope="module")
def reg():
    return I.load()


@pytest.fixture(scope="module")
def by(reg):
    return I.per_company(reg)


def test_the_model_reproduces_the_policies(reg, by):
    assert not I.controls(reg, by), I.controls(reg, by)


def test_physical_damage_is_the_rate_times_the_value(reg):
    p = I.policy(reg, coverage="vehicle_physical_damage_and_non_trucking_liability")
    assert p["vpd_annual"] == pytest.approx(
        p["tiv_at_submission"] * p["rate"]["vehicle_physical_damage_annual_pct_of_tiv"])
    assert p["rate"]["vehicle_physical_damage_annual_pct_of_tiv"] == 0.045


def test_allocated_auto_liability_never_exceeds_the_policy(reg, by):
    master = I.policy(reg, role="group master policy")
    al = reg["allocation"]["auto_liability"]
    assert (sum(by[c]["auto_liability"] for c in by)
            + al["not_in_any_pnl"]["annual"]) == pytest.approx(master["annual_total"], abs=5)


def test_the_mileage_rated_cargo_layer_is_not_charged_per_truck(reg, by):
    """XTRACK's second cargo layer is $1.43 per 100 miles. Turning it into a
    per-truck figure charges an idle truck for miles it did not run."""
    c = I.policy(reg, coverage="motor_truck_cargo_second_layer")
    assert c["rate_per_mile"] == pytest.approx(1.43 / 100)
    assert c["annual_total"] == pytest.approx(
        c["estimated_miles"] * c["rate_per_mile"] + c["taxes_and_fees"])
    assert "motor_truck_cargo_second_layer" in by["XTRACK"]
    assert "motor_truck_cargo_second_layer" not in by["ZONE"]


def test_the_revenue_rated_cargo_is_not_charged_per_truck(reg, by):
    c = I.policy(reg, coverage="motor_truck_cargo")
    assert c["basis"].startswith("0.70%")
    assert "units_scheduled" not in c


def test_afg_carries_two_physical_damage_policies(reg, by):
    """Its units are on the group Intact schedule AND on Progressive."""
    assert by["AFG"]["physical_damage_power_units"] > 0
    assert by["AFG"]["progressive_own_policy"] > 0


def test_the_units_on_no_pnl_are_reported_not_spread(reg, by):
    """Eighteen insured units belong to no company's P&L. Spreading them over
    the three that do run hides the cleanup."""
    u = I.unallocated(reg)
    assert u["auto_liability_on_units_in_no_pnl"] > 0
    for co in by:
        assert by[co]["auto_liability"] < u["auto_liability_on_units_in_no_pnl"] * 3


def test_trailer_physical_damage_is_flagged_as_an_estimate(reg, by):
    """104 trailers, $4.35M, and no company column anywhere. The share is an
    assumption and the key says so."""
    for co in by:
        assert any(k.endswith("_ESTIMATED") for k in by[co])
