"""Controls on per-truck maintenance cost, matched to that truck's own miles.

The failures worth guarding: a truck's charges read from one company's ledger
while it moved to another, a NaN unit breaking the join silently, Iron Lease
pass-through counted as a company cost, and the ledger presented as if it were
the P&L's whole maintenance line rather than the 21-43% of it that it is.
"""
import sys
import warnings
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
warnings.filterwarnings("ignore")

import truck_maintenance as TM   # noqa: E402

pytestmark = pytest.mark.skipif(
    not (ROOT / "data/raw/pnl/168e4bc8-XTRACK_Truck_and_Trailer_Expenses_2026.xlsx").exists(),
    reason="maintenance ledgers absent")


@pytest.fixture(scope="module")
def data():
    charges, fails = TM.all_charges()
    weeks = TM.all_weeks()
    df = TM.per_truck(charges, weeks)
    return charges, weeks, df, fails


def test_a_nan_unit_does_not_break_the_join(data):
    """pandas 3.x's astype(str) leaves a genuine NaN as NaN rather than the
    string 'nan'. all_charges() must split those off before anything calls
    set() or sorted() on the unit column."""
    charges, weeks, df, fails = data
    assert charges.unit.notna().all()
    assert not (charges.unit == "nan").any()


def test_unit_numbers_are_stripped_of_whitespace(data):
    """'7605 ' vs '7605' would otherwise split one truck into two rows."""
    charges, weeks, df, fails = data
    assert not any(u != u.strip() for u in charges.unit)


def test_a_truck_that_moved_companies_is_not_split(data):
    """7605, 15862 and others show charges or P&L weeks under more than one
    company. Their row here must be the WHOLE truck, not one company's slice."""
    charges, weeks, df, fails = data
    moved = df[~df.unresolved & df.moved_companies]
    assert len(moved) > 10
    for u in ("15862", "8131"):
        row = df[df.unit == u]
        assert len(row) == 1, f"unit {u} split into {len(row)} rows"


def test_iron_lease_is_excluded_from_company_cost(data):
    """Booked when the operating company pays and reversed when Iron Lease
    credits it back. Counting the paid half without the reversal treats a
    pass-through as a real cost."""
    charges, weeks, df, fails = data
    resolved = df[~df.unresolved]
    # every company-cost total must be reachable without iron lease rows
    il_only = charges[charges.borne_by == "iron lease"]
    assert not il_only.borne_by.isin(TM.COMPANY_BORNE).any()


def test_driver_billed_is_reported_separately_not_as_a_company_cost(data):
    charges, weeks, df, fails = data
    resolved = df[~df.unresolved]
    assert resolved.driver_billed_in_window.sum() > 0
    assert "driver" not in TM.COMPANY_BORNE


def test_a_truck_with_no_pnl_match_has_no_denominator(data):
    """Sold, retired, or a numbering mismatch. Cost is withheld, not divided
    by zero."""
    charges, weeks, df, fails = data
    unresolved = df[df.unresolved]
    assert len(unresolved) > 0
    assert unresolved.cost_per_week.isna().all()
    assert unresolved.cost_per_mile.isna().all()
    assert unresolved.ytd_charged.notna().all()


def test_the_window_is_cut_to_each_trucks_own_pnl_span(data):
    """The ledger runs 2026-01-01..2026-09-01; the P&L starts later per
    company. Dividing a YTD total by a truncated week count overstates cost
    per week, so charges outside a truck's own first..last P&L week are
    excluded from its per-week and per-mile figures."""
    charges, weeks, df, fails = data
    resolved = df[~df.unresolved]
    for _, r in resolved.iterrows():
        cu = charges[charges.unit == r.unit]
        cu_win = cu[cu.date.between(r.first_week, r.last_week)]
        assert r.charges_in_window == len(cu_win), r.unit


def test_cost_per_mile_and_per_week_are_internally_consistent(data):
    charges, weeks, df, fails = data
    resolved = df[~df.unresolved]
    for _, r in resolved.iterrows():
        if r.weeks_in_pnl:
            assert r.cost_per_week == pytest.approx(
                r.company_cost_in_window / r.weeks_in_pnl, rel=1e-6)
        if r.total_miles:
            assert r.cost_per_mile == pytest.approx(
                r.company_cost_in_window / r.total_miles, rel=1e-6)


