"""Controls on the per-state IFTA + permit engine (analysis/state_tax_engine.py).

Every expected number here is hand-computed in the test itself -- this module
has no filed return of its own to reconcile against yet (that reconciliation
lives in test_tax_and_insurance.py, against a real ZONE-OH return). What these
tests protect is the ARITHMETIC: net taxable gallons, the base-only fuel-tax
credit (never crediting a surcharge), the per-unit mile-share allocation of a
fleet-level IFTA liability, and that ifta_tax and permit_tax never bleed into
each other for the same state.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import state_tax_engine as E  # noqa: E402

MILEAGE = [
    {"company": "ZONE", "period": "2026-W01", "unit": "100", "state": "OH", "miles": 1000},
    {"company": "ZONE", "period": "2026-W01", "unit": "100", "state": "KY", "miles": 500},
    {"company": "ZONE", "period": "2026-W01", "unit": "200", "state": "OH", "miles": 500},
    {"company": "ZONE", "period": "2026-W01", "unit": "200", "state": "KY", "miles": 500},
    {"company": "ZONE", "period": "2026-W01", "unit": "200", "state": "OR", "miles": 200},
]
GALLONS_STATE = {"OH": 200.0, "KY": 50.0}
# KY = 0.22 base + 0.11 surcharge, mirroring a real filed Kentucky KYU row pair.
RATE_STATE = {"OH": {"base": 0.47, "surcharge": 0.0},
              "KY": {"base": 0.22, "surcharge": 0.11},
              "OR": {"base": 0.00, "surcharge": 0.0}}


def test_gallons_by_state_reads_either_efs_or_relay_shape():
    efs_rows = [{"state": "OH", "qty": 120.0}, {"state": "oh", "qty": 30.5}]
    relay_rows = [{"state": "KY", "gallons": 80.0}]
    assert E.gallons_by_state(efs_rows) == {"OH": pytest.approx(150.5)}
    assert E.gallons_by_state(relay_rows) == {"KY": pytest.approx(80.0)}


def test_unit_week_totals_collapses_per_state_rows_to_one_row_per_unit():
    """MILEAGE has unit 200 running OH, KY, and OR in the same week --
    unit_week_totals() must sum its ifta_tax/permit_tax across all three
    into one row, not leave three."""
    report = E.unit_state_report(MILEAGE, GALLONS_STATE, RATE_STATE, mpg=6.0)
    out = E.unit_week_totals(report)
    assert set(out.keys()) == {"100", "200"}
    r100 = [r for r in report if r["unit"] == "100"]
    r200 = [r for r in report if r["unit"] == "200"]
    assert out["100"]["ifta_tax"] == pytest.approx(sum(r["ifta_tax"] for r in r100), abs=0.01)
    assert out["100"]["permit_tax"] == pytest.approx(sum(r["permit_tax"] for r in r100), abs=0.01)
    assert out["200"]["ifta_tax"] == pytest.approx(sum(r["ifta_tax"] for r in r200), abs=0.01)
    assert out["200"]["permit_tax"] == pytest.approx(sum(r["permit_tax"] for r in r200), abs=0.01)
    assert sorted(out["200"]["states"]) == ["KY", "OH", "OR"]
    assert out["200"]["company"] == "ZONE" and out["200"]["period"] == "2026-W01"


def test_unit_week_totals_on_empty_input():
    assert E.unit_week_totals([]) == {}


def test_gallons_state_from_relay_pulls_filters_and_sums(monkeypatch):
    """The real wiring: pull_transactions() -> diesel_rows() (drop DEF and
    Product rows) -> gallons_by_state() -- no network here, pull_relay_fuel's
    own live-API path is mocked at pull_transactions() the same way
    test_pull_motive.py mocks Motive's _get()."""
    import pull_relay_fuel as RF  # noqa: E402  (ingest/ already on sys.path via state_tax_engine)

    fake_rows = [
        {"type": "Fuel", "fuel_item": "Diesel", "state": "OH", "gallons": 100.0},
        {"type": "Fuel", "fuel_item": "Def", "state": "OH", "gallons": 5.0},
        {"type": "Fuel", "fuel_item": "Diesel", "state": "KY", "gallons": 40.0},
        {"type": "Product", "fuel_item": None, "state": "KY", "gallons": None},
    ]

    captured = {}

    def fake_pull(dtstart, dtend, source_file=None):
        captured["args"] = (dtstart, dtend)
        return fake_rows

    monkeypatch.setattr(RF, "pull_transactions", fake_pull)
    out = E.gallons_state_from_relay("2026-09-14T00:00:00Z", "2026-09-21T00:00:00Z")
    assert captured["args"] == ("2026-09-14T00:00:00Z", "2026-09-21T00:00:00Z")
    assert out == {"OH": pytest.approx(100.0), "KY": pytest.approx(40.0)}


