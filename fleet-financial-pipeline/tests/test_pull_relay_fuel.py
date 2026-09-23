"""Controls on the Relay Payments live-API scaffold.

No network and no real key here: this only exercises read_credentials()'s
env-over-file precedence and its error messages -- the two things that are
knowable without Relay's own (unreachable) API docs. whoami()/parse_transaction()
hit the network or raise NotImplementedError by design and are not covered here.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))

import pull_relay_fuel as RF   # noqa: E402


def test_the_local_fallback_file_can_never_be_committed():
    """A Relay API key in git history is a real leak, and the file is
    created by hand later -- so the ignore rule has to already be right."""
    key = ROOT / "config/relay_payments_credentials.json"
    r = subprocess.run(["git", "check-ignore", str(key)],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, "config/relay_payments_credentials.json is NOT gitignored"


def test_row_fields_match_ingest_rails_load_relay_shape():
    """parse_transaction() must return exactly the same keys load_relay()
    already produces from Relay's .xlsx exports -- a live-pulled row and a
    file-exported row have to be interchangeable downstream."""
    sys.path.insert(0, str(ROOT / "ingest"))
    import inspect
    import ingest_rails as IR
    src = inspect.getsource(IR.load_relay)
    for field in RF.ROW_FIELDS:
        assert f'"{field}"' in src, f"{field!r} missing from ingest_rails.load_relay()"


def test_missing_credentials_fail_with_setup_instructions(monkeypatch, tmp_path):
    """The failure a new container hits first. It must say what to do, not
    raise a raw exception from inside urllib."""
    monkeypatch.setattr(RF, "CREDS", tmp_path / "absent.json")
    monkeypatch.delenv(RF.ENV_VAR_PROD, raising=False)
    with pytest.raises(SystemExit) as e:
        RF.read_credentials()
    msg = str(e.value)
    assert RF.ENV_VAR_PROD in msg
    assert "relay_payments_credentials" in msg


def test_missing_staging_credentials_name_the_staging_env_var(monkeypatch, tmp_path):
    monkeypatch.setattr(RF, "CREDS", tmp_path / "absent.json")
    monkeypatch.delenv(RF.ENV_VAR_STAGING, raising=False)
    with pytest.raises(SystemExit) as e:
        RF.read_credentials(use_staging=True)
    assert RF.ENV_VAR_STAGING in str(e.value)


def _env(monkeypatch, value, use_staging=False):
    var = RF.ENV_VAR_STAGING if use_staging else RF.ENV_VAR_PROD
    monkeypatch.setenv(var, value)
    monkeypatch.setattr(RF, "CREDS", Path("/nonexistent/relay_payments_credentials.json"))


def test_the_environment_key_loads(monkeypatch):
    _env(monkeypatch, "iak_fake_test_key_not_real")
    key, where = RF.read_credentials()
    assert key == "iak_fake_test_key_not_real"
    assert where == f"${RF.ENV_VAR_PROD}"


def test_the_staging_environment_key_loads_separately(monkeypatch):
    _env(monkeypatch, "iak_fake_staging_key_not_real", use_staging=True)
    key, where = RF.read_credentials(use_staging=True)
    assert key == "iak_fake_staging_key_not_real"
    assert where == f"${RF.ENV_VAR_STAGING}"


def test_the_environment_beats_the_file(monkeypatch, tmp_path):
    """The container is ephemeral; the env var is the durable one. A stale
    file left over from an older setup must not silently win."""
    f = tmp_path / "relay_payments_credentials.json"
    f.write_text(json.dumps({"api_key": "iak_stale_file_key_not_real"}))
    monkeypatch.setattr(RF, "CREDS", f)
    monkeypatch.setenv(RF.ENV_VAR_PROD, "iak_fresh_env_key_not_real")
    key, where = RF.read_credentials()
    assert key == "iak_fresh_env_key_not_real"
    assert where == f"${RF.ENV_VAR_PROD}"


def test_the_file_is_used_when_the_env_var_is_unset(monkeypatch, tmp_path):
    f = tmp_path / "relay_payments_credentials.json"
    f.write_text(json.dumps({"api_key": "iak_file_only_key_not_real"}))
    monkeypatch.setattr(RF, "CREDS", f)
    monkeypatch.delenv(RF.ENV_VAR_PROD, raising=False)
    key, where = RF.read_credentials()
    assert key == "iak_file_only_key_not_real"
    assert where == str(f)


def test_malformed_json_file_is_named_as_invalid(monkeypatch, tmp_path):
    f = tmp_path / "relay_payments_credentials.json"
    f.write_text("this is neither json nor a key")
    monkeypatch.setattr(RF, "CREDS", f)
    monkeypatch.delenv(RF.ENV_VAR_PROD, raising=False)
    with pytest.raises(SystemExit) as e:
        RF.read_credentials()
    assert "not valid JSON" in str(e.value)


def test_file_missing_the_field_is_named_by_field(monkeypatch, tmp_path):
    f = tmp_path / "relay_payments_credentials.json"
    f.write_text(json.dumps({"staging_api_key": "iak_only_staging_not_real"}))
    monkeypatch.setattr(RF, "CREDS", f)
    monkeypatch.delenv(RF.ENV_VAR_PROD, raising=False)
    with pytest.raises(SystemExit) as e:
        RF.read_credentials()
    assert "api_key" in str(e.value)


def test_no_error_message_ever_contains_key_material(monkeypatch, tmp_path):
    """A stack trace or error string carrying the real key would leak it into
    logs, transcripts and terminal scrollback."""
    secret = "iak_super_secret_value_should_never_leak_ABCDEF123456"
    f = tmp_path / "relay_payments_credentials.json"
    f.write_text(json.dumps({"api_key": secret, "_junk": "not json"})[:-1])
    monkeypatch.setattr(RF, "CREDS", f)
    monkeypatch.delenv(RF.ENV_VAR_PROD, raising=False)
    with pytest.raises(SystemExit) as e:
        RF.read_credentials()
    assert secret not in str(e.value)

    empty_field_file = tmp_path / "empty_field.json"
    empty_field_file.write_text(json.dumps({"api_key": "  "}))
    monkeypatch.setattr(RF, "CREDS", empty_field_file)
    with pytest.raises(SystemExit) as e2:
        RF.read_credentials()
    assert secret not in str(e2.value)


def test_parse_transaction_refuses_to_guess_the_field_mapping():
    """This project's discipline: a guessed mapping is worse than a named
    gap. parse_transaction() must raise rather than silently map fields."""
    payload = {"id": "txn_123", "amount_cents": 5000}
    with pytest.raises(NotImplementedError) as e:
        RF.parse_transaction(payload)
    assert "txn_123" in str(e.value)
