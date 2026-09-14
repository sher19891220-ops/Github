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


def test_allocated_auto_liability_adds_back_to_the_EFFECTIVE_premium(reg, by):
    """Not to the face premium. $442,670.66 of the $1,087,431.92 written has come
    back as return premium, so the four shares must sum to $644,761, and a test
    that targets the face value passes only while the model overstates by 69%."""
    master = I.policy(reg, role="group master policy")
    al = reg["allocation"]["auto_liability"]
    scale = I.al_scale(reg)
    got = sum(by[c]["auto_liability"] for c in by) + al["not_in_any_pnl"]["annual"] * scale
    assert got == pytest.approx(master["actual"]["effective_annual_cost"], abs=5)
    assert got < master["annual_total"] * 0.7


def test_the_face_premium_is_never_used_as_the_cost(reg, by):
    """The single most expensive mistake available here: allocating $1,087,432
    of auto liability that the group did not pay."""
    master = I.policy(reg, role="group master policy")
    assert I.al_scale(reg) == pytest.approx(0.5929, abs=0.001)
    for co in by:
        assert by[co]["auto_liability"] < reg["allocation"]["auto_liability"][co]["annual"]
    a = master["actual"]
    assert (a["financed_balance_at_activation"] - a["installments_paid"]
            - a["return_premium_total"]) == pytest.approx(a["closing_balance"], abs=1)


def test_a_bill_beats_a_rate_and_they_disagree_in_both_directions(reg):
    """Both reporting policies moved with the schedule. The physical damage came
    in 3.7% ABOVE its rate as units were added; the auto liability came in 41%
    BELOW as units left. A model that trusts the rate is wrong both ways."""
    pd = I.policy(reg, coverage="vehicle_physical_damage_and_non_trucking_liability")
    assert pd["actual"]["annualised"] > pd["vpd_annual"]
    master = I.policy(reg, role="group master policy")
    assert master["actual"]["effective_annual_cost"] < master["annual_total"]
    # per_company() must read the bill, not the rate.
    by = I.per_company(reg)
    allocated = sum(v["physical_damage_power_units"]
                    + v["physical_damage_trailers_ESTIMATED"] for v in by.values())
    assert allocated > pd["vpd_annual"] * 0.9


def test_xtracks_own_package_is_charged_to_xtrack(reg, by):
    """It was priced in the register and missing from the table, which
    understated XTRACK by $63,722 a year."""
    own = I.policy(reg, coverage="auto_liability_cargo_pd_gl")
    assert by["XTRACK"]["own_package_benchmark"] == own["annual_total"] == 63722.0
    assert "own_package_benchmark" not in by["ZONE"]
    # The premium, not the financed cash: the 14.85% finance charge reaches the
    # bank as a loan payment and belongs to finance cost, not insurance.
    f = own["financed"]
    assert (f["down_payment"] + f["installments"] * f["installment"]
            > own["annual_total"])


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
    """Its units are on the group Intact schedule AND on Progressive. The
    Progressive premium is NOT YET KNOWN, so it is absent from the table rather
    than present as a zero -- AFG's total is a floor and the register says so."""
    assert by["AFG"]["physical_damage_power_units"] > 0
    prog = I.policy(reg, entity="AFG")
    assert prog["annual_total"] is None
    assert "progressive_own_policy" not in by["AFG"]
    assert prog["_MISSING"]
    # The bills prove it is real and growing even though it cannot be totalled.
    bills = prog["actual"]["bills"]
    first, last = min(bills), max(bills)
    assert bills[last]["remaining"] > bills[first]["remaining"] * 8
    assert bills[last]["payments_left"] < bills[first]["payments_left"]


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
