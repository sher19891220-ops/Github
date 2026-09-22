"""
The lease-to-purchase (LTP) roster: which drivers/trucks are actually on an
Iron Lease lease-to-purchase contract, and what they've actually paid down,
week by week -- from the operator's own "Iron lease Leased trucks" Google
Sheet (id 1X28pWOL4DDTpml9ZcNyqiukUVLxrSn5qmu0riI-gAOg).

WHY THIS EXISTS. config/driver_arrangement_rates.json has carried a STATED
lease-to-purchase rate card ($1,000/week truck_payment) since 2026-09-08,
with its own note flagging a real conflict: this exact sheet shows truck
2703 charged $1,500/week, not $1,000. Nobody had actually read the sheet
until 2026-09-22 (via Claude's Google Drive connector -- CLAUDE.md forbids
the old GSHEETS_SERVICE_ACCOUNT key entirely, see "DO NOT use the Google
Sheets API key"). This module is that read, turned into a parser.

A DIFFERENT, UNTRACKED COPY OF THIS SAME DATA ALREADY EXISTED IN THIS
CONTAINER (`data/raw/iron_lease/leased_trucks_weekly.csv`, provenance
unknown, gitignored, never committed) when this module was written. It is
NOT used here: it silently zero-fills Evanuel Derilus's missing 08.18.26
snapshot (`charged_amount=0.0, left_amount=0.0`) instead of leaving it
blank -- the exact "missing treated as zero" failure mode this pipeline's
own conventions exist to catch elsewhere (see config/insurance.json: "A
missing premium is not a free policy"). This module's own snapshot file
(pulled directly via Claude's Google Drive connector, 2026-09-22)
preserves the real blank as a real blank; do not swap in the other CSV
without re-checking it row for row first.

THE SHEET IS ONE TAB, STACKED WEEKLY SNAPSHOTS -- not one-tab-per-week like
the P&L workbooks. Each snapshot repeats the same ~11-12 rows (one per
LTP driver) with that week's Overall/Charged/Left amount. There is no
snapshot for every calendar week (a driver can be missing a week's row
entirely, e.g. Evanuel Derilus on 08.18.26 -- captured as NaN, never
assumed zero).

THE 'LO' MARKER IN THIS SHEET'S COMMENTS COLUMN MEANS LEASE-TO-WALKAWAY --
CONFIRMED BY THE ACCOUNTING TEAM, 2026-09-22 ("LO- lease to walkaway").
This is UNRELATED to the 'LO' text found scattered in the weekly P&L
sheets' per-load row sequences (see analysis/xtrack_diagnosis.py's
corrected docstring and analysis/driver_arrangement.py) -- same two
letters, two different documents, two different (unrelated) meanings.
Do not conflate them.

A DRIVER'S TRUCK NUMBER CAN CHANGE MID-CONTRACT. Petit Noel Judeler's
rows show truck 8091 through 08.04.26 and truck 8132 from 08.11.26 on --
per the accounting team: "lease to purchase contract boshida 8091 truck
uchun boganidi lekn truckda issuela kop chqganiga 8132 truckga contract
ozgartirilgan" (the original truck had too many issues, so the contract
was moved to a different truck). This is the SAME driver's SAME contract,
not a new one -- rows are keyed on driver name for the paydown history,
truck number is carried as a point-in-time attribute per snapshot.

STATUS PER SNAPSHOT, FROM THE COMMENTS COLUMN:
    (blank)                                  actively paying down LTP
    'Truck taken back'                       terminated -- not a cost input
    'Temporary skip, working as CD'          paused; driving as company driver
    'Temporary skip, working as Lease to     paused; driving as lease-to-
     walkaway' / '...working as LO'          walkaway for that stretch
A driver paused mid-contract is NOT accruing LTP paydown that week -- the
comment explains why a week's Charged amount did not move, it is not noise.

REAL PER-DRIVER WEEKLY PAYDOWN, NOT THE STATED $1,000. Diffing consecutive
snapshots' Charged amount per driver gives the actual dollar figure --
Nelson Reginald's own contract (accounting team, 2026-09-22) is $1,500/week
regular payment, confirmed by the diffs here, plus a $2,000 catch-up
deposit he is behind on -- that deposit is a receivable, not a weekly rate,
and must not be blended into a per-week average.
"""
import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT_FILE = ROOT / "data/raw/iron_lease/ltp_roster_pulled_2026-09-22.md"

TERMINATED = "terminated"
TEMP_CD = "temp_company_driver"
TEMP_LTWA = "temp_lease_to_walkaway"
ACTIVE_LTP = "active_ltp"


def _money(s):
    """A blank cell (no data reported that snapshot, e.g. Evanuel Derilus on
    08.18.26) is None -- missing, not zero. An explicit dash ('$ -') is a
    STATED zero, e.g. Alphonse Jefferson's Left amount once his balance is
    paid off -- these are not the same thing and must not collapse together."""
    if s is None:
        return None
    s = str(s).strip()
    if s == "":
        return None
    if s in ("-", "$ -", "$-", "$-   "):
        return 0.0
    s = s.replace("$", "").replace(",", "").strip()
    if s in ("", "-"):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return None


def _status(comment):
    c = (comment or "").strip().lower()
    if not c:
        return ACTIVE_LTP
    if "truck taken back" in c:
        return TERMINATED
    if "working as cd" in c:
        return TEMP_CD
    if "working as lease to walkaway" in c or "working as lo" in c:
        return TEMP_LTWA
    return ACTIVE_LTP