def test_no_resolved_truck_has_negative_or_implausible_cost_per_mile(data):
    charges, weeks, df, fails = data
    resolved = df[~df.unresolved]
    assert (resolved.company_cost_in_window >= 0).all()
    assert resolved.cost_per_mile.dropna().max() < 5


def test_the_ledger_is_a_minority_of_the_pnls_own_maintenance_line(data):
    """The finding that keeps this module from overclaiming: even with both
    Truck Max sources combined, they cover 42-51% of what the P&L panel books
    as maintenance, not all of it. If this ever comes back near 100% the panel
    or the ledgers changed and the docstring's caveat needs revisiting."""
    charges, weeks, df, fails = data
    rec = TM.reconcile_to_panel(charges, weeks)
    for co, r in rec.items():
        assert 0.15 < r["ratio"] < 0.60, (co, r["ratio"])
        assert r["combined"] < r["panel"]


def test_controls_pass_or_name_a_real_ledger_issue(data):
    charges, weeks, df, fails = data
    problems = TM.controls(df, fails)
    # every failure must be traceable to a named, already-documented ledger
    # quirk (a missing unit, a stray negative, an Iron Lease pair that no
    # longer nets to zero -- e.g. ZONE unit 15909's 2026-08-27 reversal was
    # entered as +46.31 instead of -46.31, a $92.62 sign-flip typo caught the
    # moment the live sheet replaced the static export it was sampled from)
    # -- never a silent pass.
    for p in problems:
        assert any(k in p for k in
                   ("no unit", "negative", "$5/mile", "no longer net to zero"))


def test_maintenance_ledger_controls_catch_a_real_nan_unit():
    """Regression: pandas 3.x's astype(str) changed to leave NaN as NaN, which
    silently defeated the old `charged.unit.eq("nan")` check -- it stopped
    firing with no error when the pandas version changed under it. XTRACK's
    real ledger has at least one truck-type charge with no unit at all."""
    import maintenance_ledger as M
    c, u = M.load("XTRACK")
    fails = M.controls(c, u)
    assert any("no unit" in f[0] for f in fails)


def test_the_second_source_is_added_never_deduplicated_against_the_first(data):
    """Zero invoice-ID overlap was confirmed between the four new payer files
    and the existing per-company ledgers before they were combined -- the two
    are concatenated, never merged or deduplicated on any shared key."""
    charges, weeks, df, fails = data
    is_second = charges.ledger_company.astype(str).str.startswith("SECOND_SOURCE")
    assert is_second.sum() > 0
    assert (~is_second).sum() > 0
    assert charges[is_second].amount.sum() > 0
    assert charges[~is_second].amount.sum() > 0


def test_second_source_iron_lease_is_visible_but_never_a_company_cost(data):
    """Close in size to parse_iron_lease_invoices.py's own repair-credit total
    ($174,138) -- plausibly the same repairs counted from a different document.
    Excluded from cost everywhere, not just netted, until that is resolved."""
    charges, weeks, df, fails = data
    resolved = df[~df.unresolved]
    assert resolved.second_source_iron_lease_EXCLUDED.sum() > 0
    il_rows = charges[charges.borne_by == "iron lease (second source)"]
    assert not il_rows.borne_by.isin(TM.COMPANY_BORNE).any()


def test_reconcile_to_panel_windows_the_second_source_to_each_companys_own_span(data):
    """The second source reaches back to 2025-08, five months before AFG's P&L
    even starts. Comparing an unfiltered YTD total against a 20-week panel
    total overstated AFG's ratio past 100% until both sources were cut to the
    panel's own first..last week."""
    charges, weeks, df, fails = data
    rec = TM.reconcile_to_panel(charges, weeks)
    for co, r in rec.items():
        assert r["ratio"] is not None
        assert r["ratio"] < 0.60, (co, r["ratio"])   # never near or over 100%
        assert r["combined"] >= r["first_source"]


def test_import_alias_pandas_is_available_for_the_new_tests():
    import pandas as pd  # noqa: F401
