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
