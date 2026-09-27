"""Controls on the Motive live-API scaffold.

No network and no real key here, same reasoning as test_pull_relay_fuel.py:
this exercises read_token()'s env-over-file precedence and error messages,
the response-shape parsing (mocked against Motive's own documented response,
not a real account -- see pull_motive.py's docstring for that caveat), unit
conversion, and the documented 3-month range cap.
"""
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
sys.path.insert(0, str(ROOT / "analysis"))

import pull_motive as PM  # noqa: E402


def test_the_local_fallback_file_can_never_be_committed():
    key = ROOT / "config/motive_credentials.json"
    r = subprocess.run(["git", "check-ignore", str(key)],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, "config/motive_credentials.json is NOT gitignored"


def test_missing_credentials_fail_with_setup_instructions(monkeypatch, tmp_path):
    monkeypatch.setattr(PM, "CREDS_FILE", tmp_path / "absent.json")
    monkeypatch.delenv(PM.ENV_VAR, raising=False)
    with pytest.raises(SystemExit) as e:
        PM.read_token()
    msg = str(e.value)
    assert PM.ENV_VAR in msg
    assert "never paste a token into a chat session" in msg


def test_env_var_wins_over_the_fallback_file(monkeypatch, tmp_path):
    creds = tmp_path / "motive_credentials.json"
    creds.write_text('{"token": "from-file"}')
    monkeypatch.setattr(PM, "CREDS_FILE", creds)
    monkeypatch.setenv(PM.ENV_VAR, "from-env")
    assert PM.read_token() == "from-env"


def test_dist_to_miles_converts_only_when_the_vehicle_is_metric():
    assert PM.dist_to_miles(10.0, metric_units=True) == pytest.approx(10.0 / 1.609344, abs=0.01)
    assert PM.dist_to_miles(10.0, metric_units=False) == pytest.approx(10.0)
    assert PM.dist_to_miles(None, metric_units=True) is None


FAKE_PAGE_1 = {
    "ifta_trips": [
        {"ifta_trip": {"jurisdiction": "CA", "distance": 100.0,
                       "vehicle": {"id": 4, "number": "289904", "metric_units": False}}},
        {"ifta_trip": {"jurisdiction": "NV", "distance": 16.0934,
                       "vehicle": {"id": 4, "number": "289904", "metric_units": True}}},
    ],
    "pagination": {"per_page": 2, "page_no": 1, "total": 3},
}
FAKE_PAGE_2 = {
    "ifta_trips": [
        {"ifta_trip": {"jurisdiction": "AZ", "distance": 50.0,
                       "vehicle": {"id": 5, "number": "15852", "metric_units": False}}},
    ],
    "pagination": {"per_page": 2, "page_no": 2, "total": 3},
}


def test_pull_ifta_summary_pages_and_converts_units(monkeypatch):
    calls = []

    def fake_get(token, path, params=None):
        calls.append(dict(params))
        return FAKE_PAGE_1 if params["page_no"] == 1 else FAKE_PAGE_2

    monkeypatch.setattr(PM, "_get", fake_get)
    rows = PM.pull_ifta_summary("tok", "2026-09-14", "2026-09-21")
    assert len(calls) == 2, "must fetch page 2 -- total(3) exceeds page 1's 2 rows"
    assert {r["unit_number"] for r in rows} == {"289904", "15852"}
    nv = next(r for r in rows if r["jurisdiction"] == "NV")
    assert nv["miles"] == pytest.approx(16.0934 / 1.609344, abs=0.01)  # metric -> miles
    ca = next(r for r in rows if r["jurisdiction"] == "CA")
    assert ca["miles"] == pytest.approx(100.0)  # already miles, untouched


def test_a_date_range_over_three_months_is_refused_not_sent():
    """Motive's own documented constraint on /v1/ifta/summary. A caller
    wanting a year has to loop by quarter -- this must say so, not let a
    silently-truncated or rejected wide request through."""
    with pytest.raises(SystemExit, match="3 month"):
        PM.pull_ifta_summary("tok", "2026-01-01", "2026-12-31")


def test_to_mileage_rows_matches_state_tax_engine_shape():
    rows = [{"unit_number": "289904", "jurisdiction": "OH", "miles": 120.0,
             "motive_vehicle_id": 4}]
    out = PM.to_mileage_rows(rows, company="ZONE", period="2026-09-14")
    assert out == [{"company": "ZONE", "period": "2026-09-14", "unit": "289904",
                    "state": "OH", "miles": 120.0}]

    import state_tax_engine as E  # noqa: E402
    report = E.unit_state_report(out, gallons_state={},
                                 rate_state={"OH": {"base": 0.47, "surcharge": 0.0}}, mpg=6.5)
    assert report[0]["state"] == "OH" and report[0]["ifta_tax"] != 0.0


def test_a_row_missing_unit_or_jurisdiction_is_dropped_not_guessed():
    rows = [{"unit_number": None, "jurisdiction": "OH", "miles": 10.0},
            {"unit_number": "100", "jurisdiction": None, "miles": 10.0},
            {"unit_number": "100", "jurisdiction": "OH", "miles": None}]
    assert PM.to_mileage_rows(rows, "ZONE", "2026-09-14") == []
