"""Controls on the registration parse and its reconciliation to the bank.

The failures worth guarding are the ones that already happened: reading a
correct proration as an error, calling a duplicated row a duplicate payment,
and matching a sheet line to a bank debit on amount alone.
"""
import json
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


def test_responsibility_corrects_the_two_mistyped_units(parsed):
    """5852 and 5417 resolve to no VIN in the fleet registry at all -- both are
    one or two digits off a real truck (15852, 5091), operator-confirmed
    2026-09-10. Before the correction both fall into "NOT IN THE FLEET
    REGISTRY"; after it, neither should."""
    payments, _, _ = parsed
    by_bearer, detail, _ = G.attribute_by_responsibility(payments, G.unit_index())
    corrected_units = {d[0] for d in detail}
    assert "5852" not in corrected_units and "5417" not in corrected_units
    assert "15852" in corrected_units and "5091" in corrected_units


def test_responsibility_charges_owner_operators_not_the_company(parsed):
    """5091 (formerly mistyped as 5417) is a ZONE-operated owner-operator
    truck. The company must not bear its IRP/HVUT -- the owner does."""
    payments, _, _ = parsed
    by_bearer, detail, _ = G.attribute_by_responsibility(payments, G.unit_index())
    row = next(d for d in detail if d[0] == "5091")
    assert row[2] == "OWNER-OPERATOR (self-pay)"
    assert by_bearer["OWNER-OPERATOR (self-pay)"] > 0


def test_responsibility_charges_the_named_investor(parsed):
    """3898, 1365 and 1596 belong to investor Sher Imam, operator-confirmed
    2026-09-10 -- not to whichever company's P&L last carried them. 1365 and
    1596's own $2,212.23 each includes half of a REAL sheet defect (see
    test_the_duplicate_row_is_not_charged_twice_to_the_investor below), so
    the correct figure here is lower than the raw per_unit() total."""
    payments, _, _ = parsed
    by_bearer, detail, _ = G.attribute_by_responsibility(payments, G.unit_index())
    for u in ("3898", "1365", "1596"):
        row = next(d for d in detail if d[0] == u)
        assert row[2] == "INVESTOR: Sher Imam"
    assert by_bearer["INVESTOR: Sher Imam"] == pytest.approx(
        1006.92 + 1381.1133 + 1381.1133, abs=0.01)


def test_the_duplicate_row_is_not_charged_twice_to_the_investor(parsed):
    """CLAUDE.md already documents this as a real, bank-confirmed sheet
    defect: the $2,493.34 IRP payment for units 1365/1564/1596 is printed
    TWICE in the source sheet, but only one debit ever left the bank -- 'the
    row is duplicated, no money was lost.' R.per_unit() sums every row as
    printed and inherits the double-count; attribute_by_responsibility()
    must not pass that on to a real person (here, an investor) as if it
    were real money spent twice."""
    payments, _, _ = parsed
    raw = R.per_unit(payments)
    deduped = G.deduplicated_per_truck(payments)
    for u in (1365, 1564, 1596):
        assert deduped[u]["total"] == pytest.approx(raw[u]["total"] - 831.1133, abs=0.01)
    # A truck outside the flagged duplicate must be untouched.
    assert deduped[3898]["total"] == pytest.approx(raw[3898]["total"], abs=0.01)


def test_responsibility_splits_the_remaining_pool_equally_not_by_last_pnl(parsed):
    """The default for everything not an owner-operator's, an investor's, or a
    pending lease-to-purchase truck: an equal three-way split, replacing
    attribute()'s 'whichever company ran it last' rule for this specific
    question -- operator-confirmed 2026-09-10."""
    payments, _, _ = parsed
    by_bearer, _, pool = G.attribute_by_responsibility(payments, G.unit_index())
    assert by_bearer["ZONE"] == by_bearer["XTRACK"] == by_bearer["AFG"]
    assert by_bearer["ZONE"] == pytest.approx(pool["per_company"], abs=0.01)
    assert pool["pool"] > 0


