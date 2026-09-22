"""
The residual owner-operator roster: every truck the weekly P&L classifies
with the owner-operator block layout (analysis/xtrack_diagnosis.py) that is
NOT on the Iron Lease lease-to-purchase/lease-to-walk-away roster
(analysis/driver_arrangement.known_arrangements(), from ingest/
ingest_iron_lease_ltp_roster.py).

WHY THIS EXISTS. Asked to "build a roster for owner-operator trucks too"
(2026-09-22, same day the Iron Lease roster resolved LTP/LTWA), the
straightforward answer is that one already sits inside data this pipeline
already has: the P&L's own block layout ALREADY tags every truck
company_driver or owner_operator every single week
(analysis/xtrack_diagnosis.py's read_blocks()) -- "owner_operator" here
means "the owner-operator/lease-to-own COLUMN LAYOUT," which lease-to-
purchase and lease-to-walk-away trucks use too (same docstring: "owner-
operator AND lease-to-own" share one header). So this module is
subtraction, not new ingestion: owner-operator-layout units, minus the
ones the Iron Lease roster says are actually LTP or LTWA, leaves the
trucks that are neither company-driver nor Iron-Lease-financed.

WHAT THIS IS NOT: A CONFIRMED PLAIN-OWNER-OPERATOR LIST. "Not on the Iron
Lease roster" only rules out ONE financing source. docs/ACCOUNTING_
MODEL.md Section 3 and the operator's own 2026-09-21 message name at
least four OTHER truck-rental sources this pipeline has no roster for at
all: STL, Right Truck Deal, Penske, and Ryder ("Truck rental for penske
and Ryder units we have charges according to contract... stl needs to be
according to the charge we are receiving from right truck deal and stl").
A unit here could be financed through any of those, not necessarily owned
outright by its driver. Read the result of this module as "not
Iron-Lease-financed, not company-driver," not as "confirmed OO," until
one of those other rosters is ingested too.

CURRENT SNAPSHOT, NOT FULL HISTORY. A unit is classified by its MOST
RECENT week's kind in the P&L, checked against the Iron Lease roster's
CURRENT status -- the same current-snapshot approach known_arrangements()
already uses. A truck that ran plain OO for months before entering an
Iron Lease LTP contract (or the reverse) is not retroactively
reclassified week by week here; only where it stands NOW.

A UNIT CAN LEGITIMATELY APPEAR UNDER MORE THAN ONE COMPANY. Already
established throughout this pipeline (analysis/truck_weeks.py, docs/
FINDINGS.md) -- trucks move between ZONE/XTRACK/AFG. Appearing in more
than one company's roster here is not a bug.
"""
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
import truck_weeks as T          # noqa: E402
import driver_arrangement as D   # noqa: E402

COMPANIES = ("ZONE", "XTRACK", "AFG")


def roster(company, known=None):
    """One row per unit whose MOST RECENT P&L week is owner-operator-kind
    in this company, and that is not on the current Iron Lease LTP/LTWA
    roster. `known` lets a caller pass a pre-computed known_arrangements()
    result once across all three companies instead of re-reading the
    roster file per company."""
    known = known if known is not None else set(D.known_arrangements().keys())
    tw = T.truck_weeks(company)
    tw = tw.assign(unit=tw.unit.astype(str).str.strip())
    last = tw.sort_values("week").groupby("unit").tail(1)
    oo = last[last.kind == "owner_operator"]
    residual = oo[~oo.unit.isin(known)]
    return (residual[["unit", "driver", "week", "kind"]]
            .rename(columns={"week": "last_week"})
            .sort_values("unit").reset_index(drop=True))


def full_roster():
    """Every company's residual roster in one frame, tagged by company."""
    known = set(D.known_arrangements().keys())
    frames = []
    for co in COMPANIES:
        r = roster(co, known=known)
        r = r.assign(company=co)
        frames.append(r)
    return pd.concat(frames, ignore_index=True)


def main():
    full = full_roster()
    print(f"{len(full)} unit-company rows, {full.unit.nunique()} distinct units "
          f"-- NOT company-driver, NOT on the Iron Lease LTP/LTWA roster")
    print("(may include STL / Right Truck Deal / Penske / Ryder trucks -- "
          "see this module's docstring)")
    for co in COMPANIES:
        n = len(full[full.company == co])
        print(f"  {co}: {n} units")
    dupes = full.groupby("unit").company.nunique()
    moved = dupes[dupes > 1]
    if len(moved):
        print(f"\n{len(moved)} units appear under more than one company "
              f"(moved companies): {sorted(moved.index)}")


if __name__ == "__main__":
    main()
