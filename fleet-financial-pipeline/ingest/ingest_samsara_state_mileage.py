"""Samsara's "Detailed Vehicle Activity Report" CSV -> real per-unit,
per-state miles for one truck, one week -- the mileage_rows input
analysis/state_tax_engine.py has been waiting on since it was built.

ONE FILE = ONE TRUCK, ONE WEEK. Confirmed against the operator's own sample
export (289904, ZONE OH LLC, Sep 14-21 2026): every row's `Vehicle` column is
the same value, so this is a per-vehicle report, not a fleet-wide one -- the
weekly workflow is one upload per truck, matching what the operator asked for
("users will upload every week samsara and motive mileage reports").

THIS IS RAW GPS TELEMETRY, NOT A PRE-AGGREGATED STATE-MILEAGE REPORT. Samsara
also has a native per-jurisdiction IFTA report (`ingest/pull_samsara.py
--ifta`, GET /fleet/reports/ifta/vehicle) that computes state mileage off its
own road network -- more accurate than this, if the operator's Samsara plan
has that feature and prefers a live pull over a weekly upload. This module
exists because the file actually supplied was the raw activity export, and
because the operator's workflow is upload-based, not API-based. The two are
not mutually exclusive; this can be replaced or cross-checked against that
pull later without changing anything downstream (both fill the same
mileage_rows shape).

THE ALGORITHM, AND WHY IT IS SAFE AT THIS ROW DENSITY. Each row carries a
cumulative odometer reading and a reverse-geocoded Location string. Walking
consecutive rows in time order, the ODOMETER DELTA between them is real
distance traveled in that interval; that delta is attributed to the state the
truck was in at the END of the interval (an arbitrary but documented choice --
the alternative, the state at the START, differs from it only at an actual
border crossing). Confirmed on the operator's real file: 5,354 consecutive
deltas, none negative, the largest exactly 2.0 miles -- dense enough that a
whole interval landing on the wrong side of a state line misattributes at
most ~2 miles, immaterial against weekly totals in the thousands. A NEGATIVE
delta (odometer went backwards -- the same corruption CLAUDE.md documents for
the hand-keyed P&L sheet's odometer readings) is dropped, not absorbed: it
would otherwise corrupt the mileage of BOTH the state it's leaving and the
one it's entering.

NO YEAR IN THE FILE. `Time` prints as "Sep 14 7:56AM EDT" -- no year anywhere
in the export, confirmed on the real sample. `year` is therefore a REQUIRED
argument here, never inferred from today's date (that would silently misdate
a backfilled or late-uploaded file), and week_start is computed from the
file's OWN earliest real timestamp (snapped to that week's Monday), never
from the filename -- a renamed upload must not change which week its miles
land in.

COMPANY IS NEVER GUESSED FROM THE FILENAME. The sample file's name happens to
say "Zone_OH_LLC", but this project's standing rule (see CLAUDE.md's taxonomy
and ingest sections; the same rule the hourly upload-processing routine
enforces) is that a document never carries its own company by convention
alone -- `company` is a required argument the uploader/caller must supply.
"""
import argparse
import csv
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

# The full set of two-letter jurisdiction codes IFTA activity might land in --
# every US state (Alaska and Hawaii included even though neither is an IFTA
# member; state_tax_engine.ifta_by_state() already skips any state with no
# filed rate on record, so an unexpected code here costs nothing) plus DC and
# the IFTA member Canadian provinces, so a real cross-border run is captured
# rather than silently dropped as "no state found".
JURISDICTION_CODES = set("""
AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO
MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY
DC AB BC MB NB NL NS ON PE QC SK
""".split())

TIME_RE = re.compile(
    r"^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(AM|PM)\s+([A-Z]{2,4})$")
MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def parse_time(s, year):
    """'Sep 14 7:56AM EDT' + an explicit year -> a real datetime. The
    timezone abbreviation is read but not converted -- every row in one
    export uses the same one, and only relative ordering within the file
    matters here, never a cross-timezone comparison."""
    m = TIME_RE.match(s.strip())
    if not m:
        raise ValueError(f"unrecognized Time value: {s!r}")
    mon, day, hh, mm, ampm, _tz = m.groups()
    hh = int(hh) % 12
    if ampm == "PM":
        hh += 12
    return datetime(year, MONTHS[mon], int(day), hh, int(mm))


