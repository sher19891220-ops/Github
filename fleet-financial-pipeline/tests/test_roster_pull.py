"""The roster pull, exercised without the API.

The credential is not available in every environment, and the paging is the
part most likely to be wrong: an earlier probe of this API read page 0 only
and reported its 100-record page as a fleet of 221. These tests drive
search_all against fake endpoints that page correctly, page short, and ignore
the page parameter entirely.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ingest import pull_quickmanage as q


def fake_pages(total, honour_page=True, page_size=None):
    size = page_size or q.PAGE_SIZE
    recs = [{"id": i, "unit": f"U{i}", "in_service_date": "2025-01-01"} for i in range(total)]
    calls = []

    def search(token, endpoint, body=None):
        body = body or {}
        calls.append(body.get("page"))
        if not honour_page:
            return {"data": recs[:size]}          # always page 0
        start = body.get("page", 0) * size
        return {"data": recs[start:start + size]}

    return search, calls


def run(monkeypatched_search):
    original = q.search
    q.search = monkeypatched_search
    try:
        return q.search_all("tok", "/x/trucks/search")
    finally:
        q.search = original


def test_pages_past_the_first():
    # The exact bug that produced "221 trucks": one page is not the fleet.
    search, calls = fake_pages(221)
    got = run(search)
    assert len(got) == 221, f"expected 221, paged only {len(got)}"
    assert calls[:3] == [0, 1, 2]


def test_exact_multiple_of_page_size_is_not_truncated():
    search, _ = fake_pages(200)
    assert len(run(search)) == 200


def test_short_first_page_stops_immediately():
    search, calls = fake_pages(7)
    assert len(run(search)) == 7
    assert calls == [0]


def test_empty_roster():
    search, _ = fake_pages(0)
    assert run(search) == []


def test_endpoint_that_ignores_page_does_not_spin():
    # Returns a full page forever. Must terminate on "nothing new" rather
    # than run to MAX_PAGES and return 50,000 duplicates.
    search, calls = fake_pages(500, honour_page=False)
    got = run(search)
    assert len(got) == q.PAGE_SIZE, f"deduped to {len(got)}"
    assert len(calls) == 2, f"kept paging {len(calls)} times against a stuck endpoint"


def test_roster_rows_reads_the_documented_shape():
    recs = [{"unit": "8083", "vin": "1X", "owner_id": "z1", "status": "active",
             "in_service_date": "2025-03-04", "make": "Volvo", "year": 2021}]
    rows, no_unit = q.roster_rows("ZONE_OH", recs, "truck")
    assert no_unit == 0
    assert rows[0]["unit_number"] == "8083"
    assert rows[0]["in_service_date"] == "2025-03-04"
    assert rows[0]["unit_type"] == "truck"
    assert rows[0]["company"] == "ZONE_OH"


def test_a_record_with_no_unit_number_is_counted_not_dropped_silently():
    rows, no_unit = q.roster_rows("AFG", [{"vin": "1X"}, {"unit": "12"}], "truck")
    assert len(rows) == 1 and no_unit == 1


def test_missing_in_service_date_is_empty_not_invented():
    rows, _ = q.roster_rows("AFG", [{"unit": "12"}], "truck")
    assert rows[0]["in_service_date"] == ""
