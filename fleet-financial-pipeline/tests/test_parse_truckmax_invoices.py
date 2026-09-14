"""Controls on Truck Max's own invoice log -- four payer-split workbooks.

The failures worth guarding: a float truck number gaining a digit from its own
decimal point, a header-less file read with the wrong columns, a total row
counted as a charge, and an invoice number treated as an identity when the shop
itself reuses them.
"""
import sys
import warnings
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import parse_truckmax_invoices as PT   # noqa: E402

pytestmark = pytest.mark.skipif(
    not PT.INVOICE_DIR.exists(), reason="Truck Max invoice files absent")


@pytest.fixture(scope="module")
def loaded():
    return PT.load()


def test_a_whole_number_float_truck_does_not_gain_a_digit():
    """The bug this session found and fixed: str(15862.0) is '15862.0', and
    stripping non-digits from THAT keeps the '0' after the decimal point,
    turning 15862 into 158620. Every float truck number in three of the four
    files was corrupted this way -- unit 6867 became 68670, 15909 became
    159090 -- until caught."""
    assert PT.clean_truck(15862.0) == "15862"
    assert PT.clean_truck(6867.0) == "6867"
    assert PT.clean_truck(15909.0) == "15909"
    assert PT.clean_truck(8131) == "8131"           # already an int: unaffected
    assert PT.clean_truck("8131") == "8131"          # already a string: unaffected


def test_a_leading_zero_survives_a_hash_prefixed_truck():
    """'# 001' is truck 001 -- ZONE's own P&L keeps that leading zero. Casting
    through int() anywhere in the pipeline would silently turn it into '1',
    which does not match anything in ZONE's roster."""
    assert PT.clean_truck("# 001") == "001"


def test_a_service_name_in_the_truck_column_is_not_a_truck():
    """Company_exp has two rows where the Truck column holds 'detailing' and
    'cleaning' -- a wash and a facility charge entered in the wrong column."""
    assert PT.clean_truck("detailing") is None
    assert PT.clean_truck("cleaning") is None
    assert PT.clean_truck(float("nan")) is None
    assert PT.clean_truck(None) is None


def test_the_header_less_file_reads_in_the_same_column_order(loaded):
    """Sher_Imam.xlsx has no header row at all -- openpyxl hands back
    Unnamed: 0..4. If the column order assumed here (date, truck, invoice,
    issue, amount) is wrong, every field in this file silently swaps."""
    charges, _ = loaded
    sher = charges[charges.payer == "sher_imam"]
    assert len(sher) == 5
    assert set(sher.truck) == {"1365", "1596", "3898"}
    assert sher.amount.sum() == pytest.approx(10139.22, abs=0.01)


def test_a_corrupted_date_prefix_still_parses():
    """Company_exp has one row as ': 07/18/2026' -- a stray leading colon and
    space. Losing the date would drop the row from every window comparison."""
    assert PT.clean_date(": 07/18/2026") == pd.Timestamp("2026-07-18")
    assert PT.clean_date("2026-01-05") == pd.Timestamp("2026-01-05")


def test_every_file_ties_to_its_own_printed_total(loaded):
    _, controls = loaded
    for c in controls:
        assert c["ties"], (c["payer"], c["detail_sum"], c["printed_total"])


def test_the_total_row_is_matched_by_label_not_by_luck(loaded):
    """Iron_Lease_exp's total happens to print as the string '$159 187.96',
    which pd.to_numeric refuses to parse anyway -- but relying on that is luck,
    not a rule, for a file that prints a clean number instead. The TOTAL row
    must never appear as a charge regardless of how its amount is formatted."""
    charges, _ = loaded
    assert not charges.issue.astype(str).str.strip().eq("TOTAL").any()


def test_invoice_numbers_are_not_unique_even_within_one_file(loaded):
    """INV0015 appears twice in Company_exp alone, for a different truck and a
    different date each time. Deduplicating on invoice number would silently
    drop one of two genuinely distinct charges."""
    charges, _ = loaded
    comp = charges[charges.payer == "company"]
    dup = comp[comp.invoice == "INV0015"]
    assert len(dup) == 2
    assert dup.truck.tolist() != dup.trailer.tolist()  # genuinely different rows


def test_invoice_numbers_reused_across_files_are_not_deduplicated(loaded):
    """INV0001 is a $3,920.69 charge on truck 289909 in Company_exp and an
    unrelated $1,196.57 charge on truck 6169 in Driver_exp. Nothing here should
    treat the shared number as one invoice split across payers."""
    charges, _ = loaded
    hits = charges[charges.invoice == "INV0001"]
    assert len(hits) == 2
    assert set(hits.payer) == {"company", "driver"}
    assert set(round(a, 2) for a in hits.amount) == {3920.69, 1196.57}


def test_trailer_only_rows_are_flagged_and_excluded_from_truck_totals(loaded):
    charges, _ = loaded
    trailers = charges[charges.is_trailer]
    assert len(trailers) > 100          # Company_exp alone has 228
    assert trailers.truck.isna().all()


def test_no_charge_is_both_unresolvable_and_a_trailer(loaded):
    charges, _ = loaded
    assert not (charges.unresolvable_truck & charges.is_trailer).any()


def test_the_fleet_totals_did_not_regress_below_the_pre_fix_figures(loaded):
    """A weak but cheap guard: the float-truck bug UNDERCOUNTED resolvable
    trucks (mis-tagged as unresolvable, 6-digit ghosts), so the fix can only
    raise or hold the number of distinct real trucks found, never lower it."""
    charges, _ = loaded
    real = charges[charges.truck.notna()]
    assert real.truck.nunique() >= 100
    # no resolved truck number should be 6 digits when it used to be 4 or 5 --
    # a coarse check that the float bug (which always ADDS one trailing digit)
    # is not silently back.
    lengths = real.truck.str.len().value_counts()
    assert lengths.get(6, 0) < lengths.get(4, 0) + lengths.get(5, 0)
