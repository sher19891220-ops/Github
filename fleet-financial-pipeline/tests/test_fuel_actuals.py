"""Controls on wiring real Relay fuel into a per-truck P&L row.

No network here: pull_transactions() is monkeypatched so these tests run
on the parsed row shape, not on Relay's live API.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))

import fuel_actuals as FA  # noqa: E402
import pull_relay_fuel as RF  # noqa: E402


def _fuel_row(truck, amount, gallons, fee=2.0):
    return {"truck": truck, "type": "Fuel", "amount": -abs(amount), "gallons": gallons, "fee": fee}


def _product_row(truck, amount):
    """A non-fuel Relay charge (e.g. a CAT Scale weigh) -- must never be
    counted as fuel."""
    return {"truck": truck, "type": "Product", "amount": -abs(amount), "gallons": None, "fee": None}


def test_relay_fuel_by_unit_sums_only_fuel_rows(monkeypatch):
    monkeypatch.setattr(RF, "pull_transactions",
                         lambda dtstart, dtend: [_fuel_row("100", 500, 80),
                                                  _fuel_row("100", 300, 50),
                                                  _product_row("100", 25)])
    out = FA.relay_fuel_by_unit("s", "e")
    assert out["100"] == {"fuel_cost": 800.0, "gallons": 130.0, "fee": 4.0, "rows": 2}


def test_a_unit_with_no_relay_transactions_is_absent_not_zero(monkeypatch):
    """Silence from Relay means 'not seen on this rail', not 'spent
    nothing' -- a truck fueling on a different card must not be zeroed."""
    monkeypatch.setattr(RF, "pull_transactions", lambda dtstart, dtend: [_fuel_row("100", 500, 80)])
    out = FA.relay_fuel_by_unit("s", "e")
    assert "200" not in out


def test_augment_replaces_fuel_only_for_units_relay_actually_saw(monkeypatch):
    monkeypatch.setattr(RF, "pull_transactions",
                         lambda dtstart, dtend: [_fuel_row("100", 600, 100)])
    rows = [
        {"unit": "100", "gross": 10000, "driver_pay": 3000, "admin": 400, "fuel": 900,
         "rent": 1200, "trailer_rent": 130, "toll": 200, "additional": 0, "other": 0,
         "miles": 2500, "gallons": 150, "mpg": 16.7},
        {"unit": "200", "gross": 8000, "driver_pay": 2500, "admin": 400, "fuel": 700,
         "rent": 1200, "trailer_rent": 130, "toll": 100, "additional": 0, "other": 0,
         "miles": 2000, "gallons": 120, "mpg": 16.7},
    ]
    out = FA.augment_truck_rows_with_relay_fuel(rows, "2026-09-14")
    by_unit = {r["unit"]: r for r in out}

    assert by_unit["100"]["fuel"] == 600.0
    assert by_unit["100"]["gallons"] == 100.0
    assert by_unit["100"]["fuel_source"] == "relay"
    assert by_unit["100"]["mpg"] == 25.0

    assert by_unit["200"]["fuel"] == 700.0
    assert by_unit["200"]["fuel_source"] == "sheet"


def test_result_is_recomputed_from_the_replaced_fuel(monkeypatch):
    monkeypatch.setattr(RF, "pull_transactions",
                         lambda dtstart, dtend: [_fuel_row("100", 600, 100)])
    rows = [{"unit": "100", "gross": 10000, "driver_pay": 3000, "admin": 400, "fuel": 900,
             "rent": 1200, "trailer_rent": 130, "toll": 200, "additional": 0, "other": 0,
             "miles": 2500, "gallons": 150, "mpg": 16.7}]
    out = FA.augment_truck_rows_with_relay_fuel(rows, "2026-09-14")
    expected = round(10000 - 3000 - 400 - 600 - 1200 - 130 - 200 + 0 + 0, 2)
    assert out[0]["result"] == expected


def test_input_rows_are_never_mutated(monkeypatch):
    monkeypatch.setattr(RF, "pull_transactions",
                         lambda dtstart, dtend: [_fuel_row("100", 600, 100)])
    row = {"unit": "100", "gross": 10000, "driver_pay": 3000, "admin": 400, "fuel": 900,
           "rent": 1200, "trailer_rent": 130, "toll": 200, "additional": 0, "other": 0,
           "miles": 2500, "gallons": 150, "mpg": 16.7}
    rows = [row]
    FA.augment_truck_rows_with_relay_fuel(rows, "2026-09-14")
    assert row["fuel"] == 900


def test_week_bounds_covers_all_seven_calendar_days():
    dtstart, dtend = FA.week_bounds("2026-09-14")
    assert (dtend - dtstart).days == 7
    assert dtstart.isoformat().startswith("2026-09-14")
