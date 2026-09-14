"""Controls on the parser cache.

A cache that answers with stale numbers is worse than no cache: this pipeline
exists to be right, not fast. Every test here is about invalidation.
"""
import json
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))

import cache  # noqa: E402


@pytest.fixture
def files(tmp_path):
    a, b = tmp_path / "a.txt", tmp_path / "b.txt"
    a.write_text("one")
    b.write_text("two")
    return [a, b]


def test_a_changed_input_file_invalidates(files, monkeypatch, tmp_path):
    """The whole design. Re-upload a document and its size or mtime changes, so
    the entry misses and the parser runs -- no manual 'remember to clear the
    cache' step, because a step like that is forgotten exactly once."""
    monkeypatch.setattr(cache, "CACHE_DIR", tmp_path / "c")
    calls = []

    @cache.cached("t", lambda: files)
    def parse():
        calls.append(1)
        return {"n": len(calls)}

    assert parse() == {"n": 1}
    assert parse() == {"n": 1}          # served from cache, parser not re-run
    assert len(calls) == 1
    time.sleep(0.01)
    files[0].write_text("one changed")
    assert parse() == {"n": 2}          # re-read
    assert len(calls) == 2


def test_a_new_file_in_the_set_invalidates(files, monkeypatch, tmp_path):
    """A directory that gained a return since last time is a different corpus."""
    monkeypatch.setattr(cache, "CACHE_DIR", tmp_path / "c")
    current = list(files)
    calls = []

    @cache.cached("t2", lambda: current)
    def parse():
        calls.append(1)
        return len(calls)

    assert parse() == 1 and parse() == 1
    extra = files[0].parent / "c.txt"
    extra.write_text("three")
    current.append(extra)
    assert parse() == 2


def test_a_missing_file_is_part_of_the_identity(files, monkeypatch, tmp_path):
    """A corpus that LOST a document is not the same corpus, and after a
    container reclaim that is the normal case."""
    monkeypatch.setattr(cache, "CACHE_DIR", tmp_path / "c")
    before = cache.fingerprint(files)
    files[1].unlink()
    assert cache.fingerprint(files) != before


def test_arguments_are_part_of_the_key(monkeypatch, tmp_path):
    """One reader, many workbooks. Keying on the input files alone would serve
    ZONE's weeks for a call asking about XTRACK."""
    monkeypatch.setattr(cache, "CACHE_DIR", tmp_path / "c")

    @cache.cached("t3", lambda x: [])
    def parse(x):
        return {"got": x}

    assert parse("zone") == {"got": "zone"}
    assert parse("xtrack") == {"got": "xtrack"}


def test_a_broken_cache_entry_never_blocks_work(files, monkeypatch, tmp_path):
    """Corruption must degrade to slow, never to wrong or to a crash."""
    d = tmp_path / "c"
    monkeypatch.setattr(cache, "CACHE_DIR", d)

    @cache.cached("t4", lambda: files)
    def parse():
        return {"ok": True}

    assert parse() == {"ok": True}
    for f in d.glob("*.json"):
        f.write_text("{ not json")
    assert parse() == {"ok": True}


def test_the_env_switch_turns_it_off(files, monkeypatch, tmp_path):
    """FLEET_NO_CACHE=1 must reach the original parser, so a suspected stale
    answer can be checked against the documents without deleting anything."""
    monkeypatch.setattr(cache, "CACHE_DIR", tmp_path / "c")
    monkeypatch.setattr(cache, "DISABLE", True)
    calls = []

    @cache.cached("t5", lambda: files)
    def parse():
        calls.append(1)
        return len(calls)

    assert parse() == 1 and parse() == 2


def test_the_undecorated_parser_stays_reachable(files, monkeypatch, tmp_path):
    monkeypatch.setattr(cache, "CACHE_DIR", tmp_path / "c")

    @cache.cached("t6", lambda: files)
    def parse():
        return "fresh"

    assert parse.uncached() == "fresh"


def test_the_version_stamp_invalidates_everything(files, monkeypatch, tmp_path):
    """A code change that alters what a parser RETURNS is not visible in the
    input files -- it is the one invalidation the fingerprint cannot infer."""
    monkeypatch.setattr(cache, "CACHE_DIR", tmp_path / "c")
    calls = []

    @cache.cached("t7", lambda: files)
    def parse():
        calls.append(1)
        return len(calls)

    assert parse() == 1 and parse() == 1
    monkeypatch.setattr(cache, "VERSION", "999")
    assert parse() == 2
