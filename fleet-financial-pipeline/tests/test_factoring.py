"""Controls on the Triumph invoice lists.

Every guard here is a mistake the file actively invites: a self-doubling total
row, an exception list that overlaps the full list, and a placeholder invoice
number used as an identity.
"""
import sys
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import parse_factoring as F      # noqa: E402
import factoring as A            # noqa: E402

pytestmark = pytest.mark.skipif(
    not F.FACTORING[0].exists(), reason="factoring invoice lists absent")


@pytest.fixture(scope="module")
def loaded():
    return F.load()


def test_the_total_row_is_not_an_invoice(loaded):
    """Each sheet ends with a row labelled 'Totals' carrying the grand total in
    the amount column. Summing the sheet as read gives exactly TWICE the real
    figure -- and it looks right, because it is the number the file prints."""
    rows, controls = loaded
    for r in rows:
        assert str(r.get("Invoice") or "").strip().lower() != "totals"
    ties = [c for c in controls if c["ties"]]
    assert ties, "no sheet tied to its own printed total"
    for c in ties:
        assert c["detail"] == pytest.approx(c["printed_total"], abs=0.01)


def test_a_placeholder_invoice_number_is_not_an_identity(loaded):
    """Two different invoices are both numbered 'TBD' -- one Rejected at $5,200
    and one Held at $1,700. De-duplicating on that number merged them and lost
    the Held invoice entirely."""
    rows, _ = loaded
    tbd = [r for r in rows if str(r.get("Invoice") or "").strip().upper() == "TBD"]
    assert len(tbd) == 2
    assert {r["Status"] for r in tbd} == {"Rejected", "Held"}


def test_overlapping_files_are_not_double_counted(loaded):
    """The exception lists repeat invoices from the full list."""
    rows, _ = loaded
    real = [r for r in rows
            if str(r.get("Invoice") or "").strip().upper() not in F.PLACEHOLDER_IDS]
    keys = [(r["entity"], str(r["Invoice"]).strip()) for r in real]
    assert len(keys) == len(set(keys))


def test_every_invoice_is_attributed_to_a_company(loaded):
    """The entity is printed above the header, not in a column."""
    rows, _ = loaded
    assert {r["entity"] for r in rows} <= {"ZONE", "XTRACK", "AFG"}
    assert None not in {r["entity"] for r in rows}


def test_funded_is_never_folded_into_paid(loaded):
    """Funded means Triumph advanced; Paid means the debtor settled. On a
    recourse facility that is a different party carrying the risk."""
    rows, _ = loaded
    st = F.by_status(rows)
    assert "Funded" in st and "Paid" in st
    assert "Funded" not in F.SETTLED and "Funded" not in F.AT_RISK


def test_at_risk_is_every_status_that_is_not_paid_or_funded(loaded):
    rows, _ = loaded
    st = F.by_status(rows)
    accounted = set(F.SETTLED) | {"Funded"} | set(F.AT_RISK)
    assert set(st) <= accounted, set(st) - accounted
    risky = F.at_risk(rows)
    assert sum(r["amount"] or 0 for r in risky) > 0


def test_a_sheet_that_does_not_tie_is_reported_as_a_floor(loaded):
    """One sheet's detail is $11,350 below the total it prints, so rows are
    missing from it. The failure is surfaced, never silently accepted."""
    _, controls = loaded
    off = [c for c in controls if not c["ties"] and c["printed_total"] is not None]
    for c in off:
        assert c["detail"] < c["printed_total"]


def test_the_week_key_matches_the_pnl_tab_convention():
    import datetime as dt
    assert F.week_of(dt.datetime(2026, 6, 3)) == "2026-06-01"   # a Wednesday
    assert F.week_of(dt.datetime(2026, 6, 1)) == "2026-06-01"   # the Monday
    assert F.week_of("not a date") is None


def test_the_revenue_comparison_only_covers_weeks_the_file_holds(loaded):
    """Outside the invoice list's own span the comparison measures the file's
    edges, not the sheet."""
    rows, _ = loaded
    w = A.weekly("XTRACK", rows)
    assert w
    for k, _, _ in w:
        assert A.COVERED[0] <= k <= A.COVERED[1]


def test_credit_denials_concentrate_on_one_customer(loaded):
    """If this ever stops being true it is a finding, not a broken test."""
    rows, _ = loaded
    top = A.concentration(rows)
    assert top
    name, (n, amt) = top[0]
    assert name.upper().startswith("STL")
    total = sum(a for _, (_, a) in top)
    assert amt / total > 0.5