def test_rates_by_state_treats_a_states_first_row_as_base_second_as_surcharge():
    rows = [{"state": "KY", "rate": 0.22}, {"state": "KY", "rate": 0.11},
            {"state": "OH", "rate": 0.47}]
    out = E.rates_by_state(rows)
    assert out["KY"] == {"base": pytest.approx(0.22), "surcharge": pytest.approx(0.11)}
    assert out["OH"] == {"base": pytest.approx(0.47), "surcharge": 0.0}


def test_ifta_rate_schedule_loads_the_operator_supplied_q3_2026_reference():
    """config/ifta_rates_q3_2026.json, uploaded 2026-09-27 -- confirms the
    base/surcharge split survives the loader for the two states known to
    carry a real surcharge in that file (Kentucky, Virginia)."""
    sched = E.ifta_rate_schedule()
    assert len(sched) == 48
    assert sched["KY"] == {"base": pytest.approx(0.22), "surcharge": pytest.approx(0.105)}
    assert sched["VA"]["surcharge"] == pytest.approx(0.143)
    assert sched["OH"] == {"base": pytest.approx(0.47), "surcharge": 0.0}


def test_fleet_mpg_is_total_real_miles_over_total_real_gallons():
    assert E.fleet_mpg(MILEAGE, 250.0) == pytest.approx(2700 / 250.0)


def test_a_state_with_no_filed_rate_is_skipped_not_zeroed():
    """A state this fleet has never filed an IFTA return for has no rate on
    record. ifta_by_state() must leave it out of the result, never book it as
    a real $0.00 liability -- that would look identical to Oregon's real,
    filed $0.00 rate and hide a genuine gap."""
    out = E.ifta_by_state(MILEAGE, GALLONS_STATE, {"OH": {"base": 0.47, "surcharge": 0.0}},
                          mpg=10.8)
    assert "KY" not in out and "OR" not in out
    assert "OH" in out


def test_ifta_by_state_nets_taxable_against_gallons_actually_purchased_there():
    mpg = 2700 / 250.0  # 10.8
    out = E.ifta_by_state(MILEAGE, GALLONS_STATE, RATE_STATE, mpg)
    # OH: 1500 miles / 10.8 mpg = 138.888... taxable gallons, less 200 purchased
    oh = out["OH"]
    assert oh["taxable_gallons"] == pytest.approx(1500 / mpg, abs=0.01)
    assert oh["liability"] == pytest.approx((1500 / mpg) * 0.47, abs=0.01)
    assert oh["credit"] == pytest.approx(200 * 0.47, abs=0.01)
    assert oh["ifta_tax"] == pytest.approx(oh["liability"] - oh["credit"], abs=0.01)
    assert oh["ifta_tax"] < 0, "more fuel bought in OH than taxable there -- a credit"
    # OR: real filed rate is $0.00 -- IFTA owes nothing there regardless of miles
    assert out["OR"]["base"] == 0.0 and out["OR"]["surcharge"] == 0.0
    assert out["OR"]["ifta_tax"] == 0.0


def test_the_fuel_tax_credit_applies_to_the_base_rate_only_never_the_surcharge():
    """Kentucky's real Trip_Calculator model (the operator's own Q3 2026
    workbook): F2 = purchased_gallons x BASE rate, never x (base+surcharge).
    Fleet-wide KY miles are 1000 (500 each from units 100 and 200) at 10.8
    mpg = 92.59 taxable gallons; 50 gallons purchased there. liability =
    92.59 x (0.22+0.11) = 30.56; credit = 50 x 0.22 (NOT 50 x 0.33) = 11.00;
    ifta_tax = 30.56 - 11.00 = 19.56."""
    mpg = 2700 / 250.0
    out = E.ifta_by_state(MILEAGE, GALLONS_STATE, RATE_STATE, mpg)
    ky = out["KY"]
    taxable = 1000 / mpg
    assert ky["liability"] == pytest.approx(taxable * (0.22 + 0.11), abs=0.01)
    assert ky["credit"] == pytest.approx(50 * 0.22, abs=0.01)
    assert ky["credit"] != pytest.approx(50 * 0.33, abs=0.01), \
        "must not credit the surcharge portion against pump purchases"
    assert ky["ifta_tax"] == pytest.approx(ky["liability"] - ky["credit"], abs=0.01)


