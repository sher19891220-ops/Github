"""Unit tests for ingest/pull_quickmanage.py's search_all() pagination loop
-- the piece added 2026-09-15 to pull QuickManage's full trip/truck history
instead of stopping at page 0 (docs/FINDINGS.md: "ZONE_OH alone returned 221
trucks and 23,510 trips ... not yet driven past page 0 here"). This mocks
search() itself, since no live QuickManage credentials are available in this
environment to test the loop against the real API -- the same limit noted in
the module's own docstring. The HTTP/auth calls other than this loop are
exercised by hand against the live API, matching this project's existing
pattern for pull_quickmanage.py and pull_samsara.py, neither of which mocks
the network for their confirmed-working paths either.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
import pull_quickmanage as QM  # noqa: E402


def _fake_search(pages):
    """Returns a search(token, endpoint, body) stand-in that serves `pages`
    (a list of record-lists) in order, keyed by the 1-indexed page number in
    the request body -- so a call for a page beyond the list fails loudly
    (an IndexError) rather than silently looping forever."""
    def fake(token, endpoint, body=None):
        page = (body or {}).get("page", 1)
        return {"data": pages[page - 1]}
    return fake


def test_search_all_stops_on_short_final_page(monkeypatch):
    # page_size=2: two full pages of 2, then a short page of 1 -> exhausted.
    pages = [["a", "b"], ["c", "d"], ["e"]]
    monkeypatch.setattr(QM, "search", _fake_search(pages))
    records, warning = QM.search_all("tok", "/x/trips/search", page_size=2)
    assert records == ["a", "b", "c", "d", "e"]
    assert warning is None


def test_search_all_single_short_page(monkeypatch):
    pages = [["only-one"]]
    monkeypatch.setattr(QM, "search", _fake_search(pages))
    records, warning = QM.search_all("tok", "/x/trips/search", page_size=100)
    assert records == ["only-one"]
    assert warning is None


def test_search_all_empty_first_page(monkeypatch):
    pages = [[]]
    monkeypatch.setattr(QM, "search", _fake_search(pages))
    records, warning = QM.search_all("tok", "/x/trips/search", page_size=100)
    assert records == []
    assert warning is None


def test_search_all_respects_max_pages_cap(monkeypatch):
    # Every page comes back full (page_size records) forever -- without the
    # cap this would spin indefinitely.
    def always_full(token, endpoint, body=None):
        return {"data": ["x", "y"]}
    monkeypatch.setattr(QM, "search", always_full)
    records, warning = QM.search_all("tok", "/x/trips/search", page_size=2, max_pages=3)
    assert len(records) == 6  # 3 pages x 2 records
    assert warning is not None and "max_pages=3" in warning["warning"]


def test_search_all_passes_page_and_page_size_in_body(monkeypatch):
    seen = []

    def recording_search(token, endpoint, body=None):
        seen.append(dict(body))
        return {"data": []}

    monkeypatch.setattr(QM, "search", recording_search)
    QM.search_all("tok", "/x/trips/search", body={"filter": "active"}, page_size=50)
    assert seen == [{"filter": "active", "page": 1, "page_size": 50}]


def test_search_all_unknown_shape_returns_raw_payload(monkeypatch):
    def weird_shape(token, endpoint, body=None):
        return {"unexpected": "shape"}
    monkeypatch.setattr(QM, "search", weird_shape)
    records, payload = QM.search_all("tok", "/x/trips/search")
    assert records == []
    assert payload == {"unexpected": "shape"}
