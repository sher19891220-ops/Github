"""
Truck and trailer tire cost per mile, measured -- not benchmarked.

The "ZONE_MAINT_MASTER" Google Sheet (data/raw/pnl/gs-ZONE_master_truck_
trailer_expenses.xlsx, pulled via ingest/pull_sheets.py, read by
analysis/maintenance_ledger.py) already carries every repair line item,
including tires, tagged 'tires/rims' by maintenance_ledger.py's own
CATEGORIES regex (tire|tyre|rim|mudfl). COST_METHODOLOGY.md originally cited
an industry benchmark ($0.03-0.04/mile) for tire amortization because
nobody had yet queried this ledger's own tires/rims category for a real
number. It has one: 252 tire-related charges across the three companies,
2025-01 through 2026-09-01. This module measures it instead of guessing.

COMPANY-BORNE ONLY, same rule as truck_maintenance.py: driver-billed and
Iron-Lease-reversal rows are not a company cost (see that module's
docstring and CLAUDE.md's Truck Max recovery chain).

TRUCK AND TRAILER, COMBINED, per LOADED MILE -- matching every other
variable-cost line in this pipeline (fuel, driver pay, tolls all already
blend the whole running fleet's cost over its own miles the same way). A
trailer's tires cost the same regardless of which truck is pulling it, so
this is reported per mile rather than split and assigned to trucks alone.

WINDOW MATCHES truck_maintenance.py's OWN (2026-02-23..2026-08-24) --  the
one span every company's P&L mileage actually covers, so cost and miles
come from the same period rather than an unmatched wider one.
"""
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import maintenance_ledger as ML  # noqa: E402
import truck_maintenance as TM  # noqa: E402

COMPANIES = ("ZONE", "XTRACK", "AFG")
WINDOW = ("2026-02-23", "2026-08-24")


def company_figures(start=WINDOW[0], end=WINDOW[1]):
    out = {}
    for co in COMPANIES:
        charged, _ = ML.load(co, start=start, end=end)
        tires = charged[(charged.category == "tires/rims")
                         & (charged.borne_by.isin(TM.COMPANY_BORNE))]
        by_type = {k: round(v, 2) for k, v in tires.groupby("unit_type").amount.sum().items()}
        pnl = pd.read_csv(ROOT / f"data/processed/pnl_unit_week_{co}.csv")
        pnl = pnl[(pnl.week_start >= start) & (pnl.week_start <= end)]
        miles = pnl.mileage.sum()
        total = tires.amount.sum()
        out[co] = {
            "company_borne_total": round(total, 2),
            "by_unit_type": by_type,
            "n_charges": int(len(tires)),
            "miles_in_window": round(miles),
            "cost_per_mile": round(total / miles, 5) if miles else None,
        }
    return out


def fleet_figure(figures):
    total = sum(f["company_borne_total"] for f in figures.values())
    miles = sum(f["miles_in_window"] for f in figures.values())
    return {"total": round(total, 2), "miles": miles,
            "cost_per_mile": round(total / miles, 5) if miles else None}


def main():
    figures = company_figures()
    fleet = fleet_figure(figures)
    print(f"Tire cost (truck + trailer, company-borne), {WINDOW[0]}..{WINDOW[1]}:")
    for co, f in figures.items():
        print(f"  {co}: ${f['company_borne_total']:,.2f} over {f['n_charges']} charges, "
              f"${f['cost_per_mile']:.4f}/mile -- {f['by_unit_type']}")
    print(f"  FLEET: ${fleet['total']:,.2f} over {fleet['miles']:,} miles "
          f"= ${fleet['cost_per_mile']:.4f}/mile")


if __name__ == "__main__":
    main()
