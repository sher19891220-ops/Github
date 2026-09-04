"""The catalog has to be trustworthy enough to work from without opening files."""
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
import catalog as C

CAT = ROOT / "data/CATALOG.json"
pytestmark = pytest.mark.skipif(not CAT.exists(), reason="catalog not built")


@pytest.fixture(scope="module")
def cat():
    return json.loads(CAT.read_text())


def test_entity_matching_survives_the_underscore():
    # '_' is a word character, so \bxtrack\b never matched 'Xtrack_LLC_download'
    # and every P&L workbook came back with no entity at all.
    assert C.classify("data/raw/pnl/88206141-Xtrack_LLC_download.xlsx")[1] == "XTRACK"
    assert C.classify("data/raw/pnl/4954206d-Zone_LLC_download.xlsx")[1] == "ZONE"
    assert C.classify("data/raw/pnl/b479b596-AFG__download.xlsx")[1] == "AFG"


def test_filename_beats_directory_for_entity():
    # data/raw/xtrack/ also holds Zone's and AFG's settlements. Matching on the
    # path alone labelled all three XTRACK.
    p = "data/raw/xtrack/Afg_stmt_AprilAugust/Afg stmt April-August/AFG-Statements-202616-X.xlsx"
    assert C.classify(p)[1] == "AFG"


def test_archives_are_classified_by_extension_not_by_name():
    # 'Iron_lease__Zone.zip' is an archive, not a lease register.
    assert C.classify("~uploads/s/4cb9f428-Iron_lease__Zone.zip")[0] == "archive"
    assert C.classify("data/raw/iron/4d409f87-Iron_lease.xlsx")[0] == "lease_register"


def test_nothing_is_unclassified(cat):
    unknown = [e["path"] for e in cat["files"] if e["kind"] == "unknown"]
    assert not unknown, unknown


def test_every_entry_carries_an_identity_and_a_size(cat):
    for e in cat["files"]:
        assert re.fullmatch(r"[0-9a-f]{16}", e["sha256"]), e
        assert e["bytes"] > 0, e


def test_duplicate_paths_are_collapsed_under_one_hash(cat):
    # The same document is filed under two paths in this corpus. Counting it
    # twice would inflate any per-file total built off the catalog.
    assert cat["total_paths"] > cat["distinct_files"]
    seen = {}
    for e in cat["files"]:
        for p in [e["path"]] + e["copies"]:
            assert p not in seen, f"{p} listed under two hashes"
            seen[p] = e["sha256"]


def test_the_pnl_workbook_in_use_is_the_best_one_available(cat):
    """AFG was read from a ONE-WEEK export with a twenty-week export beside it.

    'Best' is not the most tabs. A workbook with any unmapped block header reads
    those columns as ZERO without saying so, which is worse than fewer weeks --
    the long XTRACK export has 145 tabs and unmapped columns in its early years.
    So: among the workbooks for an entity whose headers are fully mapped, the one
    in use must have the most weeks passing the gross control.
    """
    sys.path.insert(0, str(ROOT / "ingest"))
    from ingest_weekly_pnl import WORKBOOKS
    by_path = {e["path"]: e for e in cat["files"]}
    pnl = [e for e in cat["files"] if e["kind"] == "pnl_weekly"]
    for entity, path in WORKBOOKS.items():
        chosen = by_path.get(path)
        assert chosen, f"{path} is not in the catalog"
        assert not chosen.get("unmapped_headers"), (
            f"{entity} reads {path}, which has unmapped block headers "
            f"{chosen['unmapped_headers']} -- those columns read as zero")
        clean = [e for e in pnl if e["entity"] == entity and not e.get("unmapped_headers")]
        best = max(clean, key=lambda e: e.get("weeks_passing_control", 0))
        assert (chosen.get("weeks_passing_control", 0)
                >= best.get("weeks_passing_control", 0)), (
            f"{entity} reads {path} ({chosen.get('weeks_passing_control')} weeks "
            f"passing) while {best['path']} has {best.get('weeks_passing_control')}")


def test_long_history_workbooks_are_recorded_as_not_yet_usable(cat):
    """2.5 years of ZONE and XTRACK history is in the corpus and not yet readable.

    Pinned so the day someone teaches the reader the pre-2026 panel layout, this
    test fails and the workbook gets promoted instead of staying forgotten.
    """
    long = [e for e in cat["files"]
            if e["kind"] == "pnl_weekly" and e.get("sheets", 0) > 100]
    assert long, "the long P&L exports are missing from the corpus"
    for e in long:
        assert e.get("unmapped_headers"), (
            f"{e['path']} now parses cleanly -- promote it in "
            f"ingest_weekly_pnl.WORKBOOKS and delete this test")
