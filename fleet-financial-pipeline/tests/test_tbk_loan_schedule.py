"""Controls on the two TBK equipment-finance loan schedules for Iron Lease,
and the bank cross-check that corrects a real overstatement in the
$332,431 'TBK equipment finance' figure CLAUDE.md had quoted from the bank
alone -- two of the recurring ACH debits bounced and were returned, then
were re-collected days later, and looked like two real payments if the
return credit was never matched against them.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
sys.path.insert(0, str(ROOT / "analysis"))
import parse_tbk_loan_schedule as TBK    # noqa: E402
import iron_lease as IL                  # noqa: E402

pytestmark = pytest.mark.skipif(
    not TBK.load_all(), reason="the TBK loan schedules are absent")


@pytest.fixture(scope="module")
def loans():
    return {l["loan_id"]: l for l in TBK.load_all()}


def test_both_loans_are_found_and_pass_their_own_controls(loans):
    assert set(loans) == {"400722502", "400725362"}
    for loan in loans.values():
        assert not TBK.controls(loan), (loan["loan_id"], TBK.controls(loan))


def test_loan_terms_match_the_documents(loans):
    a, b = loans["400722502"], loans["400725362"]
    assert a["principal"] == 453585.00
    assert a["annual_rate_pct"] == 8.96
    assert a["n_payments"] == 36
    assert a["monthly_payment"] == 14443.50
    assert b["principal"] == 632985.00
    assert b["annual_rate_pct"] == 9.02
    assert b["n_payments"] == 24
    assert b["monthly_payment"] == 28963.77


def test_grand_totals_match_the_schedules_own_printed_totals(loans):
    """Each schedule prints its own grand total; the parsed rows must sum to
    it exactly, in both interest and principal, not just in total payment."""
    a = loans["400722502"]
    assert sum(r["interest"] for r in a["rows"]) == pytest.approx(66381.00, abs=0.02)
    assert sum(r["principal"] for r in a["rows"]) == pytest.approx(453585.00, abs=0.02)
    b = loans["400725362"]
    assert sum(r["interest"] for r in b["rows"]) == pytest.approx(62145.48, abs=0.02)
    assert sum(r["principal"] for r in b["rows"]) == pytest.approx(632985.00, abs=0.02)


def test_paid_through_only_returns_rows_up_to_the_cutoff(loans):
    a = loans["400722502"]
    through = TBK.paid_through(a, "2026-07-03")
    assert len(through) == 15
    assert through[-1]["date"] == "07/03/2026"


IRON_TXN = ROOT / "data/processed/iron_lease_transactions.csv"
pytestmark_bank = pytest.mark.skipif(
    not IRON_TXN.exists(), reason="Iron Lease's own bank feed is absent")


@pytestmark_bank
def test_the_bounced_payment_is_found_and_excluded(loans):
    """Both bounces (May 2025, June 2026) have a same-amount RETURN OF
    POSTED CHECK credit 1 day later -- confirmed against the raw bank feed
    directly, not assumed. Neither may be counted as a real payment."""
    r = IL.tbk_financing()
    assert len(r["bounced"]) == 2
    assert set(r["bounced"].txn_date.dt.strftime("%Y-%m-%d")) == {"2025-05-05", "2026-06-03"}


@pytestmark_bank
def test_the_overstatement_is_exactly_two_bounced_payments(loans):
    r = IL.tbk_financing()
    assert r["overstatement"] == pytest.approx(14443.50 * 2, abs=0.01)
    assert r["real_total"] == pytest.approx(r["raw_debit_total"] - 14443.50 * 2, abs=0.01)


@pytestmark_bank
def test_confirmed_payments_reconcile_to_the_schedules_own_balance(loans):
    """The number of bank-confirmed payments, run back through the loan's
    own schedule, must land on that schedule's own printed balance for that
    payment number -- the strongest check available: an independent record
    (the bank) landing exactly on a document it never saw (the schedule)."""
    r = IL.tbk_financing()
    by_id = {l["loan_id"]: l for l in r["loans"]}
    a = by_id["400722502"]
    assert a["payments_confirmed"] == 15
    assert a["remaining_balance"] == pytest.approx(279395.89, abs=0.01)
    b = by_id["400725362"]
    assert b["payments_confirmed"] == 3
    assert b["remaining_balance"] == pytest.approx(559973.97, abs=0.01)


@pytestmark_bank
def test_remaining_obligation_is_the_full_unpaid_schedule(loans):
    """Every future payment is a real, contractual cash obligation -- not
    priced anywhere else in this pipeline's cost model. Interest + principal
    on the unpaid rows must equal the loan's own remaining cash exactly."""
    r = IL.tbk_financing()
    for loan in r["loans"]:
        implied = round(loan["remaining_cash_obligation"], 2)
        parts = round(loan["remaining_interest"] +
                      (loan["principal"] - loan["principal_paid_confirmed"]), 2)
        assert implied == pytest.approx(parts, abs=0.02)
