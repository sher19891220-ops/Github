"""Tests for the per-company P&L slice and gap ranking."""
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "analysis"))
from company_pnl import company_slice, rank_gaps, COST_LINES


def _entity(months, gross, miles, units, **cost):
    s = {"gross": gross, "mileage": miles, "total": [0] * len(months)}
    for k, _ in COST_LINES:
        s[k] = cost.get(k, [0] * len(months))
    return {"months": months, "series": s, "units": units}


def test_slice_only_takes_the_requested_year():
    e = _entity(["2025-12", "2026-01", "2026-02"], [100, 200, 300],
                [10, 20, 30], [1, 2, 3])
    d = company_slice(e, "2026")
    assert d["months"] == 2
    assert d["gross"] == 500
    assert d["miles"] == 50


def test_margin_is_gross_less_every_cost_line():
    e = _entity(["2026-01"], [1000], [100], [1],
                driver_salary=[400], def_fuel_fee=[200], truck_rental=[100],
                toll_scale=[50], insur_admin_trl=[50])
    d = company_slice(e, "2026")
    assert d["margin"] == 200
    assert d["margin_per_mile"] == pytest.approx(2.0)


def test_truck_weeks_not_weeks_is_the_denominator():
    """The bug this guards: dividing by weeks instead of truck-weeks inflates
    per-truck figures by the size of the fleet."""
    e = _entity(["2026-01"], [1000], [1000], [10])
    d = company_slice(e, "2026")
    assert d["truck_weeks"] == pytest.approx(10 * 52 / 12)
    assert d["miles_per_truck_week"] == pytest.approx(1000 / (10 * 52 / 12))


def test_missing_year_raises():
    with pytest.raises(ValueError, match="no months matching"):
        company_slice(_entity(["2025-01"], [1], [1], [1]), "2026")


def test_ranking_never_includes_a_pay_model_dependent_line():
    """Driver pay, fuel, rent and insurance differ by pay model, so a gap in
    them is not evidence of a leak. They must never reach the ranked list."""
    cos = {
        "A": company_slice(_entity(["2026-01"], [3000], [1000], [1],
                                   driver_salary=[500]), "2026"),
        "B": company_slice(_entity(["2026-01"], [3000], [1000], [1],
                                   driver_salary=[2500]), "2026"),
    }
    labels = " ".join(r[1] for r in rank_gaps(cos, 0, 0)).lower()
    for banned in ("driver", "fuel", "rent", "insur", "toll"):
        assert banned not in labels
    assert all(r[3] == "comparable" for r in rank_gaps(cos, 0, 0))


def test_ranking_finds_the_revenue_gap_and_sizes_it():
    cos = {
        "RICH": company_slice(_entity(["2026-01"], [3000], [1000], [1]), "2026"),
        "POOR": company_slice(_entity(["2026-01"], [2000], [1000], [1]), "2026"),
    }
    gaps = [g for g in rank_gaps(cos, 0, 0) if g[0] == "POOR" and "Revenue" in g[1]]
    assert len(gaps) == 1
    assert gaps[0][2] == pytest.approx(1000.0)   # 1.000/mi x 1000 mi


def test_ranking_is_sorted_biggest_first():
    cos = {
        "BEST": company_slice(_entity(["2026-01"], [5000], [1000], [1]), "2026"),
        "MID":  company_slice(_entity(["2026-01"], [4000], [1000], [1]), "2026"),
        "WORST":company_slice(_entity(["2026-01"], [1000], [1000], [1]), "2026"),
    }
    costs = [g[2] for g in rank_gaps(cos, 0, 0)]
    assert costs == sorted(costs, reverse=True)
