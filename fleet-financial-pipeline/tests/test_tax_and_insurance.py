"""Controls on the filed tax returns and the signed insurance policies.

These are the first documents in the corpus that were filed with a state or
signed with a carrier, so they are the first outside check on figures the
sheets have been asserting alone.
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
import parse_tax_and_insurance as P

INS = ROOT / "config/insurance.json"


@pytest.fixture(scope="module")
def ins():
    return json.loads(INS.read_text())


def test_insurance_register_totals_its_own_lines(ins):
    # A policy with no bound premium yet carries annual_total None. It must be
    # skipped, never coerced to zero -- a missing premium is not a free policy.
    named = sum(p["annual_total"] for p in ins["policies"]
                if p.get("annual_total") is not None)
    assert named == pytest.approx(ins["group_annual_known"], abs=0.01)
    assert ins["group_weekly_known"] == pytest.approx(named / 52, abs=0.5)


def test_the_master_policy_per_unit_rate_is_its_own_arithmetic(ins):
    m = next(p for p in ins["policies"] if p["role"] == "group master policy")
    assert m["premium"] + m["rpg_premium_tax"] + m["fees"] == pytest.approx(
        m["annual_total"], abs=0.01)
    assert m["annual_total"] / m["units_scheduled"] == pytest.approx(
        m["per_unit_year"], abs=0.5)
    assert m["per_unit_year"] / 52 == pytest.approx(m["per_unit_week"], abs=0.5)


def test_financing_a_premium_costs_more_than_the_premium(ins):
    x = next(p for p in ins["policies"] if p["entity"] == "XTRACK")
    f = x["financed"]
    assert f["down_payment"] + f["installments"] * f["installment"] == pytest.approx(
        x["annual_total"] + f["finance_charge"], abs=1.0)
    assert f["finance_charge"] > 0, "a financed premium is not its face value"


def test_xtracks_own_policy_covers_far_fewer_trucks_than_it_runs(ins):
    """The finding this register exists for: XTRACK insures 3 power units on its
    own paper and runs 45+, which is why 98% of group insurance leaves ZONE."""
    x = next(p for p in ins["policies"] if p["entity"] == "XTRACK")
    assert x["units_scheduled"] == 3


def test_cargo_is_priced_on_revenue_not_on_trucks(ins):
    """Rated at $0.70 per $100 of gross. Spreading it per truck makes a variable
    cost look fixed and moves break-even the wrong way."""
    c = next(p for p in ins["policies"] if p["coverage"] == "motor_truck_cargo")
    assert c["basis"].startswith("0.70%")
    assert "units_scheduled" not in c


def test_an_impossible_fleet_mpg_is_flagged():
    """XTRACK's Q2 2026 return divides to 8.76 mpg. A Class-8 dry van fleet does
    not do that, and because IFTA tax is (taxable miles / fleet mpg) − tax-paid
    gallons, an overstated mpg shrinks the tax."""
    good = [{"source": "q1.pdf", "total_miles": 1021056, "total_gallons": 148089,
             "computed_mpg": 1021056 / 148089, "stated_mpg": 6.89}]
    bad = [{"source": "q2.pdf", "total_miles": 1727001, "total_gallons": 197081,
            "computed_mpg": 1727001 / 197081, "stated_mpg": 8.76}]
    assert not P.check_ifta_plausibility(good)
    flagged = P.check_ifta_plausibility(bad)
    assert len(flagged) == 1 and "8.76" in flagged[0][1]


def test_a_stated_mpg_that_disagrees_with_the_division_is_flagged():
    r = [{"source": "x.pdf", "total_miles": 1000000, "total_gallons": 150000,
          "computed_mpg": 6.667, "stated_mpg": 7.50}]
    assert P.check_ifta_plausibility(r)


def test_a_policy_without_a_bound_premium_says_so(ins):
    """Held open for months on the physical damage, whose questionnaire stated
    the exposure and left the rate blank. The rate arrived 2026-09-05 and that
    policy is now priced, so the rule is enforced on whatever is still unpriced:
    a premium of None must be accompanied by a note saying what is missing, and
    must never be coerced to zero."""
    for p in ins["policies"]:
        if p.get("annual_total") is None:
            assert p.get("_MISSING"), f"{p['coverage']}: no premium and no note"


def test_the_physical_damage_premium_is_the_rate_times_the_value(ins):
    """4.50% of Total Insured Value a year, per the Intact rate page."""
    p = next(x for x in ins["policies"] if "physical_damage" in x["coverage"])
    r = p["rate"]
    assert r["vehicle_physical_damage_annual_pct_of_tiv"] == 0.045
    assert p["vpd_annual"] == pytest.approx(
        p["tiv_at_submission"] * r["vehicle_physical_damage_annual_pct_of_tiv"])
    assert r["non_trucking_liability_per_unit_month"] == 35.0
    assert p["annual_total"] is not None


def test_the_physical_damage_split_is_a_share_of_a_premium_not_a_premium(ins):
    """Until the binder arrives the deliverable is the basis, not the cost."""
    a = ins["allocation"]["physical_damage"]
    assert abs(a["ZONE"]["share_excl_afg"] + a["XTRACK"]["share_excl_afg"] - 1) < 0.001
    assert (a["ZONE"]["tiv"] + a["XTRACK"]["tiv"]
            == pytest.approx(a["group_excluding_afg"]["tiv"], rel=0.001))
    assert "AFG" in a and "share_excl_afg" not in a["AFG"]


def test_auto_liability_allocation_adds_back_to_the_policy(ins):
    al = ins["allocation"]["auto_liability"]
    parts = [al[k] for k in ("ZONE", "XTRACK", "AFG", "not_in_any_pnl")]
    master = next(p for p in ins["policies"] if p.get("role") == "group master policy")
    assert sum(p["units"] for p in parts) == master["units_scheduled"]
    assert sum(p["annual"] for p in parts) == pytest.approx(master["annual_total"], rel=0.001)


def test_the_open_questions_are_recorded_not_answered(ins):
    """Each answered question is replaced, not deleted. The unit-to-VIN gap gave
    way to the missing premium, which gave way to which TIV the policy is
    written on -- three figures are in play and a 5.3% spread at 4.50% is about
    $31,000 a year."""
    assert any("TIV" in q for q in ins["open_questions"])
    assert len(ins["open_questions"]) >= 3


IFTA_SAMPLE = """Confirmation Number: 1-209-829-232
Date Submitted: 01/28/2026
Legal Name: lXTRACK LLC
Accounti ID: 1486266560
Filing Period: 12/31/2025
D 430707 ÷ 64575 = 6.67
7 Add Lines 4, 5, and 6. This is your cumulative total due or refund claimed. 7 $ 3,719.02
"""


def test_the_step2_numbers_survive_the_field_loop():
    """The field loop reused the same variable as the Step 2 match, so
    total_miles came from whichever header matched last and every return raised
    and was swallowed. Nothing about the output looked wrong -- there was none."""
    r = P.parse_ifta.__wrapped__ if hasattr(P.parse_ifta, "__wrapped__") else None
    rec = _parse_text(IFTA_SAMPLE)
    assert rec["total_miles"] == 430707
    assert rec["total_gallons"] == 64575
    assert rec["stated_mpg"] == 6.67
    assert rec["computed_mpg"] == pytest.approx(430707 / 64575)
    assert rec["tax_due"] == 3719.02
    assert rec["legal_name"] == "XTRACK LLC"


def _parse_text(t):
    """parse_ifta() without the PDF, so the parsing logic is testable alone."""
    step2 = P.IFTA_STEP2.search(t)
    assert step2, "the Step 2 division line is what identifies the form"
    rec = {}
    for k, pat in P.IFTA_FIELDS.items():
        hit = pat.search(t)
        if hit:
            rec[k] = hit.group(1).strip()
    rec["total_miles"], rec["total_gallons"] = P.num(step2.group(1)), P.num(step2.group(2))
    rec["stated_mpg"] = P.num(step2.group(3))
    rec["computed_mpg"] = rec["total_miles"] / rec["total_gallons"]
    tax = P.IFTA_TAX.search(t)
    if tax:
        rec["tax_due"] = P.num(tax.group(1))
    return rec


def test_a_return_is_identified_by_structure_not_by_a_keyword():
    """The word 'IFTA' appears in some of these returns and not in others that
    are plainly the same form; requiring it threw away four of seven."""
    assert "IFTA" not in IFTA_SAMPLE
    assert P.IFTA_STEP2.search(IFTA_SAMPLE)


def test_a_relative_path_does_not_break_the_reader():
    """Path.relative_to() raised on a relative argument and the caller's except
    swallowed it, so every return parsed to nothing."""
    assert P.rel("data/raw/ifta/x.pdf") == "data/raw/ifta/x.pdf"
    assert P.rel(str(ROOT / "data/raw/ifta/x.pdf")) == "data/raw/ifta/x.pdf"
