"""Controls on the Iron Lease invoice parse.

Every case here is a parse that has already produced a wrong number.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
sys.path.insert(0, str(ROOT / "analysis"))
import parse_iron_lease_invoices as P
import iron_lease as A

INV = ROOT / "data/raw/iron/invoices"
pytestmark = pytest.mark.skipif(not INV.exists(), reason="Iron Lease invoices absent")


@pytest.fixture(scope="module")
def invoices():
    return P.load()


def test_the_unicode_minus_is_a_negative(invoices):
    # '−$407.15' uses U+2212. Read as a hyphen-less positive it flips a credit
    # into a charge and breaks the invoice by twice its value.
    assert P.money("−$407.15") == -407.15
    assert P.money("-$407.15") == -407.15
    assert P.money("$407.15") == 407.15


def test_a_credit_signed_on_the_rate_is_still_a_credit():
    """Ten invoices sign the RATE, not the qty: '1 −$77.73 −$77.73'. A rate
    pattern allowing no sign DROPS the line silently rather than mis-adding it."""
    line = "3. EFS money code #15852 coolant on 09.06.25 1 −$77.73 −$77.73"
    inv = P.parse_text(line, "t")
    assert len(inv["lines"]) == 1
    assert inv["lines"][0]["amount"] == -77.73
    assert inv["lines"][0]["category"] == "efs_credit"


def test_an_item_number_alone_on_its_line_still_makes_an_item():
    """One invoice prints '13.' and the body on the next line. Without folding
    them the body joins item 12's description and a $1,016.25 credit vanishes."""
    text = "12. Repair #15852 Oil change 1 −$874.00 −$874.00\n13.\nRepair #15852 Engine oil 1 −$1,016.25 −$1,016.25"
    inv = P.parse_text(text, "t")
    assert [L["amount"] for L in inv["lines"]] == [-874.0, -1016.25]


def test_every_invoice_reconciles_to_its_printed_total(invoices):
    bad = []
    for v in invoices:
        s = sum(L["amount"] for L in v["lines"])
        if abs(s - v["total"]) > 0.01:
            bad.append((Path(v["source"]).name, round(s - v["total"], 2)))
    assert not bad, bad


def test_total_plus_payment_equals_balance_due(invoices):
    for v in invoices:
        assert abs(v["total"] + v["payment"] - v["balance_due"]) <= 0.01, v["source"]


def test_no_line_is_left_uncategorised(invoices):
    other = [(Path(v["source"]).name, L["desc"][:50])
             for v in invoices for L in v["lines"] if L["category"] == "other"]
    assert not other, other


def test_the_one_source_level_qty_rate_swap_is_normalised(invoices):
    """AFG 07.31.26 prints the per-mile rate in the Qty column. The Amount is
    right so the total still ties -- only a per-mile figure goes wrong."""
    swapped = [L for v in invoices for L in v["lines"]
               if L.get("qty_rate_swapped_at_source")]
    assert len(swapped) == 1
    L = swapped[0]
    assert L["qty"] == 1151.0 and L["rate"] == 0.12
    assert abs(L["qty"] * L["rate"] - L["amount"]) < 0.01


def test_mileage_rates_are_plausible_per_mile_figures(invoices):
    rates = {L["rate"] for v in invoices for L in v["lines"]
             if L["category"] == "mileage" and L.get("period_start")}
    assert rates <= {0.10, 0.12}, rates


def test_credits_are_negative_and_charges_positive(invoices):
    for v in invoices:
        for L in v["lines"]:
            if L["category"] in A.CREDIT:
                assert L["amount"] <= 0, (v["source"], L)
            if L["category"] == "rent":
                assert L["amount"] > 0, (v["source"], L)


def test_every_invoice_names_the_company_billed(invoices):
    assert all(v["entity"] in ("ZONE", "XTRACK", "AFG") for v in invoices)


def test_the_invoices_are_not_settled_in_cash(invoices):
    """The finding, pinned. If deposits ever start matching invoice totals, the
    relationship has changed and every 'book charge, not cash' claim built on
    this must be revisited."""
    import pandas as pd
    txn = ROOT / "data/processed/iron_lease_transactions.csv"
    if not txn.exists():
        pytest.skip("Iron Lease bank transactions not parsed")
    r = A.cash_test(invoices, pd.read_csv(txn))
    assert r["invoices_in_bank_window"] >= 60
    assert r["with_a_matching_deposit"] <= 0.15 * r["invoices_in_bank_window"], r
    assert r["round_thousand_deposits"] >= 0.6 * r["deposits"], r
