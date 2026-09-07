"""Truck Max's own invoice log -- the source CLAUDE.md described before it existed.

Four files, one per payer, and together they are the "Date | Truck | Trailer |
Invoice number | Issue | ... | Inv amount" invoice log this repository's own
notes have referenced since the Truck Max recovery chain was first documented:
every invoice lands in exactly one of three payer columns (`Zone`/`Iron Lease`/
`Driver` in the group's own template), and here that split is already done --
each payer got its own workbook instead of its own column.

    Company_exp.xlsx      426 rows   the operating company pays, keeps it
    Driver_exp.xlsx         27 rows  billed to a driver's settlement
    Iron_Lease_exp.xlsx     80 rows  Iron Lease's own truck
    Sher_Imam.xlsx            7 rows an owner's name, same as the "sher imam
                                     exp" bucket already seen in
                                     maintenance_ledger.py's Expense side column

THIS IS ADDITIONAL TO `maintenance_ledger.py`, NOT AN OVERLAP. Every invoice
number in these four files was checked against the existing
`*_Truck_and_Trailer_Expenses_2026.xlsx` ledgers' own IDs: zero matches. These
also reach back to 2025-08, five months earlier than the existing ledger's
2026-01 start. So the two sources are added, never merged into one and
deduplicated -- there is nothing to deduplicate.

INVOICE NUMBERS ARE NOT UNIQUE, EVEN WITHIN ONE FILE. `INV0015` appears twice in
Company_exp.xlsx alone -- once for truck 8133 on 2025-08-28, once for trailer
536050 on 2025-08-27. Numbers also repeat ACROSS the four files: `INV0001` is a
$3,920.69 charge on truck 289909 in Company_exp and an unrelated $1,196.57
charge on truck 6169 in Driver_exp, same invoice number, different truck,
different date, different amount. So the identity of a row is never the
invoice number alone -- it is (source file, date, truck-or-trailer, amount) --
and nothing here is deduplicated across files on invoice number, because the
checked cases prove there is nothing to deduplicate.

EVERY FILE ENDS WITH A PRINTED TOTAL ROW, and it is the control: each file's
detail rows must sum to it. Iron_Lease_exp's total row happens to print its
dollar figure as the STRING "$159 187.96" (a space, not a comma), which
`pd.to_numeric` correctly refuses to parse -- but that is a coincidence of
formatting, not a rule, so the row is also matched and dropped explicitly by
its "TOTAL" label rather than relied upon to fail parsing.

`Sher_Imam.xlsx` HAS NO HEADER ROW AT ALL -- openpyxl hands back `Unnamed: 0..4`
and the columns are assigned by position here, matching the other three files'
order (date, truck, invoice, issue, amount).

TRUCK NUMBERS ARE MESSIER THAN THE OTHER LEDGERS. `# 001` (Driver_exp, a
literal '#' and a space before the digits) is truck 001 -- ZONE's own P&L keeps
that leading zero, so it is preserved, not cast through int(). `detailing` and
`cleaning` (Company_exp) are not truck numbers at all: a wash and a facility
cleaning charge that were entered in the Truck column with the service name.
Neither resolves to a truck, and both are reported as unresolvable rather than
guessed into a real unit.
"""
import re
import sys
import warnings
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
INVOICE_DIR = ROOT / "data/raw/truckmax/invoices"
FILES = {
    "company": (INVOICE_DIR / "97d35052-Company_exp.xlsx", "Company", "Zone", True),
    "driver": (INVOICE_DIR / "cead6fb1-Driver_exp.xlsx", "Driver", "Amount", True),
    "iron_lease": (INVOICE_DIR / "02be1048-Iron_Lease_exp.xlsx", "Iron Lease",
                  "Amount", True),
    "sher_imam": (INVOICE_DIR / "660f60f1-Sher_Imam.xlsx", "Sher Imam",
                 "Amount", False),
}
COLUMNS = ["date", "truck_raw", "invoice", "issue", "amount"]
# Values seen in the Truck column that are not truck numbers at all.
NOT_A_TRUCK = {"detailing", "cleaning"}


def clean_truck(v):
    """A truck number, a trailer's, or None -- never guessed.

    '# 001' -> '001': strip everything but digits, but do NOT cast through
    int(), which would drop the leading zero ZONE's own P&L keeps for that
    truck. A bare service name is not a truck at all and returns None.

    FLOATS ARE HANDLED BEFORE ANY STRING SURGERY, on purpose. openpyxl hands
    back most truck numbers as float64 (15862.0), and str(15862.0) is
    '15862.0' -- stripping non-digits from THAT string deletes only the '.'
    and keeps the '0' after it, turning 15862 into 158620. Every truck in this
    file that was not '# 001' silently gained a trailing zero this way until
    caught: unit 6867 became 68670, 15909 became 159090. A whole-number float
    is cast through int() first so the digit-strip below never sees a decimal
    point at all.
    """
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).strip()
    if s.lower() in NOT_A_TRUCK:
        return None
    digits = re.sub(r"\D", "", s)
    return digits or None