def parse(path=SNAPSHOT_FILE):
    """Every driver-week row across every snapshot block in the sheet."""
    text = path.read_text()
    blocks = re.split(r"\|\s*\\#\s*\|\s*Name\s*\|", text)[1:]
    rows = []
    for block in blocks:
        date_m = re.search(r"Information as of (\d{2}\.\d{2}\.\d{2})", block)
        if not date_m:
            continue
        snap = pd.to_datetime(date_m.group(1), format="%m.%d.%y")
        for line in block.splitlines():
            line = line.strip()
            if not line.startswith("|") or "Information as of" in line or ":-:" in line:
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) < 7 or not cells[0].isdigit():
                continue
            rank, name, unit, date_given = cells[0], cells[1].strip(), cells[2].strip(), cells[3]
            overall, charged, left = _money(cells[4]), _money(cells[5]), _money(cells[6])
            comment = cells[7] if len(cells) > 7 else ""
            rows.append({
                "snapshot_date": snap, "rank": int(rank), "driver_name": name,
                "unit": unit, "date_given": date_given,
                "overall_amount": overall, "charged_amount": charged,
                "left_amount": left, "comment": comment,
                "status": _status(comment),
            })
    return pd.DataFrame(rows).sort_values(["driver_name", "snapshot_date"]).reset_index(drop=True)


def weekly_paydown(df):
    """Actual $ paid down per driver per week, from consecutive snapshots'
    Charged amount -- the MEASURED rate, replacing the stated $1,000/week.
    Only rows where BOTH ends are 'active_ltp' count as a real weekly
    paydown; a week straddling a temp CD/walkaway/terminated status is
    excluded, since the driver was not accruing LTP payments then."""
    out = []
    for name, g in df.groupby("driver_name"):
        g = g.sort_values("snapshot_date")
        prev = None
        for _, row in g.iterrows():
            # pandas stores a missing charged_amount as NaN, not None, once
            # it's inside a float column -- `is not None` never catches
            # that, so a snapshot with no reported figure (e.g. Evanuel
            # Derilus on 08.18.26) would silently produce a NaN delta
            # instead of being excluded. pd.notna() catches both.
            if prev is not None and pd.notna(row["charged_amount"]) and pd.notna(prev["charged_amount"]):
                days = (row["snapshot_date"] - prev["snapshot_date"]).days
                if days > 0 and prev["status"] == ACTIVE_LTP and row["status"] == ACTIVE_LTP:
                    delta = row["charged_amount"] - prev["charged_amount"]
                    out.append({
                        "driver_name": name, "unit": row["unit"],
                        "from": prev["snapshot_date"], "to": row["snapshot_date"],
                        "days": days, "delta": delta,
                        "per_week": delta / days * 7,
                    })
            prev = row
    return pd.DataFrame(out)


STATUS_TO_ARRANGEMENT = {
    ACTIVE_LTP: "lease_to_purchase",
    TEMP_LTWA: "lease_to_walk_away",
    # TEMP_CD and TERMINATED are deliberately not mapped: a truck temporarily
    # back to company-driver status is priced by the ordinary CD model
    # (cost_structure.py), and a terminated one is not this pipeline's cost
    # to price under any arrangement at all.
}


def unit_arrangements(df=None):
    """{unit: arrangement} for every truck CURRENTLY on this roster, using
    only the arrangement names analysis/driver_arrangement.py knows how to
    price (lease_to_purchase, lease_to_walk_away). This is the resolver
    that was missing entirely before 2026-09-22 -- config/driver_
    arrangement_rates.json had rate cards with no roster to apply them to.
    It only covers Iron-Lease-financed trucks; a plain owner-operator truck
    is never on this roster at all, so it says nothing about OO."""
    df = df if df is not None else parse()
    latest = latest_status(df)
    out = {}
    for _, r in latest.iterrows():
        arrangement = STATUS_TO_ARRANGEMENT.get(r.status)
        if arrangement:
            out[r.unit] = arrangement
    return out


def latest_status(df):
    """One row per driver: their most recent snapshot, i.e. where they
    stand right now -- active LTP, paused, or terminated."""
    idx = df.groupby("driver_name")["snapshot_date"].idxmax()
    return df.loc[idx].sort_values("rank").reset_index(drop=True)


def main():
    df = parse()
    print(f"{len(df)} driver-week rows, {df.driver_name.nunique()} drivers, "
          f"{df.snapshot_date.nunique()} snapshots ({df.snapshot_date.min().date()} "
          f".. {df.snapshot_date.max().date()})")
    print()
    print("LATEST STATUS PER DRIVER:")
    for _, r in latest_status(df).iterrows():
        print(f"  {r.driver_name:<22}unit {r.unit:<8}{r.status:<20}"
              f"left ${r.left_amount:,.0f}" if r.left_amount is not None else
              f"  {r.driver_name:<22}unit {r.unit:<8}{r.status}")
    print()
    pay = weekly_paydown(df)
    print("MEASURED WEEKLY PAYDOWN (active-LTP weeks only):")
    for name, g in pay.groupby("driver_name"):
        print(f"  {name:<22}avg ${g.per_week.mean():>8,.0f}/wk over {len(g)} intervals")


if __name__ == "__main__":
    sys.exit(main())