def test_responsibility_total_reconciles_to_actual_plus_the_stated_ltp_markup(parsed):
    """Every bucket except lease-to-purchase uses the truck's own actual,
    deduplicated registration cost, so the grand total across all bearers
    must equal the deduplicated actual total PLUS whatever the stated
    $2,430/unit lease-to-purchase rate adds on top of those five trucks'
    own actual cost -- nothing invented or dropped, the one deliberate
    markup is named and traceable."""
    payments, _, _ = parsed
    deduped = G.deduplicated_per_truck(payments)
    by_bearer, _, pool = G.attribute_by_responsibility(payments, G.unit_index())
    actual_total = sum(v["total"] for v in deduped.values())
    markup = sum(stated - actual for _, actual, stated in pool["ltp_rate_comparison"])
    assert sum(by_bearer.values()) == pytest.approx(actual_total + markup, abs=0.01)


def test_responsibility_charges_lease_to_purchase_owners_a_stated_flat_rate(parsed):
    """1564, 4718, 1682, 4857 and 5413 belong to lease-to-purchase owners,
    operator-confirmed 2026-09-10: 'those driver will be responsible for
    hvut cost which is 550$ each and irp amonut that is 1880$ each unit' --
    a STATED $2,430/unit rate, not each truck's own actual registration
    cost (which varies by weight/mileage apportionment). 8671 is excluded
    from this bucket on purpose: it is ALSO an owner-operator truck, and the
    operator said explicitly to deduct it from Owner-Operators instead, so
    it must not be double-counted here."""
    payments, _, _ = parsed
    by_bearer, detail, pool = G.attribute_by_responsibility(payments, G.unit_index())
    for u in ("1564", "4718", "1682", "4857", "5413"):
        row = next(d for d in detail if d[0] == u)
        assert row[2] == "LEASE-TO-PURCHASE OWNER (self-pay)"
        assert row[1] == pytest.approx(2430.0, abs=0.01)
    row_8671 = next(d for d in detail if d[0] == "8671")
    assert row_8671[2] == "OWNER-OPERATOR (self-pay)"
    assert by_bearer["LEASE-TO-PURCHASE OWNER (self-pay)"] == pytest.approx(2430.0 * 5, abs=0.01)
    assert len(pool["ltp_rate_comparison"]) == 5


def test_responsibility_charges_a_departed_owner_operator_to_nobody_running(parsed):
    """7584 was an owner-operator's truck; that driver quit the company long
    ago, operator-confirmed 2026-09-10 ('do not count him'). Excluded like a
    sold truck -- not the company's cost, and not spread over the running
    fleet either, since he is not an active operator to spread it over."""
    payments, _, _ = parsed
    by_bearer, detail, _ = G.attribute_by_responsibility(payments, G.unit_index())
    row = next(d for d in detail if d[0] == "7584")
    assert row[2] == "DEPARTED OWNER-OPERATOR (not affiliated)"
    assert by_bearer["DEPARTED OWNER-OPERATOR (not affiliated)"] == pytest.approx(
        2826.40, abs=0.01)
    assert "OWNER-OPERATOR (self-pay)" not in {d[2] for d in detail if d[0] == "7584"}


def test_responsibility_charges_a_sold_truck_to_its_new_owner_even_off_registry(parsed):
    """Truck 4851 never appears in the fleet registry at all -- title passed
    to Alphonse Jefferson (lease-to-own 'sold', per CLAUDE.md) who is no
    longer affiliated with the company, so the group unit workbook never
    carried it. Unlike 5852/5417 there is no typo to correct; the operator
    named the truck directly. It must resolve WITHOUT a fleet-registry match,
    and must never fall into NOT IN THE FLEET REGISTRY or the equal-split
    pool."""
    payments, _, _ = parsed
    by_bearer, detail, _ = G.attribute_by_responsibility(payments, G.unit_index())
    row = next(d for d in detail if d[0] == "4851")
    assert row[2] == "SOLD: Alphonse Jefferson (paid off, not affiliated)"
    assert row[1] == pytest.approx(2606.53, abs=0.01)
    assert "NOT IN THE FLEET REGISTRY" not in by_bearer


def test_responsibility_does_not_guess_the_unresolved_investor_unit(parsed):
    """4546 (stated as Sher Imam's) matches no VIN in the fleet registry and no
    unit in the registration payments at all -- unlike 5852/5417, it has no
    exact one-digit-off match this corpus can confirm, so it must not be
    silently substituted for anything, including the similarly-numbered 4553
    that IS in both."""
    cfg = json.loads((ROOT / "config/registration_responsibility.json").read_text())
    assert "4546" in cfg["investor_owned"]["Sher Imam"]["unresolved_units"]
    assert "4546" not in cfg["investor_owned"]["Sher Imam"]["resolved_units"]
