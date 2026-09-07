"""Controls on pulling the P&L workbooks from Google Sheets.

No network and no credentials here: these guard the things that would be
expensive to discover live -- a key committed to git, a half-written workbook
that parses cleanly with fewer weeks, and a pointless rewrite that invalidates
every cached parse.
"""
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))

import pull_sheets as PS   # noqa: E402


def test_the_service_account_key_can_never_be_committed():
    """A service account key in git history is a real leak, and the file is
    created by hand later -- so the ignore rule has to already be right."""
    key = ROOT / "config/gsheets_service_account.json"
    r = subprocess.run(["git", "check-ignore", str(key)],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, "config/gsheets_service_account.json is NOT gitignored"


def test_read_only_scope():
    """A service account that can only read cannot damage the book the business
    runs on, however wrong this code turns out to be."""
    assert PS.SCOPES == ["https://www.googleapis.com/auth/drive.readonly"]
    assert all("readonly" in s for s in PS.SCOPES)


def test_every_sheet_lands_on_a_path_the_pipeline_already_reads():
    """The point of exporting to .xlsx: nothing downstream changes. If a path
    here drifts from the one the readers use, the refresh silently updates a
    file nobody opens."""
    sys.path.insert(0, str(ROOT / "analysis"))
    import ingest_weekly_pnl as W
    import truck_breakeven as B
    known = set(W.WORKBOOKS.values()) | set(B.WORKBOOK.values())
    targets = {s["path"] for s in PS.SHEETS.values()}
    assert targets & known, "no pulled workbook is one the pipeline reads"
    for s in PS.SHEETS.values():
        assert s["path"].startswith("data/raw/pnl/"), s
        assert s["path"].endswith(".xlsx"), s


def test_the_export_is_xlsx_because_the_week_is_only_in_the_tab_name():
    """A CSV or text export loses the tab names, and with them the entire time
    axis of the corpus."""
    assert PS.XLSX.endswith("spreadsheetml.sheet")


def test_sheet_ids_are_distinct_and_look_like_drive_ids():
    ids = [s["id"] for s in PS.SHEETS.values()]
    assert len(ids) == len(set(ids))
    for i in ids:
        assert len(i) > 25 and "/" not in i, i


def test_missing_credentials_fail_with_the_setup_instructions(monkeypatch, tmp_path):
    """The failure a new container hits first. It must say what to do, not
    raise a FileNotFoundError from inside a Google library."""
    monkeypatch.setattr(PS, "CREDS", tmp_path / "absent.json")
    with pytest.raises(SystemExit) as e:
        PS.service()
    msg = str(e.value)
    assert "service account" in msg.lower()
    assert "Share" in msg or "share" in msg


def test_local_mtime_is_none_when_the_workbook_is_absent(tmp_path, monkeypatch):
    """After a container reclaim every local copy is gone, and absent must read
    as NEW rather than as up to date."""
    monkeypatch.setattr(PS, "ROOT", tmp_path)
    assert PS.local_mtime("data/raw/pnl/nothing.xlsx") is None
