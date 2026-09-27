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


def test_read_token_missing_returns_none_not_an_exception(monkeypatch, tmp_path):
    """The normal case as of 2026-09-27: Samsara is set up in this
    environment as a host-based API credential (environment settings), not a
    plain env var -- read_token() must return None so the caller falls
    through to sending no auth header and letting the environment's proxy
    inject the real one, never raise as if that were a setup error."""
    monkeypatch.delenv(S.ENV_VAR, raising=False)
    monkeypatch.setattr(S, "CREDS_FILE", tmp_path / "does_not_exist.json")
    assert S.read_token() is None


def test_read_token_from_env_var(monkeypatch):
    monkeypatch.setenv(S.ENV_VAR, "samsara_api_test_token_only_for_this_test")
    assert S.read_token() == "samsara_api_test_token_only_for_this_test"


def test_get_sends_no_auth_header_when_token_is_none(monkeypatch):
    """token=None must not send an empty/placeholder Authorization header --
    that would risk colliding with the environment proxy's own injected
    header for api.samsara.com."""
    captured = {}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"data": []}

    def fake_get(url, params=None, headers=None, timeout=None):
        captured["headers"] = headers
        return FakeResp()

    monkeypatch.setattr(S.requests, "get", fake_get)
    S._get(None, "/fleet/vehicles/stats")
    assert captured["headers"] == {}