def clean_date(v):
    """Company_exp has one row as ': 07/18/2026' -- a stray leading colon and
    space in front of an otherwise ordinary date. Strip leading punctuation
    before parsing rather than letting the whole row's date go to NaT."""
    if isinstance(v, str):
        v = re.sub(r"^[:\s]+", "", v)
    return pd.to_datetime(v, errors="coerce")


def read_one(payer, path, sheet, amount_col, has_header):
    if has_header:
        d = pd.read_excel(path, sheet_name=sheet)
        d = d.rename(columns={"Date": "date", "Truck": "truck_raw",
                              "Invoice number": "invoice", "Issue": "issue",
                              amount_col: "amount", "Trailer": "trailer_raw"})
    else:
        d = pd.read_excel(path, sheet_name=sheet, header=None)
        d.columns = COLUMNS[:len(d.columns)]
        d["trailer_raw"] = None

    if "trailer_raw" not in d.columns:
        d["trailer_raw"] = None

    # The printed total row: matched by its own label, not by whether the
    # amount happens to fail numeric parsing. Iron_Lease_exp's total prints as
    # the string "$159 187.96", which pd.to_numeric refuses anyway -- but
    # relying on that would be luck, not a rule, for a file that prints its
    # total as a clean number instead.
    is_total = d.issue.astype(str).str.strip().str.upper().eq("TOTAL")
    printed_total = pd.to_numeric(
        d.loc[is_total, "amount"].astype(str).str.replace(r"[$,\s]", "", regex=True),
        errors="coerce").sum() if is_total.any() else None

    d = d[~is_total].copy()
    d["date"] = d.date.apply(clean_date)
    d["amount"] = pd.to_numeric(d.amount, errors="coerce")
    d["truck"] = d.truck_raw.apply(clean_truck)
    d["trailer"] = d.trailer_raw.apply(
        lambda v: str(int(v)) if isinstance(v, (int, float)) and pd.notna(v) else
        (str(v).strip() if pd.notna(v) else None))
    d["unresolvable_truck"] = (d.truck_raw.notna() & d.truck.isna()
                               & d.trailer.isna())
    d["is_trailer"] = d.trailer.notna() & d.truck.isna()
    d["payer"] = payer
    d["source"] = str(path.relative_to(ROOT)) if ROOT in path.parents else str(path)

    charged = d[d.amount.notna()].copy()
    return charged, printed_total


def load():
    """Every charge from all four files, plus the control against each file's
    own printed total."""
    frames, controls = [], []
    for payer, (path, sheet, amount_col, has_header) in FILES.items():
        if not path.exists():
            continue
        charged, printed = read_one(payer, path, sheet, amount_col, has_header)
        detail_sum = charged.amount.sum()
        controls.append({"payer": payer, "rows": len(charged),
                         "detail_sum": detail_sum, "printed_total": printed,
                         "ties": printed is None or abs(detail_sum - printed) < 1.0})
        frames.append(charged)
    all_charges = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    return all_charges, controls


def main():
    charges, controls = load()
    print(f"{len(charges)} invoice-level charges across {len(controls)} files, "
          f"${charges.amount.sum():,.2f}")
    for c in controls:
        mark = "ties" if c["ties"] else f"OFF by ${c['detail_sum'] - c['printed_total']:,.2f}"
        print(f"  {c['payer']:<12}{c['rows']:>4} rows  ${c['detail_sum']:>12,.2f}  {mark}")

    print(f"\n  by payer:")
    print(charges.groupby("payer").amount.agg(["count", "sum"])
          .to_string(float_format="${:,.2f}".format))
    print(f"\n  trailer-only charges: {charges.is_trailer.sum()}, "
          f"${charges[charges.is_trailer].amount.sum():,.2f}")
    unresolved = charges[charges.unresolvable_truck]
    if len(unresolved):
        print(f"  unresolvable truck values: "
              f"{unresolved.truck_raw.unique().tolist()}, "
              f"${unresolved.amount.sum():,.2f}")
    print(f"\n  date range: {charges.date.min()} .. {charges.date.max()}")
    print(f"  distinct trucks: "
          f"{charges[charges.truck.notna()].truck.nunique()}")


if __name__ == "__main__":
    main()
