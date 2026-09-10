"""Ohio BMV's own IRP Vehicle Status report -- a FILING, not a payment sheet.

This is a different document from `data/raw/permits/`'s HVUT/IRP payment
list: it is the state's own snapshot of which units are ACTIVELY registered
on one IRP account right now, run on demand from the Ohio Department of
Public Safety, Bureau of Motor Vehicles. Per CLAUDE.md's evidence hierarchy
("a filing... > a counterparty's invoice or policy > cash... > the sheet
against itself"), this outranks the internal group unit workbook the same
way an IFTA return outranks the P&L sheet.

Two fixed-width columns per row (UNIT, USDOT, VIN, STATUS, WEIGHT GROUP,
TYPE, YEAR, MAKE, PLATE) repeat across as many pages as the fleet needs.
"""
import re
from pathlib import Path

import pdfplumber

ROW = re.compile(
    r"^(\S+)\s+(\d{9})\s+([A-Z0-9]{17})\s+([A-Z])\s+(\d+)\s+(\S+)\s+"
    r"(\d{4})\s+(\S+)\s+(\S+)$")


def read(path):
    """One row per registered unit. `unit` is the STATE's own designation --
    the number this document names a truck, which is not guaranteed to be
    the same number the internal group unit workbook uses for it (confirmed:
    it is not, for two trucks -- see registration.py's unit_number_corrections)."""
    out = []
    header = {}
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for line in (page.extract_text() or "").splitlines():
                if line.startswith("Account No"):
                    header["account"] = line.split(":")[1].split("Fleet")[0].strip()
                elif line.startswith("Legal Name"):
                    header["legal_name"] = line.split(":", 1)[1].split("Fleet")[0].strip()
                elif line.startswith("Total Units"):
                    header["stated_total"] = int(line.split(":")[1].split("TIN")[0].strip())
                m = ROW.match(line.strip())
                if m:
                    out.append({"unit": m.group(1), "usdot": m.group(2), "vin": m.group(3),
                               "status": m.group(4), "weight_group": m.group(5),
                               "type": m.group(6), "year": int(m.group(7)),
                               "make": m.group(8), "plate": m.group(9)})
    return out, header


def controls(rows, header):
    """The one check this document can be held to: it states its own count."""
    fails = []
    if "stated_total" in header and len(rows) != header["stated_total"]:
        fails.append((f"parsed {len(rows)} rows, filing states "
                      f"{header['stated_total']} total units", None))
    dupe_vins = {r["vin"] for r in rows if sum(1 for x in rows if x["vin"] == r["vin"]) > 1}
    if dupe_vins:
        fails.append(("a VIN appears more than once in one filing", sorted(dupe_vins)))
    return fails


def compare_to_group_workbook(rows, registry_rows):
    """Cross the filing's own unit numbers against the internal group unit
    workbook's, by VIN -- the only identifier both documents actually share.
    Returns (renumbered, unmatched): renumbered is every VIN where the two
    documents name the truck differently; unmatched is every filed VIN with
    no match in the workbook at all (never expected to be non-empty for a
    healthy corpus -- a filed, plated truck the group's own workbook has
    never heard of would be a real gap, not a formatting quirk)."""
    by_vin = {r["vin"]: r for r in registry_rows}
    renumbered, unmatched = [], []
    for row in rows:
        reg = by_vin.get(row["vin"])
        if not reg:
            unmatched.append(row)
        elif row["unit"] not in reg["units"]:
            renumbered.append((row["unit"], reg["units"], reg["company"],
                               reg["owner_operator"]))
    return renumbered, unmatched


if __name__ == "__main__":
    import sys
    p = sys.argv[1] if len(sys.argv) > 1 else \
        "data/raw/permits/irp_status/zone_oh_irp_vehicle_status_2026-09-09.pdf"
    rows, header = read(p)
    fails = controls(rows, header)
    print(f"{header.get('legal_name')}, account {header.get('account')}: "
          f"{len(rows)} active units")
    for f, detail in fails:
        print(f"  CONTROL FAILED: {f} {detail or ''}")
