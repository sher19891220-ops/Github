"""Triumph factoring invoice lists -- the only outside record of REVENUE.

The IFTA returns test the miles and the Iron Lease invoices test the rent, but
until these were read nothing outside the group's own spreadsheets said what was
actually billed. Triumph buys the invoices, so its list is written by the
counterparty: one row per load, with the amount, the customer and -- the part
the sheets cannot show -- what happened to it.

WHAT THIS FILE CAN AND CANNOT DO. There is no amount-received column, so it
cannot say what was collected on any one invoice; a 'Short Paid' row still
carries the FULL invoice value. What it can say is which invoices the factor
would not or did not carry, and that is the finding: an invoice the factor
denies is one the operating company has to collect itself, while the weekly P&L
has already credited the truck with the gross.

THE TOTAL ROW DOUBLES EVERY FIGURE. Each sheet ends with an unlabelled row
carrying the grand total in the amount column. Summing the sheet as read gives
exactly twice the real number -- and it looks plausible, because it is exactly
the total the file itself prints. It is dropped here by its blank Status, and
then used as a CONTROL: the detail rows must sum to it.

THE SAME INVOICE IS IN MORE THAN ONE FILE. The exception lists overlap the full
list, so a naive concatenation counts a short-paid invoice twice. Key on the
invoice number within the entity -- EXCEPT where the invoice number is a
placeholder. Two different invoices are both numbered "TBD", one Rejected at
$5,200 and one Held at $1,700, and de-duplicating on that number silently merged
them and lost the Held one entirely. A placeholder is not an identity.
"""
import re
import warnings
from collections import defaultdict
from pathlib import Path

import openpyxl

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parent.parent
FACTORING = [
    ROOT / "data/raw/xtrack/b5815381-Invoice_List_XTRACK.xlsx",
    ROOT / "data/raw/xtrack/2b75e3c2-Invoice_List_19.xlsx",
    ROOT / "data/raw/xtrack/2f5eae22-Invoice_list_STL.xlsx",
]
HEADER_CELL = "Invoice"
# The trailing grand-total row labels itself in the Invoice column.
TOTAL_LABEL = "Totals"
# Values that are not invoice numbers, so cannot be used to tell invoices apart.
PLACEHOLDER_IDS = {"TBD", "N/A", "", "NONE"}
# Statuses where the money is not safely in. 'Funded' means advanced but not yet
# settled by the debtor, which on a recourse facility is not the same as Paid --
# it is reported separately rather than lumped either way.
AT_RISK = ("Short Paid", "Denied", "Recoursed", "Rejected", "Held")
SETTLED = ("Paid",)
ENTITY = [(r"ZONE", "ZONE"), (r"XTRACK", "XTRACK"), (r"AFG", "AFG")]


def entity_of(text):
    for pat, ent in ENTITY:
        if re.search(pat, (text or "").upper()):
            return ent
    return None


def read_sheet(ws):
    """Rows and the sheet's own printed total, separately."""
    rows = list(ws.iter_rows(values_only=True))
    hdr = next((i for i, r in enumerate(rows)
                if r and str(r[0]).strip() == HEADER_CELL), None)
    if hdr is None:
        return None, [], None
    cols = [str(c).strip() if c is not None else "" for c in rows[hdr]]
    # The entity is printed above the header, not in a column.
    ent = None
    for r in rows[:hdr]:
        for c in r or ():
            ent = ent or entity_of(str(c) if c else "")
    body, printed_total = [], None
    for r in rows[hdr + 1:]:
        if not r or not r[0]:
            continue
        d = dict(zip(cols, r))
        amt = d.get("Invoice Amount")
        amt = float(amt) if isinstance(amt, (int, float)) else None
        # The trailing row IS the grand total, and it labels itself. Summing the
        # sheet with it included gives exactly twice the real figure and looks
        # right, because it is the number the file itself prints.
        if (str(d.get(HEADER_CELL) or "").strip().lower() == TOTAL_LABEL.lower()
                or not str(d.get("Status") or "").strip()):
            printed_total = amt
            continue
        d["amount"] = amt
        d["entity"] = ent
        body.append(d)
    return ent, body, printed_total


def load(paths=None):
    """Every invoice, once, plus the control that each sheet's detail ties."""
    out, controls, seen = [], [], set()
    for p in (paths or FACTORING):
        if not Path(p).exists():
            continue
        wb = openpyxl.load_workbook(p, data_only=True, read_only=True)
        for ws in wb:
            ent, body, printed = read_sheet(ws)
            if not body:
                continue
            detail = sum(r["amount"] or 0 for r in body)
            controls.append({"file": Path(p).name, "sheet": ws.title,
                             "entity": ent, "rows": len(body),
                             "detail": detail, "printed_total": printed,
                             "ties": printed is not None
                                     and abs(detail - printed) < 0.01})
            for r in body:
                num = str(r.get(HEADER_CELL) or "").strip()
                # A placeholder number identifies nothing. Fall back to the whole
                # row so two "TBD" invoices stay two invoices.
                key = ((r["entity"], num) if num.upper() not in PLACEHOLDER_IDS
                       else (r["entity"], num, r["Status"], r["amount"],
                             str(r.get("Invoice Date"))))
                if key in seen:
                    continue
                seen.add(key)
                r["source"] = f"{Path(p).name}[{ws.title}]"
                out.append(r)
        wb.close()
    return out, controls


def by_status(rows):
    agg = defaultdict(lambda: [0, 0.0])
    for r in rows:
        s = str(r.get("Status") or "?").strip()
        agg[s][0] += 1
        agg[s][1] += r["amount"] or 0
    return {k: tuple(v) for k, v in agg.items()}


def at_risk(rows):
    return [r for r in rows if str(r.get("Status") or "").strip() in AT_RISK]


def week_of(d):
    """The Monday of the invoice's week, matching the P&L tab convention."""
    import datetime as dt
    if not hasattr(d, "year"):
        return None
    day = d.date() if hasattr(d, "date") else d
    return (day - dt.timedelta(days=day.weekday())).isoformat()


def main():
    rows, controls = load()
    print(f"{len(rows)} invoices after de-duplication\n")
    print("  CONTROL -- each sheet's detail rows against the total it prints")
    for c in controls:
        mark = "ties" if c["ties"] else ("NO TOTAL PRINTED" if c["printed_total"] is None
                                         else f"OFF BY {c['detail'] - c['printed_total']:,.2f}")
        print(f"    {c['file'][:34]:<34}{str(c['sheet'])[:10]:<11}{c['entity'] or '?':<8}"
              f"{c['rows']:>6}{c['detail']:>14,.0f}   {mark}")

    print("\n  BY STATUS")
    st = by_status(rows)
    tot = sum(a for _, a in st.values())
    for s, (n, a) in sorted(st.items(), key=lambda kv: -kv[1][1]):
        print(f"    {s:<14}{n:>6}{a:>14,.0f}{100 * a / tot:>8.1f}%")
    risky = at_risk(rows)
    ra = sum(r["amount"] or 0 for r in risky)
    print(f"    {'AT RISK':<14}{len(risky):>6}{ra:>14,.0f}{100 * ra / tot:>8.1f}%")


if __name__ == "__main__":
    main()
