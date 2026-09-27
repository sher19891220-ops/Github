"""Controls on the Samsara "Detailed Vehicle Activity Report" -> per-state
mileage parser. Column order and the "one file = one truck" shape are
confirmed against the operator's own real export (289904, ZONE OH LLC,
week of 2026-09-14) -- see the module docstring. This fixture is a small,
hand-built stand-in with the same columns so the test suite never depends on
a real upload being present in the container.
"""
import csv
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
import ingest_samsara_state_mileage as M  # noqa: E402

HEADER = ["Report Table Name", "Vehicle", "Time", "Status", "Speed (mph)",
          "Speed Limit (mph)", "Latitude", "Longitude", "Odometer (mi)", "Location"]


def _write(tmp_path, rows):
    p = tmp_path / "activity.csv"
    with open(p, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(HEADER)
        w.writerows(rows)
    return p


def row(vehicle, time, odo, location, status=""):
    return ["Detailed Vehicle Activity Report", vehicle, time, status,
            "0.0", "-", "40.0", "-80.0", str(odo), location]


def test_state_of_handles_a_missing_zip():
    """Confirmed in the real export: 'Hilltop Road, Osseo, WI' has no ZIP,
    which shifts every field left by one -- a fixed column index would read
    'Osseo' as the state instead of 'WI'."""
    assert M.state_of("Hilltop Road, Osseo, WI") == "WI"
    assert M.state_of("8051 Bagley Avenue, Northfield, MN, 55057") == "MN"
    assert M.state_of("I 90;I 94, Town of Orange, WI, 54637") == "WI"


def test_parse_time_needs_an_explicit_year_the_column_never_carries():
    t = M.parse_time("Sep 14 7:56AM EDT", 2026)
    assert (t.year, t.month, t.day, t.hour, t.minute) == (2026, 9, 14, 7, 56)
    t2 = M.parse_time("Sep 14 12:05PM EDT", 2026)
    assert t2.hour == 12  # noon, not 24 -- the %12 + PM-offset trap
    t3 = M.parse_time("Sep 14 12:05AM EDT", 2026)
    assert t3.hour == 0  # midnight, not 12


def test_a_weeks_odometer_miles_split_across_a_state_line(tmp_path):
    rows = [
        row("289904", "Sep 14 7:00AM EDT", 100000, "Main St, Columbus, OH, 43004"),
        row("289904", "Sep 14 8:00AM EDT", 100050, "Main St, Columbus, OH, 43004"),
        row("289904", "Sep 14 9:00AM EDT", 100120, "I 70, Wheeling, WV, 26003"),
        row("289904", "Sep 14 10:00AM EDT", 100200, "I 70, Wheeling, WV, 26003"),
    ]
    p = _write(tmp_path, rows)
    mileage_rows, summary = M.parse_activity_csv(p, company="ZONE", year=2026)
    by_state = {r["state"]: r["miles"] for r in mileage_rows}
    # Each delta is attributed to the state at the END of its interval:
    # 100000->100050 ends in OH (+50 OH); 100050->100120 ends in WV (+70 WV);
    # 100120->100200 ends in WV (+80 WV).
    assert by_state["OH"] == pytest.approx(50.0)
    assert by_state["WV"] == pytest.approx(150.0)
    assert summary["total_miles"] == pytest.approx(200.0)
    assert summary["unit"] == "289904"
    assert summary["week_start"] == "2026-09-14"  # a real Monday


def test_a_negative_odometer_reading_is_dropped_not_absorbed(tmp_path):
    """Same corruption CLAUDE.md already documents for the hand-keyed P&L
    odometer column: a bad reading must not silently inflate or deflate a
    state's real mileage."""
    rows = [
        row("100", "Sep 14 7:00AM EDT", 500, "Main St, Columbus, OH, 43004"),
        row("100", "Sep 14 8:00AM EDT", 480, "Main St, Columbus, OH, 43004"),  # went backwards
        row("100", "Sep 14 9:00AM EDT", 560, "Main St, Columbus, OH, 43004"),
    ]
    p = _write(tmp_path, rows)
    mileage_rows, summary = M.parse_activity_csv(p, company="ZONE", year=2026)
    assert summary["dropped_negative_deltas"] == 1
    by_state = {r["state"]: r["miles"] for r in mileage_rows}
    assert by_state["OH"] == pytest.approx(80.0)  # only the 480->560 leg


def test_a_row_with_no_recognizable_state_is_reported_not_hidden(tmp_path):
    rows = [
        row("100", "Sep 14 7:00AM EDT", 100, "Somewhere Rural, Unincorporated"),
        row("100", "Sep 14 8:00AM EDT", 130, "Somewhere Rural, Unincorporated"),
    ]
    p = _write(tmp_path, rows)
    mileage_rows, summary = M.parse_activity_csv(p, company="ZONE", year=2026)
    assert mileage_rows == []
    assert summary["no_state_miles"] == pytest.approx(30.0)
    assert summary["total_miles"] == pytest.approx(30.0)


def test_parse_activity_dir_combines_every_trucks_file(tmp_path):
    """The operator's real weekly workflow: one Samsara export per truck,
    'we need for all units' -- a directory of them combines into one
    mileage_rows list covering every truck that parsed."""
    # _write() always names its file activity.csv, so both trucks' files are
    # written directly here instead, landing in the same directory.
    import csv as csv_mod
    d = tmp_path
    with open(d / "unit100.csv", "w", newline="") as f:
        w = csv_mod.writer(f)
        w.writerow(HEADER)
        w.writerows([
            row("100", "Sep 14 7:00AM EDT", 0, "Main St, Columbus, OH, 43004"),
            row("100", "Sep 14 8:00AM EDT", 100, "Main St, Columbus, OH, 43004"),
        ])
    with open(d / "unit200.csv", "w", newline="") as f:
        w = csv_mod.writer(f)
        w.writerow(HEADER)
        w.writerows([
            row("200", "Sep 14 7:00AM EDT", 0, "I 70, Wheeling, WV, 26003"),
            row("200", "Sep 14 8:00AM EDT", 50, "I 70, Wheeling, WV, 26003"),
        ])
    rows, summaries, failed = M.parse_activity_dir(d, company="ZONE", year=2026)
    assert failed == []
    assert {s["unit"] for s in summaries} == {"100", "200"}
    by_unit_state = {(r["unit"], r["state"]): r["miles"] for r in rows}
    assert by_unit_state[("100", "OH")] == pytest.approx(100.0)
    assert by_unit_state[("200", "WV")] == pytest.approx(50.0)


def test_parse_activity_dir_reports_a_bad_file_without_losing_the_good_ones(tmp_path):
    d = tmp_path
    (d / "broken.csv").write_text("not,a,valid,samsara,export\n1,2,3,4,5\n")
    with open(d / "unit100.csv", "w", newline="") as f:
        import csv as csv_mod
        w = csv_mod.writer(f)
        w.writerow(HEADER)
        w.writerows([row("100", "Sep 14 7:00AM EDT", 0, "Main St, Columbus, OH, 43004"),
                     row("100", "Sep 14 8:00AM EDT", 10, "Main St, Columbus, OH, 43004")])
    rows, summaries, failed = M.parse_activity_dir(d, company="ZONE", year=2026)
    assert len(summaries) == 1 and summaries[0]["unit"] == "100"
    assert len(failed) == 1 and "broken.csv" in failed[0][0]


def test_more_than_one_vehicle_in_one_file_is_refused_not_guessed(tmp_path):
    rows = [
        row("100", "Sep 14 7:00AM EDT", 100, "Main St, Columbus, OH, 43004"),
        row("200", "Sep 14 7:00AM EDT", 200, "Main St, Columbus, OH, 43004"),
    ]
    p = _write(tmp_path, rows)
    with pytest.raises(ValueError, match="one Vehicle per file"):
        M.parse_activity_csv(p, company="ZONE", year=2026)


def test_output_rows_are_ready_for_state_tax_engine(tmp_path):
    """The whole point: this parser's output must slot directly into
    analysis.state_tax_engine's mileage_rows input with no reshaping."""
    sys.path.insert(0, str(ROOT / "analysis"))
    import state_tax_engine as E  # noqa: E402

    rows = [
        row("100", "Sep 14 7:00AM EDT", 0, "Main St, Columbus, OH, 43004"),
        row("100", "Sep 14 8:00AM EDT", 300, "Main St, Columbus, OH, 43004"),
    ]
    p = _write(tmp_path, rows)
    mileage_rows, _ = M.parse_activity_csv(p, company="ZONE", year=2026)
    out = E.unit_state_report(mileage_rows, gallons_state={},
                               rate_state={"OH": {"base": 0.47, "surcharge": 0.0}}, mpg=6.5)
    assert out[0]["unit"] == "100" and out[0]["state"] == "OH"
    assert out[0]["ifta_tax"] != 0.0
