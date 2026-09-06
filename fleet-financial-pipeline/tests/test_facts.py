"""Controls on the facts file.

A facts file is a cache of CONCLUSIONS, and a conclusion outliving its evidence
is exactly the error this pipeline exists to catch. Every test here is about
that, or about the facts matching the models they came from.
"""
import sys
import time
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import facts as F   # noqa: E402

pytestmark = pytest.mark.skipif(
    not (ROOT / "data/raw/pnl/88206141-Xtrack_LLC_download.xlsx").exists(),
    reason="P&L workbooks absent")


@pytest.fixture(scope="module")
def doc():
    d = F.load()
    if d is None:
        d = F.build()
    return d


def test_a_moved_corpus_makes_the_facts_stale(doc, tmp_path, monkeypatch):
    """The one thing that makes this dangerous. If a source file changes and the
    facts still read as current, every number served is a guess."""
    stale_now, _ = F.stale(doc)
    fake = dict(doc, source_fingerprint="not-the-real-fingerprint")
    is_stale, why = F.stale(fake)
    assert is_stale
    assert "changed" in why


def test_a_missing_facts_file_is_stale_not_empty():
    is_stale, why = F.stale(None)
    assert is_stale and "--build" in why


def test_every_fact_names_its_unit_and_its_source(doc):
    """A number without a unit is not a fact, and a number without a source
    cannot be re-derived when somebody disputes it."""
    assert len(doc["facts"]) > 100
    for k, v in doc["facts"].items():
        assert set(v) == {"value", "unit", "source"}, k
        assert v["source"], k
        assert v["value"] is not None, k


def test_the_facts_match_the_models_they_came_from(doc):
    """The facts file must never be a second derivation that can drift."""
    import cost_structure as CS
    s = CS.structure("XTRACK", 13)
    f = doc["facts"]
    assert f["XTRACK/fixed/subtotal_in_the_sheet"]["value"] == round(s["fixed_total"])
    assert f["XTRACK/fixed/TRUE_TOTAL"]["value"] == round(
        s["fixed_total"] + s["outside_fixed_total"])
    assert f["XTRACK/variable/TRUE_TOTAL"]["value"] == round(
        s["variable_total"] + s["outside_variable_total"], 4)


def test_all_three_companies_and_the_group_are_covered(doc):
    keys = doc["facts"].keys()
    for c in ("ZONE", "XTRACK", "AFG", "GROUP"):
        assert any(k.startswith(c + "/") for k in keys), c


def test_find_matches_a_word_not_an_exact_key(doc):
    """Nobody should have to know the key. `--find rent` must reach all three
    companies' rent without a maintained list of question phrasings."""
    hits = F.find("rent", doc)
    assert len({k.split("/")[0] for k, _ in hits}) >= 3
    assert F.find("no-such-thing-here", doc) == []


def test_the_true_totals_are_above_the_sheet_subtotals(doc):
    """The whole point of the facts: what the sheets carry, and what they do
    not. If these ever match, the outside costs stopped being added."""
    f = doc["facts"]
    for c in ("ZONE", "XTRACK", "AFG"):
        assert f[f"{c}/fixed/TRUE_TOTAL"]["value"] > \
            f[f"{c}/fixed/subtotal_in_the_sheet"]["value"], c


def test_the_build_records_what_it_was_built_from(doc):
    assert doc["source_files"] > 100
    assert doc["source_fingerprint"]
    assert doc["built_at"]
