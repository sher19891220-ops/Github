"""Controls on owner-operator economics.

The errors worth guarding are all sign or category errors: reading the driver's
deductions as company costs, reading a negative Driver Pay as a company loss, or
reusing the company-driver model on a business that works the other way round.
"""
import sys
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import owner_operator as OO   # noqa: E402

pytestmark = pytest.mark.skipif(
    not (ROOT / "data/raw/pnl/88206141-Xtrack_LLC_download.xlsx").exists(),
    reason="P&L workbooks absent")


@pytest.fixture(scope="module")
def ms():
    return {c: OO.model(c, 13) for c in OO.COMPANIES}


def test_every_company_passes_its_controls(ms):
    for c, m in ms.items():
        assert not OO.controls(m), (c, OO.controls(m))


def test_the_company_keeps_a_percentage_not_the_gross(ms):
    """On a company-driver truck the company takes the whole gross and pays every
    cost. On an owner-operator truck it takes a percentage and the driver pays."""
    for c, m in ms.items():
        assert 0.10 < m["charge_pct"] < 0.16, c
        assert m["company_charge"] == pytest.approx(m["gross"] * m["charge_pct"],
                                                    rel=0.05), c


def test_profit_is_the_charge_plus_the_fuel_discount(ms):
    """The sheet's own arithmetic: PROFIT = company charge + fuel discount. If
    anything else creeps in, the profit column is not what this model thinks."""
    for c, m in ms.items():
        assert m["result"] == pytest.approx(
            m["company_charge"] + m["fuel_discount_margin"], abs=1), c
        assert m["fuel_discount_margin"] >= 0, c


def test_rent_and_fuel_are_recovered_not_borne(ms):
    """They sit in the driver's deductions. Counting them as company costs
    inverts the sign of the whole business."""
    for c, m in ms.items():
        assert m["rent_recovered"] > 500, c
        assert m["fuel_recovered"] > 1000, c
        # neither is subtracted anywhere in the company's net
        assert m["net"] == pytest.approx(m["result"] - m["not_charged"], abs=1), c


def test_the_costs_the_block_never_charges_are_added_back(ms):
    """An OO truck is on the group policy, holds a plate, and uses the office.
    None of it appears in its block, so the P&L 'profit' is a GROSS margin."""
    for c, m in ms.items():
        assert m["insurance"] > 100, c
        assert m["registration"] > 10, c
        assert m["overhead"] > 100, c
        assert m["net"] < m["result"], c


def test_break_even_is_on_gross_not_on_miles(ms):
    """A percentage business cannot lose money on a mile it does not pay for."""
    for c, m in ms.items():
        assert m["breakeven_gross"] == pytest.approx(
            m["not_charged"] / m["margin_pct"], rel=0.01), c
        assert m["breakeven_miles"] == pytest.approx(
            m["breakeven_gross"] / m["rpm"], rel=0.01), c


def test_insurance_excludes_the_freight_rated_layers(ms):
    """Auto liability and physical damage are per SCHEDULED UNIT. The mileage-
    and revenue-rated cargo layers scale with freight, which is already counted
    inside the company charge -- adding them charges the same freight twice."""
    import insurance_cost as INS
    reg = INS.load()
    by = INS.per_company(reg)
    for c, m in ms.items():
        whole = sum(by[c].values())
        assert m["insurance"] * 52 * reg["allocation"]["physical_damage"][
            "from_the_submitted_schedule"][c]["units"] < whole + 1, c


def test_an_owner_operator_truck_grosses_more_than_a_company_one(ms):
    """If this reverses it is a finding about the freight mix, not a bug."""
    import cost_structure as CS
    for c, m in ms.items():
        cd = CS.structure(c, 13)["m"]
        assert m["rpm"] > cd["rpm"], c
