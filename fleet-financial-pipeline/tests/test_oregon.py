"""Controls on the Oregon weight-mile returns, which are SCANNED IMAGES.

OCR invents digits, so nothing it reads is trusted until it ties. The form
states its tax three times -- machine stamp, miles x rate, box total -- and
agreement between them is the whole control.
"""
import sys
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import parse_oregon as OR      # noqa: E402

pytestmark = pytest.mark.skipif(not OR.OREGON_DIR.exists(),
                                reason="Oregon returns absent")


@pytest.fixture(scope="module")
def rs():
    return OR.load()


def test_the_returns_read_at_all(rs):
    """Zero extractable text on every page: a text reader returns nothing and
    raises nothing, which is the silent failure this module exists to end."""
    assert len(rs) >= 10
    assert {r["carrier"] for r in rs} >= {"ZONE OH LLC", "XTRACK LLC"}


def test_an_unreadable_cell_is_zero_not_missing():
    """OCR renders a blank odometer as `Lt)`, `is)` or a bare `)`. Treating those
    as missing drops the row -- and since most rows ARE zero, a reader that
    dropped every row would still 'tie' against a nil total."""
    for t in ("0", ")", "Lt)", "is)", "it)", "ft)", "", "|"):
        assert OR.cell(t) == 0.0
    assert OR.cell("1,431") == 1431.0
    assert OR.cell("312") == 312.0


def test_the_tax_is_read_from_the_column_not_from_position():
    """`0.2512) 359 47` -- the column rule survives as a bare `)` token, and
    positional reading took it as the dollars and `359` as the cents, reporting
    $359.47 as $0.35."""
    rows = OR.parse_rows("YP95529 |CA 1509 |FRcH (80000 0 1431 0.2512) 359 47")
    assert len(rows) == 1
    assert rows[0]["miles"] == 1431
    assert rows[0]["rate"] == 0.2512
    assert rows[0]["tax"] == pytest.approx(359.47, abs=0.01)


def test_any_bracket_shape_on_the_weight_cell_is_accepted():
    """`(80000`, `{80000`, `|80000` -- requiring one shape dropped XTRACK's only
    taxable row of July 2026."""
    for br in ("(", "{", "[", "|", ""):
        rows = OR.parse_rows(f"O02KT1G |MO 8093 |vo.v {br}80000 0 1245 0.2512) 312 74")
        assert len(rows) == 1, br
        assert rows[0]["tax"] == pytest.approx(312.74, abs=0.01)


def test_miles_times_rate_equals_the_tax_on_every_row(rs):
    """The form's own arithmetic, and the strongest per-row OCR check."""
    for r in rs:
        for row in r["rows"]:
            assert row["miles"] * row["rate"] == pytest.approx(row["tax"], abs=0.02)


def test_the_three_statements_of_the_tax_agree_or_are_reported(rs):
    """Where they disagree the return is flagged, never averaged."""
    for r in rs:
        got = {k: r[k] for k in ("stamp_tax", "box_tax", "rows_tax")
               if r[k] is not None}
        if len(got) > 1 and max(got.values()) - min(got.values()) > OR.TIE:
            assert r["disagreements"], r["source"]


def test_the_printed_total_beats_the_reconstructed_one(rs):
    """A continuation sheet that OCRs badly makes the row sum UNDERSTATE; the
    box total is printed by Oregon and does not move."""
    for r in rs:
        if r["stamp_tax"] is not None:
            assert r["tax_from"] == "stamp_tax"
        elif r["box_tax"] is not None:
            assert r["tax_from"] == "box_tax"
        assert r["tax"] >= r["rows_tax"] - OR.TIE


def test_a_return_that_parsed_no_rows_is_not_treated_as_nil(rs):
    for r in rs:
        if r["vehicle_rows"] == 0:
            assert r["disagreements"]


def test_oregon_miles_tie_to_the_ohio_ifta_return(rs):
    """Three OCR'd scans against a text PDF filed with a different state. If
    this holds, both the returns and the reading of them are right."""
    q = OR.quarter_miles(rs)
    assert "2026Q1" in q
    mine, theirs, _ = q["2026Q1"]
    assert abs(mine - theirs) <= 5, (mine, theirs)
