"""Tests for analysis/owner_operator_roster.py -- the residual "not
company-driver, not Iron-Lease-financed" roster, derived from the P&L's
own owner-operator block layout minus the Iron Lease LTP/LTWA roster.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import owner_operator_roster as O  # noqa: E402
import truck_weeks as T            # noqa: E402

XTRACK_WORKBOOK = ROOT / "data/raw/pnl/88206141-Xtrack_LLC_download.xlsx"
LTP_ROSTER = ROOT / "data/raw/iron_lease/ltp_roster_pulled_2026-09-22.md"
pytestmark = pytest.mark.skipif(
    not (XTRACK_WORKBOOK.exists() and LTP_ROSTER.exists()),
    reason="P&L workbook or Iron Lease LTP roster not in container")


@pytest.fixture(scope="module")
def full():
    return O.full_roster()


def test_iron_lease_ltp_units_are_excluded(full):
    """Truck 2703 (Nelson Reginald) is confirmed active lease-to-purchase
    -- it must never show up in the residual OO roster."""
    assert "2703" not in set(full.unit)


def test_iron_lease_ltwa_unit_is_excluded(full):
    """Truck 4864 (Samuel Muhoza) is confirmed lease-to-walkaway -- same
    exclusion rule as LTP."""
    assert "4864" not in set(full.unit)


def test_terminated_iron_lease_unit_is_not_specially_excluded_or_included(full):
    """Truck 9859 (Norgaisse Aldens, 'Truck taken back') is not in
    known_arrangements() at all (terminated units are dropped there), so
    it can appear here ONLY if the P&L itself still shows it as
    owner-operator-kind in its most recent week -- this test just checks
    the module doesn't crash on it either way, since the exclusion logic
    is entirely driven by known_arrangements()'s own keys."""
    import driver_arrangement as D
    assert "9859" not in D.known_arrangements()  # confirms the premise


def test_every_row_is_owner_operator_kind(full):
    assert (full.kind == "owner_operator").all()


def test_full_roster_matches_the_sum_of_per_company_calls():
    import driver_arrangement as D
    known = set(D.known_arrangements().keys())
    total = 0
    for co in O.COMPANIES:
        total += len(O.roster(co, known=known))
    full = O.full_roster()
    assert len(full) == total


def test_a_unit_can_appear_under_more_than_one_company(full):
    """Trucks moving between companies is an established fact of this
    corpus (analysis/truck_weeks.py) -- the roster must not silently drop
    a unit's second-company appearance as a duplicate."""
    dupes = full.groupby("unit").company.nunique()
    assert (dupes > 1).any()


def test_company_driver_units_never_appear(full):
    """A control against the source: pick any unit in the roster and
    confirm its OWN most recent P&L week really is owner-operator-kind,
    not company-driver leaking through a join error."""
    for co in O.COMPANIES:
        tw = T.truck_weeks(co)
        tw = tw.assign(unit=tw.unit.astype(str).str.strip())
        co_units = set(full[full.company == co].unit)
        for u in co_units:
            last_kind = tw[tw.unit == u].sort_values("week").iloc[-1].kind
            assert last_kind == "owner_operator", (co, u, last_kind)
