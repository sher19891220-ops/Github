"""Controls on Ohio BMV's own IRP Vehicle Status filing and its cross-check
against the internal group unit workbook.

The failure worth guarding: a filing this strong (a government record, not a
hand-kept sheet) silently disagreeing with the workbook and nobody noticing,
or the parse quietly returning fewer rows than the filing itself states.
"""
import sys
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
sys.path.insert(0, str(ROOT / "analysis"))
warnings.filterwarnings("ignore")

import parse_irp_status as S    # noqa: E402
import fleet_registry as F      # noqa: E402
import registration as G        # noqa: E402
import parse_irp as R           # noqa: E402

PATH = ROOT / "data/raw/permits/irp_status/zone_oh_irp_vehicle_status_2026-09-09.pdf"
pytestmark = pytest.mark.skipif(not PATH.exists(), reason="the IRP status filing is absent")


@pytest.fixture(scope="module")
def parsed():
    return S.read(PATH)


def test_the_parse_matches_the_filings_own_stated_count(parsed):
    rows, header = parsed
    fails = S.controls(rows, header)
    assert not fails, fails
    assert len(rows) == 42


def test_no_duplicate_vin_within_the_filing(parsed):
    rows, _ = parsed
    vins = [r["vin"] for r in rows]
    assert len(vins) == len(set(vins))


def test_every_filed_vin_resolves_in_the_group_workbook(parsed):
    """A filed, plated truck the group's own workbook has never heard of
    would be a real gap. There should not be one."""
    rows, _ = parsed
    reg_rows, _ = F.registry()
    renumbered, unmatched = S.compare_to_group_workbook(rows, reg_rows)
    assert unmatched == []


def test_only_the_two_known_corrections_are_renumbered(parsed):
    """This filing is the strongest evidence in the corpus that 5852/5417 are
    genuinely the state's own numbers for trucks the internal workbook calls
    15852/5091 -- not a typo in the registration payment sheet, and not
    anything else in the 42-unit fleet."""
    rows, _ = parsed
    reg_rows, _ = F.registry()
    renumbered, _ = S.compare_to_group_workbook(rows, reg_rows)
    seen = {r[0] for r in renumbered}
    assert seen == {"5417", "5852"}


def test_registration_py_reports_the_same_cross_check():
    """The wiring inside registration.py must produce the same finding as
    calling parse_irp_status directly -- this is the control an operator
    actually sees, not just the module in isolation."""
    payments, _, _ = R.read()
    per_truck = R.per_unit(payments)
    checks = G.check_against_irp_status(G.unit_index(), set(per_truck.keys()))
    assert len(checks) == 1
    chk = checks[0]
    assert not chk["controls"]
    assert not chk["unmatched"]
    assert {r[0] for r in chk["renumbered"]} == {"5417", "5852"}
    # Known: sold (4851), stopped running (2703), the internal-numbering twin
    # of 5852 (15852), and units plausibly on a different account (6867,
    # 7584, 9859) -- reported, never silently dropped.
    assert set(chk["paid_not_on_filing"]) == {"15852", "2703", "4851", "6867", "7584", "9859"}
