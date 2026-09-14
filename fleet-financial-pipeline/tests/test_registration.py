"""Controls on the registration parse and its reconciliation to the bank.

The failures worth guarding are the ones that already happened: reading a
correct proration as an error, calling a duplicated row a duplicate payment,
and matching a sheet line to a bank debit on amount alone.
"""
import sys
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
sys.path.insert(0, str(ROOT / "analysis"))
warnings.filterwarnings("ignore")

import parse_irp as R          # noqa: E402
import registration as G       # noqa: E402


@pytest.fixture(scope="module")
def parsed():
    return R.read()


def test_the_parse_reconciles(parsed):
    payments, red, reference = parsed
    fails, _ = R.controls(payments, red, reference)
    assert not fails, fails


def test_every_hvut_group_is_a_whole_number_of_trucks_at_550(parsed):
    """The control that makes the unit lists checkable against the money."""
    payments, _, _ = parsed
    groups = [p for p in payments if p["section"] == "hvut" and len(p["units"]) > 1]
    assert len(groups) == 6
    for p in groups:
        assert p["amount"] == pytest.approx(R.HVUT_ANNUAL * len(p["units"]))


def test_a_prorated_hvut_is_not_an_error(parsed):
    """Unit 7584 paid $458.33, exactly 10/12 of $550. A control that tests only
    for whole trucks calls that a bad parse and stops the analysis."""
    payments, red, reference = parsed
    one = next(p for p in payments
               if p["section"] == "hvut" and len(p["units"]) == 1)
    assert one["amount"] == pytest.approx(R.HVUT_ANNUAL * 10 / 12, abs=0.01)
    fails, notes = R.controls(payments, red, reference)
    assert not fails
    assert any("PRORATION" in n for n in notes)


def test_the_stated_grand_total_is_the_one_that_is_wrong(parsed):
    """The itemization prorates 7584's HVUT and the bottom-line total does not,
    so they differ by exactly 2/12 of $550. The itemized figure is right."""
    payments, red, reference = parsed
    got = R.grand_total(payments, red)
    stated = reference["Bottom grand total shown"]
    assert stated - got == pytest.approx(R.HVUT_ANNUAL * 2 / 12, abs=0.01)


def test_the_stated_hvut_total_is_the_groups_plus_the_second_year(parsed):
    payments, red, reference = parsed
    groups = sum(p["amount"] for p in payments
                 if p["section"] == "hvut" and len(p["units"]) > 1)
    assert groups + red["amount"] == pytest.approx(reference["HVUT TAX ALL 25/26"])


def test_duplicates_key_on_the_set_of_units_not_the_printed_order(parsed):
    """The two $2,493.34 rows list the same three trucks in different orders.
    Comparing the cell text calls them different payments."""
    payments, _, _ = parsed
    dups = R.duplicates(payments)
    assert len(dups) == 1
    a, b = dups[0]
    assert a["units"] != b["units"]                 # printed order differs
    assert set(a["units"]) == set(b["units"]) == {1365, 1564, 1596}


def test_units_are_never_scraped_from_the_note_column():
    """`10 trucks together` and dollar figures live in the Note column. A digit
    grab over the row invents trucks."""
    assert R.units("10 trucks together") == []
    assert R.units("2703, 4772, 15739") == [2703, 4772, 15739]
    assert R.units(None) == []


def test_the_flagged_duplicate_is_a_duplicated_row_not_a_double_payment(parsed):
    """The whole point of reconciling to the bank. One debit, two rows."""
    payments, red, _ = parsed
    matched, _, _, _ = G.reconcile(payments, red)
    a = next(p for p in payments if p["label"] == "IRP Payment A")
    hits = [r for _, r in matched if abs(r.amt - a["amount"]) < 0.005]
    assert len(hits) == 1


def test_the_real_duplicate_is_the_prorated_hvut(parsed):
    """$458.33 debited by the IRS twice, thirteen days apart, for one truck."""
    payments, red, _ = parsed
    _, _, _, dupes = G.reconcile(payments, red)
    amounts = {round(a, 2) for _, a, _ in dupes}
    assert 458.33 in amounts


def test_a_repeated_flat_hvut_is_not_a_duplicate(parsed):
    """HVUT is $550 a truck. Three $550 debits are three trucks, and flagging
    them turns the fleet's ordinary registration into a fake finding."""
    payments, red, _ = parsed
    _, _, _, dupes = G.reconcile(payments, red)
    for leg, amt, _ in dupes:
        if leg == "hvut":
            assert abs(amt / R.HVUT_ANNUAL - round(amt / R.HVUT_ANNUAL)) > 0.005


def test_matching_never_leaves_the_vendors_own_rows():
    """$1,100 matches eleven bank rows and $5,500 five -- Zelle payments, wires
    and mobile deposits. Amount-only matching confirms payments that never
    happened."""
    import pandas as pd
    bank = G.bank_rows()
    all_rows = pd.read_csv(G.BANK)
    for v in (1100.0, 5500.0):
        loose = (all_rows.amount.abs().round(2) == v).sum()
        tight = sum((pool.amt == v).sum() for pool in bank.values())
        assert tight < loose


def test_registration_is_attributed_by_who_last_ran_the_truck(parsed):
    payments, _, _ = parsed
    by_co, unresolved, stale = G.attribute(R.per_unit(payments), G.unit_index())
    for co in ("ZONE", "XTRACK", "AFG"):
        assert by_co[co] > 0
    # Reported, never spread over the companies that do run.
    assert "NO COMPANY ON ANY P&L" in by_co


def test_a_truck_never_on_a_pnl_is_not_reported_as_having_stopped(parsed):
    """It is already in the NO COMPANY bucket. Counting it twice reads as a
    fleet shrinking that never grew."""
    payments, _, _ = parsed
    _, _, stale = G.attribute(R.per_unit(payments), G.unit_index())
    for u, (v, wk, co) in stale.items():
        assert wk and co