def test_unit_state_report_splits_ifta_and_permit_into_separate_columns():
    """The exact ask (operator, 2026-09-27): 'put ifta + permits cost
    separately for each state.' OH has an IFTA liability and no permit
    (not one of the five weight-distance states). KY has BOTH: a real IFTA
    fuel-tax component from the filed rate, and a separate KYU permit
    component from config/weight_distance_tax_rates.json. OR shows the
    inverse of OH -- real $0 IFTA, a real nonzero permit."""
    mpg = 2700 / 250.0
    rows = E.unit_state_report(MILEAGE, GALLONS_STATE, RATE_STATE, mpg)
    by_key = {(r["unit"], r["state"]): r for r in rows}

    oh100, oh200 = by_key[("100", "OH")], by_key[("200", "OH")]
    assert oh100["permit_tax"] == 0.0 and oh200["permit_tax"] == 0.0
    # unit 100 ran 1000 of OH's 1500 fleet miles there -- 2/3 of OH's IFTA tax
    ifta_state = E.ifta_by_state(MILEAGE, GALLONS_STATE, RATE_STATE, mpg)
    assert oh100["ifta_tax"] == pytest.approx((1000 / 1500) * ifta_state["OH"]["ifta_tax"], abs=0.01)
    assert oh200["ifta_tax"] == pytest.approx((500 / 1500) * ifta_state["OH"]["ifta_tax"], abs=0.01)
    # allocated shares must add back to the fleet-level state total
    assert oh100["ifta_tax"] + oh200["ifta_tax"] == pytest.approx(ifta_state["OH"]["ifta_tax"], abs=0.01)

    ky100 = by_key[("100", "KY")]
    real_ky_permit_rate = E.permit_states()["KY"]
    assert ky100["permit_tax"] == pytest.approx(500 * real_ky_permit_rate, abs=0.01)
    assert ky100["ifta_tax"] != 0.0, "KY has a real filed IFTA rate too, not just a permit"

    or200 = by_key[("200", "OR")]
    real_or_permit_rate = E.permit_states()["OR"]
    assert or200["ifta_tax"] == 0.0
    assert or200["permit_tax"] == pytest.approx(200 * real_or_permit_rate, abs=0.01)
    assert or200["permit_tax"] > 0, "Oregon's real cost is entirely on the permit side"


def test_unit_state_report_defaults_to_the_current_quarter_schedule():
    """No rate_state/mpg supplied -> ifta_rate_schedule() and its own
    default_mpg, not silently zero or an exception."""
    rows = E.unit_state_report(MILEAGE, GALLONS_STATE)
    oh100 = next(r for r in rows if r["unit"] == "100" and r["state"] == "OH")
    assert oh100["ifta_tax"] != 0.0


def test_permit_states_reflects_the_2026_09_27_corrected_rates():
    """NM materially changed (0.059 -> 0.04378) when the operator supplied
    state-cited rates on 2026-09-27; this guards against a stale config
    silently reverting to the old, less-well-sourced figure."""
    rates = E.permit_states()
    assert rates["NM"] == pytest.approx(0.04378)
    assert rates["NY"] == pytest.approx(0.0546)
    assert rates["OR"] == pytest.approx(0.2512)


def test_latest_rate_state_picks_the_chronologically_last_return_not_the_lexical_one():
    """period_end prints as 'MM/DD/YYYY'. Sorting that as a plain string puts
    '03/31/2026' before '12/31/2025' ('0' < '1'), which is backwards -- the
    2026 return is the newer one and must win."""
    returns = [
        {"legal_name": "ZONE-OH LLC", "period_end": "12/31/2025",
         "jurisdiction_tax_rows": [{"state": "OH", "rate": 0.40}]},
        {"legal_name": "ZONE-OH LLC", "period_end": "03/31/2026",
         "jurisdiction_tax_rows": [{"state": "OH", "rate": 0.47}]},
    ]
    rates, used = E.latest_rate_state("ZONE", returns)
    assert used == "03/31/2026"
    assert rates["OH"]["base"] == pytest.approx(0.47)


def test_latest_rate_state_matches_by_legal_name_substring_like_cost_structure_does():
    returns = [{"legal_name": "XTRACK LLC", "period_end": "03/31/2026",
                "jurisdiction_tax_rows": [{"state": "IN", "rate": 0.61}]}]
    rates, used = E.latest_rate_state("ZONE", returns)
    assert rates == {} and used is None
    rates, used = E.latest_rate_state("XTRACK", returns)
    assert rates["IN"]["base"] == pytest.approx(0.61)


def test_a_unit_state_row_is_never_invented_for_mileage_that_was_not_reported():
    """The output has exactly one row per real mileage_rows entry -- never a
    row for a (unit, state) pair no one reported miles for that period."""
    mpg = 2700 / 250.0
    rows = E.unit_state_report(MILEAGE, GALLONS_STATE, RATE_STATE, mpg)
    assert len(rows) == len(MILEAGE)
    assert ("100", "OR") not in {(r["unit"], r["state"]) for r in rows}