def state_of(location):
    """The jurisdiction code out of a 'Street, City, ST[, ZIP]' location
    string -- scanned from the END, since a missing ZIP (confirmed present in
    the real export: 'Hilltop Road, Osseo, WI') shifts every field left by
    one and a fixed column index would grab the city instead of the state."""
    for part in reversed([p.strip() for p in (location or "").split(",")]):
        if part in JURISDICTION_CODES:
            return part
    return None


def monday_of(d):
    return (d - timedelta(days=d.weekday())).date()


def parse_activity_csv(path, company, year):
    """-> (mileage_rows, summary). mileage_rows is analysis.state_tax_engine's
    input shape: [{company, period, unit, state, miles}, ...], one row per
    (state) this truck actually ran real miles in that week. `period` is the
    Monday of the file's own earliest timestamp, as an ISO date string.

    summary carries the reconciliation control: total_miles must equal the
    sum of every state's miles plus whatever a dropped bad reading cost --
    the same "everything must add back to a real total" discipline as every
    other control in this pipeline.
    """
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError(f"{path}: no data rows")

    unit = {r["Vehicle"].strip() for r in rows}
    if len(unit) != 1:
        raise ValueError(
            f"{path}: expected exactly one Vehicle per file, found {sorted(unit)} -- "
            f"this parser assumes one truck per export (confirmed shape of the "
            f"operator's sample); a multi-vehicle export needs a different reader.")
    unit = unit.pop()

    parsed = []
    for r in rows:
        t = parse_time(r["Time"], year)
        odo = float(r["Odometer (mi)"])
        st = state_of(r["Location"])
        parsed.append((t, odo, st, r["Location"]))
    parsed.sort(key=lambda x: x[0])

    week_start = monday_of(parsed[0][0]).isoformat()

    miles_by_state, dropped_negative = {}, 0
    no_state_miles = 0.0
    for (_, odo0, _, _), (t1, odo1, st1, loc1) in zip(parsed, parsed[1:]):
        delta = odo1 - odo0
        if delta < 0:
            dropped_negative += 1
            continue
        if delta == 0:
            continue
        if st1 is None:
            no_state_miles += delta
            continue
        miles_by_state[st1] = miles_by_state.get(st1, 0.0) + delta

    mileage_rows = [
        {"company": company, "period": week_start, "unit": unit, "state": st,
         "miles": round(miles, 1)}
        for st, miles in sorted(miles_by_state.items())
    ]
    summary = {
        "unit": unit, "week_start": week_start, "source_file": str(path),
        "total_miles": round(parsed[-1][1] - parsed[0][1], 1),
        "attributed_miles": round(sum(miles_by_state.values()), 1),
        "no_state_miles": round(no_state_miles, 1),
        "dropped_negative_deltas": dropped_negative,
        "states": sorted(miles_by_state),
        "rows": len(parsed),
        "first_seen": parsed[0][0].isoformat(),
        "last_seen": parsed[-1][0].isoformat(),
    }
    return mileage_rows, summary


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv_path")
    ap.add_argument("--company", required=True, help="never guessed from the filename")
    ap.add_argument("--year", type=int, required=True, help="the Time column carries no year")
    a = ap.parse_args()
    rows, summary = parse_activity_csv(a.csv_path, a.company, a.year)
    print(f"unit {summary['unit']}, week of {summary['week_start']}: "
          f"{summary['total_miles']} mi total ({summary['rows']} rows, "
          f"{summary['first_seen']} .. {summary['last_seen']})")
    for r in rows:
        print(f"  {r['state']}: {r['miles']} mi")
    if summary["no_state_miles"]:
        print(f"  UNATTRIBUTED (no state parsed from Location): {summary['no_state_miles']} mi")
    if summary["dropped_negative_deltas"]:
        print(f"  DROPPED {summary['dropped_negative_deltas']} negative-odometer "
              f"reading(s) -- see module docstring", file=sys.stderr)
    check = summary["attributed_miles"] + summary["no_state_miles"]
    if abs(check - summary["total_miles"]) > 0.5:
        print(f"  CONTROL FAILED: states+unattributed={check} != total={summary['total_miles']}",
              file=sys.stderr)


if __name__ == "__main__":
    main()
