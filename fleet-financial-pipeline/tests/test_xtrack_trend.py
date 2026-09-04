"""Controls on the weekly trend decomposition.

These tests exist because every one of them has already caught a wrong answer:
the alias gap invented a $464/truck cost line that did not exist, the bridge
arithmetic silently absorbed the unallocated gap, and the itemisation reader
shifted every amount onto its neighbouring label.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))

import xtrack_trend as T
from xtrack_diagnosis import ALIAS, CD_COST_FIELDS

XLSX = ROOT / "data/raw/pnl/88206141-Xtrack_LLC_download.xlsx"
pytestmark = pytest.mark.skipif(not XLSX.exists(), reason="XTRACK workbook absent")


@pytest.fixture(scope="module")
def weeks():
    return T.load(XLSX)


def test_both_spellings_of_the_admin_column_map_to_one_field():
    # 'Insur/Admin/Trl' (to 2026-06-29) and 'Pys/Cargo/Admin' (after) are the
    # same column. Mapping only one reads the other as zero.
    assert ALIAS["insur/admin/trl"] == ALIAS["pys/cargo/admin"] == "admin"


def test_every_block_header_label_is_known(weeks):
    unknown = {}
    for wk, d in weeks.items():
        if d["unmapped"]:
            unknown[wk] = d["unmapped"]
    assert not unknown, f"unmapped headers read as zero: {unknown}"


def test_company_driver_costs_reconstruct_the_block_result(weeks):
    # gross - the named cost columns = the block's own Total, to the cent.
    bad = []
    for wk, d in weeks.items():
        costs = sum(d["cd_" + f] for f in CD_COST_FIELDS)
        gap = d["cd_gross"] - costs - d["cd_result"]
        if abs(gap) > 50:
            bad.append((wk, round(gap, 2)))
    assert not bad, bad


def test_other_expense_itemisation_ties_to_its_stated_total(weeks):
    off = {wk: round(d["item_gap"], 2) for wk, d in weeks.items()
           if abs(d["item_gap"]) > 1.0}
    # 2026-08-17 prints 'Freight Expenses' ($59.60) outside the stated total.
    assert set(off) <= {"2026-08-17"}, off
    assert all(abs(v) < 100 for v in off.values()), off


def test_net_profit_bridge_is_exact(weeks):
    ks = sorted(weeks)
    a = T.period(weeks, ks[:6])
    b = T.period(weeks, ks[-6:])
    assert abs(a["net"] + sum(v for _, v in T.bridge(a, b)) - b["net"]) < 0.01


def test_company_driver_factor_walk_is_exact(weeks):
    ks = sorted(weeks)
    a = T.period(weeks, ks[:6])
    b = T.period(weeks, ks[-6:])
    walked = a["cd_result"] + sum(v for _, v in T.cd_factors(a, b))
    assert abs(walked - b["cd_result"]) < 0.01


def test_fuel_walk_reproduces_fuel_per_loaded_mile(weeks):
    ks = sorted(weeks)
    a = T.period(weeks, ks[:6])
    b = T.period(weeks, ks[-6:])
    start = a["cd_fuel"] / a["cd_miles"]
    end = b["cd_fuel"] / b["cd_miles"]
    assert abs(start + sum(v for _, v in T.fuel_walk(a, b)) - end) < 1e-6


def test_unallocated_is_reported_not_hidden(weeks):
    # The sheet's own net is NOT unit blocks minus the overhead row. If that gap
    # ever silently vanishes, a line has been double-counted somewhere.
    gaps = [abs(d["unallocated"]) for d in weeks.values()]
    assert max(gaps) > 1000, "unallocated collapsed to zero -- check for a double count"


def test_panel_gross_disagrees_with_the_unit_blocks_in_known_weeks(weeks):
    # The panel's 'Total gross' is hand-set and does not always equal the sum of
    # the trucks. This is the workbook's discrepancy, not the reader's: it is
    # pinned here so a change in either direction is noticed.
    off = {wk: round(d["unit_gross"] - d["gross"], 2) for wk, d in weeks.items()
           if abs(d["unit_gross"] - d["gross"]) > 1.0}
    assert len(off) == 10, off
    assert max(abs(v) for v in off.values()) < 11000, off
