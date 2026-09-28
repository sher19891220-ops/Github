"""Controls on the read-only DispatchHQ connection.

No network here: these guard the things that would be expensive or dangerous
to discover live -- a connection string committed to git, and this module
ever sending anything but a SELECT to a database it does not own.
"""
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))

import pull_dispatchhq as D  # noqa: E402


def test_the_connection_string_can_never_be_committed():
    """A live database password in git history is a real leak, and the file
    is created by hand later -- so the ignore rule has to already be right."""
    creds = ROOT / "config/dispatchhq_credentials.json"
    r = subprocess.run(["git", "check-ignore", str(creds)],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, "config/dispatchhq_credentials.json is NOT gitignored"


def test_missing_credentials_fail_with_the_setup_instructions(monkeypatch, tmp_path):
    monkeypatch.setattr(D, "CREDS", tmp_path / "absent.json")
    monkeypatch.delenv(D.ENV_VAR, raising=False)
    with pytest.raises(SystemExit) as e:
        D.read_credentials()
    msg = str(e.value)
    assert D.ENV_VAR in msg
    assert "config/dispatchhq_credentials.example.json" in msg


def test_the_environment_beats_the_file(monkeypatch, tmp_path):
    f = tmp_path / "key.json"
    f.write_text('{"database_url": "postgresql://stale@old/db"}')
    monkeypatch.setattr(D, "CREDS", f)
    monkeypatch.setenv(D.ENV_VAR, "postgresql://real@live/db")
    url, where = D.read_credentials()
    assert url == "postgresql://real@live/db"
    assert where == f"${D.ENV_VAR}"


def test_a_truncated_file_names_the_missing_field(monkeypatch, tmp_path):
    f = tmp_path / "key.json"
    f.write_text("{}")
    monkeypatch.setattr(D, "CREDS", f)
    monkeypatch.delenv(D.ENV_VAR, raising=False)
    with pytest.raises(SystemExit) as e:
        D.read_credentials()
    assert "database_url" in str(e.value)


@pytest.mark.parametrize("bad_sql", [
    "DELETE FROM load_entries",
    "UPDATE drivers SET name = 'x'",
    "INSERT INTO weeks VALUES (1)",
    "DROP TABLE dispatcher_history",
    "; SELECT 1",
])
def test_run_query_refuses_anything_but_a_select(bad_sql):
    """The one guard against this module ever writing to a database it does
    not own, independent of whatever board_viewer's own grant allows."""
    class FakeCursor:
        def execute(self, *a, **k):
            raise AssertionError("execute() must never be reached for a non-SELECT")
    with pytest.raises(ValueError, match="non-SELECT"):
        D.run_query(FakeCursor(), bad_sql)


@pytest.mark.parametrize("good_sql", [
    "SELECT * FROM load_entries",
    "  select 1",
    "WITH x AS (SELECT 1) SELECT * FROM x",
])
def test_run_query_allows_select_and_with(good_sql):
    class FakeCursor:
        def execute(self, sql, params=None):
            self.sql = sql
        def fetchall(self):
            return []
    cur = FakeCursor()
    assert D.run_query(cur, good_sql) == []


def test_known_tables_match_the_operators_list():
    """Pinned so a future session can tell at a glance which tables are the
    ones actually named 2026-09-28, versus anything else board_viewer can see."""
    assert D.KNOWN_TABLES == ("load_entries", "drivers", "weeks",
                              "dispatcher_history", "sub_truck_periods",
                              "hidden_week_periods")


# ----------------------------------------------------------------- REST mode

import base64  # noqa: E402
import json  # noqa: E402


def _jwt(role):
    body = base64.urlsafe_b64encode(json.dumps({"role": role}).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJIUzI1NiJ9.{body}.sig"


@pytest.fixture
def rest_env(monkeypatch, tmp_path):
    monkeypatch.setattr(D, "CREDS", tmp_path / "absent.json")
    monkeypatch.setenv(D.REST_URL_VAR, "https://proj.supabase.co/")
    monkeypatch.setenv(D.REST_KEY_VAR, _jwt("board_viewer"))
    return monkeypatch


@pytest.mark.parametrize("method", ["POST", "PATCH", "PUT", "DELETE", "post"])
def test_rest_refuses_every_write_method_before_the_wire(rest_env, method):
    """PostgREST writes are POST/PATCH/PUT/DELETE -- none may leave this module."""
    import requests
    rest_env.setattr(requests, "request",
                     lambda *a, **k: pytest.fail("request must never be sent"))
    with pytest.raises(ValueError, match="read-only"):
        D.rest_request(method, "load_entries")


@pytest.mark.parametrize("key", [_jwt("service_role"), "sb_secret_abc123"])
def test_rest_refuses_keys_that_bypass_rls(rest_env, key):
    rest_env.setenv(D.REST_KEY_VAR, key)
    with pytest.raises(SystemExit) as e:
        D.read_rest_credentials()
    assert "service_role" in str(e.value)
    assert key not in str(e.value)


def test_rest_requires_https(rest_env):
    rest_env.setenv(D.REST_URL_VAR, "http://proj.supabase.co")
    with pytest.raises(SystemExit, match="https://"):
        D.read_rest_credentials()


def test_rest_missing_credentials_name_both_variables(monkeypatch, tmp_path):
    monkeypatch.setattr(D, "CREDS", tmp_path / "absent.json")
    monkeypatch.delenv(D.REST_URL_VAR, raising=False)
    monkeypatch.delenv(D.REST_KEY_VAR, raising=False)
    with pytest.raises(SystemExit) as e:
        D.read_rest_credentials()
    assert D.REST_URL_VAR in str(e.value) and D.REST_KEY_VAR in str(e.value)


def test_rest_file_fallback(monkeypatch, tmp_path):
    f = tmp_path / "key.json"
    f.write_text(json.dumps({"supabase_url": "https://p.supabase.co",
                             "supabase_key": "sb_publishable_x"}))
    monkeypatch.setattr(D, "CREDS", f)
    monkeypatch.delenv(D.REST_URL_VAR, raising=False)
    monkeypatch.delenv(D.REST_KEY_VAR, raising=False)
    assert D.read_rest_credentials()[:2] == ("https://p.supabase.co", "sb_publishable_x")


def test_rest_get_sends_key_headers_and_strips_trailing_slash(rest_env):
    import requests
    seen = {}

    def fake(method, url, params=None, headers=None, timeout=None):
        seen.update(method=method, url=url, headers=headers)
        return "ok"
    rest_env.setattr(requests, "request", fake)
    D.rest_request("GET", "/load_entries")
    assert seen["method"] == "GET"
    assert seen["url"] == "https://proj.supabase.co/rest/v1/load_entries"
    assert seen["headers"]["apikey"] == seen["headers"]["Authorization"][7:]


def test_publishable_key_is_not_sent_as_a_bearer_token(rest_env):
    import requests
    rest_env.setenv(D.REST_KEY_VAR, "sb_publishable_abc")
    seen = {}
    rest_env.setattr(requests, "request",
                     lambda m, u, **k: seen.update(k["headers"]) or "ok")
    D.rest_request("GET", "weeks")
    assert "Authorization" not in seen and seen["apikey"] == "sb_publishable_abc"


def test_rest_tables_falls_back_to_probing_the_named_tables(rest_env):
    """Newer Supabase projects may hide the schema document from non-admin
    keys -- --tables must still report the six operator-named tables."""
    class R:
        def __init__(self, status, cr=""):
            self.status_code, self.headers, self.ok, self.text = status, {"Content-Range": cr}, status < 400, ""
    rest_env.setattr(D, "rest_openapi", lambda: None)
    rest_env.setattr(D, "rest_request",
                     lambda m, t, **k: R(200, "*/42") if t == "drivers" else R(401))
    rows = {n: (c, s) for n, _, c, s in D.rest_list_tables()}
    assert set(rows) == set(D.KNOWN_TABLES)
    assert rows["drivers"] == (42, 200)
    assert rows["weeks"] == (None, 401)
