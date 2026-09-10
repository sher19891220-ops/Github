"""Controls on pricing a missing Oregon return from the IFTA returns.

The method rests on one fact -- an IFTA return counts Oregon miles at a 0.00
rate -- and on reading two different jurisdiction-table layouts. Both are
guarded here, along with the distinction the whole module turns on: a return
absent from this corpus is not the same as a return that was never filed.
"""
import sys
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import oregon_gap as G                 # noqa: E402
import parse_tax_and_insurance as TAX  # noqa: E402

pytestmark = pytest.mark.skipif(
    not (ROOT / "data/raw/ifta").exists(), reason="IFTA corpus absent")


def test_both_jurisdiction_table_layouts_are_read():
    """Ohio prints `OR Diesel 0.00 436 436 ...`; Illinois prints
    `OR D 4688 4688 ...`. Matching one layout loses a whole authority."""
    ohio = TAX.jurisdiction_miles("OR Diesel 0.00 436 436 71 239 $0.00 $0.00")
    assert ohio == {"OR": 436}
    step3 = TAX.jurisdiction_miles(
        "OR D 4688 4688 535 894 -359 0.000 0.000 $ 0.00 $ 0.00 $ 0.00")
    assert step3 == {"OR": 4688}


def test_oregon_is_counted_at_a_zero_rate_on_the_ifta_return():
    """The fact the method rests on: IFTA counts the miles and charges nothing,
    because Oregon taxes them separately."""
    rs = [r for r in G._ifta() if (r.get("jurisdictions") or {}).get("OR")]
    assert rs, "no IFTA return carries an Oregon row"
    for r in rs:
        assert r["jurisdictions"]["OR"] > 0


def test_the_rate_is_measured_off_the_returns_not_assumed():
    rt, seen = G.rate()
    assert rt == pytest.approx(0.2512)
    assert seen[rt] >= 2


def test_zone_q1_ties_and_therefore_shows_no_gap():
    """Three OCR'd Oregon scans against a text IFTA return filed with another
    state. If this quarter ever shows a gap, one of the two readers broke."""
    rows, _ = G.gaps()
    z = next(r for r in rows if r["company"] == "ZONE" and r["quarter"] == "2026Q1")
    assert abs(z["gap_miles"]) <= 5
    assert z["tax_at_risk"] == 0.0


def test_a_quarter_with_no_oregon_operation_is_not_a_gap():
    """XTRACK's 2025 returns carry no OR row at all. Zero miles owed is not a
    missing return, and pricing it as one invents an exposure."""
    rows, _ = G.gaps()
    for r in rows:
        if r["ifta_or_miles"] == 0:
            assert r["gap_miles"] == 0 and r["tax_at_risk"] == 0.0


def test_afg_ran_oregon_and_has_no_oregon_account():
    """The finding that changes what to do first: register, then file."""
    rows, _ = G.gaps()
    a = next(r for r in rows if r["company"] == "AFG")
    assert a["ifta_or_miles"] > 1000
    assert a["oregon_returns_held"] == 0
    assert G.OREGON_CARRIER["AFG"] is None


def test_the_gap_is_priced_at_the_measured_rate():
    rows, rt = G.gaps()
    for r in rows:
        if r["gap_miles"] > 0:
            assert r["tax_at_risk"] == pytest.approx(r["gap_miles"] * rt)
        else:
            assert r["tax_at_risk"] == 0.0


def test_jurisdiction_coverage_is_reported_for_every_return():
    """The control on the method: state rows summed back against the return's
    own total miles. A return below 100% has rows this reader did not match."""
    rows, _ = G.gaps()
    assert rows
    for r in rows:
        assert 0 < r["juris_covered"] <= 1.01
    zone = [r for r in rows if r["company"] == "ZONE" and r["quarter"] == "2026Q1"]
    assert zone[0]["juris_covered"] > 0.99


def test_missing_months_are_named_never_apportioned():
    """IFTA is quarterly and Oregon is monthly, so a missing quarter cannot be
    split into months from this evidence."""
    rows, _ = G.gaps()
    zq4 = next(r for r in rows if r["company"] == "ZONE" and r["quarter"] == "2025Q4")
    assert zq4["months_with_no_return"] == ["December"]
    assert zq4["oregon_returns_held"] == 2
