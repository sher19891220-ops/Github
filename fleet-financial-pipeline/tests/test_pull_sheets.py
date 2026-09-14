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
    file nobody opens.

    Every reader that has its own MASTER-first fallback (maintenance_ledger.py,
    parse_truckmax_invoices.py) names the exact path it expects the pull to
    land on -- checked against those constants directly, not just the two
    dicts below, so a drift in either place is still caught."""
    sys.path.insert(0, str(ROOT / "analysis"))
    sys.path.insert(0, str(ROOT / "ingest"))
    import ingest_weekly_pnl as W
    import truck_breakeven as B
    import maintenance_ledger as ML
    import parse_truckmax_invoices as PT
    known = ({str(p.relative_to(ROOT)) for p in
             (ML.MASTER, PT.MASTER)}
            | set(W.WORKBOOKS.values()) | set(B.WORKBOOK.values()))
    targets = {s["path"] for s in PS.SHEETS.values()}
    assert targets & known, "no pulled workbook is one the pipeline reads"
    for s in PS.SHEETS.values():
        assert s["path"].startswith("data/raw/"), s
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
    monkeypatch.delenv(PS.ENV_VAR, raising=False)
    with pytest.raises(SystemExit) as e:
        PS.read_credentials()
    msg = str(e.value)
    assert "service account" in msg.lower()
    assert "Share" in msg or "share" in msg


# ---------------------------------------------------------------------------
# The key comes from an environment variable so it survives a container
# reclaim. Every test below is about a paste going wrong, because a mangled key
# otherwise surfaces as an unreadable-key error from the crypto layer that says
# nothing about what happened.

@pytest.fixture(scope="module")
def key():
    """A REAL RSA key: a fake string would prove only that our own code ran,
    not that google.oauth2 can actually build credentials from the result."""
    import json
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    pem = rsa.generate_private_key(public_exponent=65537, key_size=2048
                                   ).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()).decode()
    return {"type": "service_account", "project_id": "fleet-test",
            "private_key_id": "abc", "private_key": pem,
            "client_email": "fleet-reader@fleet-test.iam.gserviceaccount.com",
            "client_id": "1", "token_uri": "https://oauth2.googleapis.com/token"}


def _env(monkeypatch, value):
    monkeypatch.setenv(PS.ENV_VAR, value)
    monkeypatch.setattr(PS, "CREDS", Path("/nonexistent/key.json"))


def test_raw_json_and_base64_both_load(key, monkeypatch):
    import base64, json
    raw = json.dumps(key)
    for form in (raw, base64.b64encode(raw.encode()).decode()):
        _env(monkeypatch, form)
        creds, email = PS.read_credentials()
        assert email == key["client_email"]
        assert creds is not None


def test_the_json_escaped_private_key_is_repaired(key, monkeypatch):
    """The JSON form of a PEM carries literal backslash-n. Passing that through
    unrepaired gives an unreadable key and a useless error."""
    import json
    mangled = dict(key, private_key=key["private_key"].replace("\n", "\\n"))
    _env(monkeypatch, json.dumps(mangled))
    _, email = PS.read_credentials()
    assert email == key["client_email"]


def test_a_key_whose_newlines_became_spaces_is_refused_by_name(key, monkeypatch):
    """Unrecoverable, and the message has to say so -- silently proceeding
    produces a crypto error that names nothing."""
    import json
    broken = dict(key, private_key=key["private_key"].replace("\n", " "))
    _env(monkeypatch, json.dumps(broken))
    with pytest.raises(SystemExit) as e:
        PS.read_credentials()
    assert "newlines" in str(e.value) and "base64" in str(e.value)


def test_a_truncated_paste_is_caught_here_not_four_calls_later(key, monkeypatch):
    """Missing fields must be named now, not surface as 'invalid_grant' from
    inside an OAuth exchange."""
    import json
    _env(monkeypatch, json.dumps({k: v for k, v in key.items()
                                  if k != "client_email"}))
    with pytest.raises(SystemExit) as e:
        PS.read_credentials()
    assert "client_email" in str(e.value)


def test_the_wrong_file_is_named_as_the_wrong_file(monkeypatch):
    """An OAuth client secret looks plausible and is not a service account."""
    import json
    _env(monkeypatch, json.dumps({"web": {"client_id": "x"}}))
    with pytest.raises(SystemExit) as e:
        PS.read_credentials()
    assert "missing" in str(e.value)


def test_garbage_names_the_command_that_produces_the_right_thing(monkeypatch):
    _env(monkeypatch, "this is neither json nor base64")
    with pytest.raises(SystemExit) as e:
        PS.read_credentials()
    assert "base64" in str(e.value)


def test_no_error_message_ever_contains_key_material(key, monkeypatch):
    """A stack trace or error string carrying the private key would leak it into
    logs, transcripts and terminal scrollback."""
    import json
    secret = key["private_key"]
    for bad in (json.dumps(dict(key, private_key=secret.replace("\n", " "))),
                json.dumps({k: v for k, v in key.items() if k != "type"}),
                "not-a-key-at-all"):
        _env(monkeypatch, bad)
        with pytest.raises(SystemExit) as e:
            PS.read_credentials()
        body = str(e.value)
        assert "PRIVATE KEY" not in body
        assert secret[100:160] not in body


def test_the_environment_beats_the_file(key, monkeypatch, tmp_path):
    """The container is ephemeral; the env var is the durable one. A stale file
    left over from an older setup must not silently win."""
    import json
    f = tmp_path / "key.json"
    f.write_text(json.dumps(dict(key, client_email="stale@old.iam.gserviceaccount.com")))
    monkeypatch.setattr(PS, "CREDS", f)
    monkeypatch.setenv(PS.ENV_VAR, json.dumps(key))
    _, email = PS.read_credentials()
    assert email == key["client_email"]


def test_local_mtime_is_none_when_the_workbook_is_absent(tmp_path, monkeypatch):
    """After a container reclaim every local copy is gone, and absent must read
    as NEW rather than as up to date."""
    monkeypatch.setattr(PS, "ROOT", tmp_path)
    assert PS.local_mtime("data/raw/pnl/nothing.xlsx") is None
