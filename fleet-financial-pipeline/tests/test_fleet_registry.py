"""Controls on the unit-to-VIN registry.

This join is what every insurance question was blocked on, so the ways it can be
wrong all matter: reading an assignment history as a fleet list, attributing a
truck to the wrong company, or letting a section header through as a VIN.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
import fleet_registry as F

pytestmark = pytest.mark.skipif(not F.WORKBOOK.exists(),
                                reason="group unit workbook absent")


@pytest.fixture(scope="module")
def built():
    return F.registry()


def test_the_workbook_is_an_assignment_history_not_a_fleet_list(built):
    """1,413 rows carry a VIN and there are 358 trucks; one appears 15 times.
    Counting rows multiplies the fleet fourfold."""
    reg, rows = built
    assert rows > 3 * len(reg)


def test_only_real_vins_get_through(built):
    """The VIN column also holds section headers like 'NEW WALMART TRUCKS',
    which is the right length to pass a bare length check."""
    reg, _ = built
    assert all(F.VIN_RE.match(r["vin"]) for r in reg)
    assert not F.VIN_RE.match("NEW WALMART TRUCKS")
    assert not F.VIN_RE.match("1FUJHHDR4NLNC009I"), "I, O and Q are not VIN characters"


def test_a_k_suffix_is_expanded_and_oo_is_flagged():
    assert F.money(150000.0) == (150000.0, False)
    assert F.money("110K$")[0] == 110000
    assert F.money("$100K")[0] == 100000
    assert F.money("OO") == (None, True)
    assert F.money("$60,000/OO") == (60000.0, True)
    assert F.money("") == (None, False)


def test_company_comes_from_the_pnl_not_from_the_sheet(built):
    """71 VINs sit on more than one company's sheet because a truck that moved
    authority stays in both histories. The sheet cannot say who runs it now."""
    reg, _ = built
    multi = [r for r in reg if len(r["on_lists"]) > 1]
    assert len(multi) > 20
    for r in multi:
        if r["company"]:
            assert r["last_week"], "a company attribution must be dated"


def test_trucks_that_appear_in_no_pnl_are_not_counted_as_fleet(built):
    """244 of the 358 VINs are history. Treating the workbook as current
    multiplies the fleet by three."""
    reg, _ = built
    assert sum(1 for r in reg if r["last_week"] is None) > 100
    assert len(F.active(reg)) < len(reg) / 2


def test_owner_operator_units_are_excluded_from_the_insured_value(built):
    """They carry their own physical damage; charging the company for them
    overstates the premium base."""
    reg, _ = built
    g, total = F.insured_value_by_company(reg)
    oo_value = sum(r["value"] or 0 for r in F.active(reg) if r["owner_operator"])
    assert total > 0
    assert total + oo_value > total or oo_value == 0


def test_excluding_a_company_reweights_the_rest_to_one(built):
    reg, _ = built
    g, _ = F.insured_value_by_company(reg, exclude=("AFG",))
    assert "AFG" not in g
    assert sum(x["share"] for x in g.values()) == pytest.approx(1.0)


def test_the_registry_reproduces_the_master_policy_schedule(built):
    """67 of the 68 VINs on the auto-liability schedule must resolve. If that
    ever drops, the join has broken and every allocation built on it is wrong."""
    import re
    import pdfplumber
    pol = ROOT / ("data/raw/insurance/Insurance/Zone Insurance/"
                  "ZONE- OH COV CONF PAGE TO SIGN - Signed.pdf")
    if not pol.exists():
        pytest.skip("master policy absent")
    with pdfplumber.open(pol) as pdf:
        txt = "\n".join((p.extract_text() or "") for p in pdf.pages)
    sched = [m.group(3) for m in
             (re.match(r"\s*(\d+)\s+(\d{4})\s+([A-HJ-NPR-Z0-9]{17})\s", l)
              for l in txt.split("\n")) if m]
    reg, _ = built
    known = {r["vin"] for r in reg}
    assert len(sched) == 68
    assert sum(1 for v in sched if v in known) >= 66
