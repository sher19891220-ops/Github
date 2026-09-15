"""Unit tests for ingest/pull_samsara.py's pure logic -- the unit conversion
and credential-reading paths, which don't need network access. The actual
HTTP calls are exercised by hand against the real API (see the module's own
docstring), the same as ingest/pull_quickmanage.py, which has no test file
either -- an external API's live behavior isn't something a mock can prove.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
import pull_samsara as S  # noqa: E402


def test_m_to_mi_known_conversion():
    # 1609.344 meters is exactly one mile.
    assert S.m_to_mi(1609.344) == pytest.approx(1.0)


def test_m_to_mi_matches_confirmed_real_reading():
    # Unit 449248's real obdOdometerMeters from the 2026-09-15 test call.
    assert S.m_to_mi(690207510) == pytest.approx(428875.1, abs=0.1)


def test_m_to_mi_none_passes_through():
    assert S.m_to_mi(None) is None


def test_read_token_missing_raises_systemexit(monkeypatch, tmp_path):
    monkeypatch.delenv(S.ENV_VAR, raising=False)
    monkeypatch.setattr(S, "CREDS_FILE", tmp_path / "does_not_exist.json")
    with pytest.raises(SystemExit):
        S.read_token()


def test_read_token_from_env_var(monkeypatch):
    monkeypatch.setenv(S.ENV_VAR, "samsara_api_test_token_only_for_this_test")
    assert S.read_token() == "samsara_api_test_token_only_for_this_test"


def test_read_token_env_var_never_echoed_in_error(monkeypatch, tmp_path, capsys):
    """The error path for a missing token must name where it looked, never
    a token value -- there is none to leak here, but the message itself
    must not be built from anything that could contain one."""
    monkeypatch.delenv(S.ENV_VAR, raising=False)
    monkeypatch.setattr(S, "CREDS_FILE", tmp_path / "missing.json")
    with pytest.raises(SystemExit) as exc:
        S.read_token()
    assert "samsara_api" not in str(exc.value)
    assert S.ENV_VAR in str(exc.value)
