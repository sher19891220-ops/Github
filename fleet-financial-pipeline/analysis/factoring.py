"""The factor's invoice list against the P&L -- the only outside test of REVENUE.

The IFTA returns test the miles and Iron Lease's invoices test the rent. Revenue
had nothing: every gross figure in this pipeline came from the group's own
spreadsheets. Triumph buys the invoices, so its list is written by the
counterparty, and it answers two questions the sheets cannot.

DID THE FREIGHT GET BILLED? Comparing the sheet's weekly gross to what the
factor was actually given. Week by week the two will not line up -- the P&L books
a load in the week it RAN and the invoice carries the date it was SUBMITTED --
so only the period total is a verdict, and the weekly table is for shape.

DID THE MONEY COME BACK? This is the part no internal source has. Every invoice
carries a status, and the ones the factor would not or did not carry are
receivables the operating company has to collect itself -- while the weekly P&L
has already credited the truck with the gross and the driver has already been
paid on it.

WHAT THE LIST CANNOT DO: there is no amount-received column, so it cannot say
what was collected on any single invoice. A 'Short Paid' row still carries the
FULL invoice value. Read it for STATUS, never as a cash figure.

'FUNDED' IS NOT 'PAID'. Funded means Triumph advanced against the invoice; Paid
means the debtor settled it. On a recourse facility the difference is who is
carrying the risk today, so they are reported apart and never added together as
though the money were in.
"""
import argparse
import sys
import warnings
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import parse_factoring as F      # noqa: E402
import truck_breakeven as B      # noqa: E402
from xtrack_trend import load as load_weeks   # noqa: E402

# The invoice list only covers this span in full. Outside it the comparison
# measures the file's edges, not the sheet.
COVERED = ("2026-04-01", "2026-08-31")


def weekly(company, rows):
    """P&L gross against invoices submitted, by week."""
    wk = load_weeks(ROOT / B.WORKBOOK[company])
    inv = defaultdict(float)
    for r in rows:
        if r["entity"] != company:
            continue
        w = F.week_of(r.get("Invoice Date"))
        if w:
            inv[w] += r["amount"] or 0
    ks = [k for k in sorted(wk) if k in inv and COVERED[0] <= k <= COVERED[1]]
    return [(k, wk[k]["gross"], inv[k]) for k in ks]


def concentration(rows, status=("Denied",)):
    by = defaultdict(lambda: [0, 0.0])
    for r in rows:
        if str(r.get("Status") or "").strip() not in status:
            continue
        by[str(r.get("Customer") or "?").strip()[:34]][0] += 1
        by[str(r.get("Customer") or "?").strip()[:34]][1] += r["amount"] or 0
    return sorted(by.items(), key=lambda kv: -kv[1][1])


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--company", default="XTRACK",
                    help="only XTRACK has a full-period invoice list")
    a = ap.parse_args()
    rows, controls = F.load()

    bad = [c for c in controls if not c["ties"]]
    print(f"{len(rows)} invoices, {len(controls)} sheets, "
          f"{len(controls) - len(bad)} tie to their own printed total")
    for c in bad:
        d = c["detail"] - (c["printed_total"] or 0)
        print(f"  CONTROL FAILED  {c['file'][:32]}[{c['sheet']}]: detail "
              f"${c['detail']:,.0f} against a printed ${c['printed_total']:,.0f}"
              f" -- ${-d:,.0f} of rows are missing from the list, so every figure")
        print("  drawn from that sheet is a FLOOR.")

    print(f"\n== DID THE FREIGHT GET BILLED? {a.company} ==")
    w = weekly(a.company, rows)
    print(f"  {'week':<12}{'P&L gross':>13}{'given to the factor':>21}{'gap':>12}{'':>3}")
    for k, p, i in w:
        print(f"  {k:<12}{p:>13,.0f}{i:>21,.0f}{i - p:>12,.0f}"
              f"{100 * (i - p) / p:>8.1f}%")
    tp, ti = sum(x[1] for x in w), sum(x[2] for x in w)
    print(f"  {'TOTAL':<12}{tp:>13,.0f}{ti:>21,.0f}{ti - tp:>12,.0f}"
          f"{100 * (ti - tp) / tp:>8.1f}%")
    print(f"\n  The weekly swings are TIMING -- the P&L books a load in the week it")
    print("  ran, the invoice carries the date it was submitted -- so read the total.")
    print(f"  ${tp - ti:,.0f} of {a.company}'s booked gross over {len(w)} weeks never went")
    print("  through Triumph. That is not automatically an error: freight billed")
    print("  direct never enters this list. It is the size of the question.")

    print("\n== DID THE MONEY COME BACK? ==")
    st = F.by_status(rows)
    tot = sum(x[1] for x in st.values())
    for s, (n, amt) in sorted(st.items(), key=lambda kv: -kv[1][1]):
        note = ""
        if s == "Funded":
            note = "  advanced, NOT yet settled by the debtor"
        elif s in F.AT_RISK:
            note = "  the operating company collects this itself"
        print(f"  {s:<13}{n:>6}{amt:>14,.0f}{100 * amt / tot:>7.1f}%{note}")
    risky = F.at_risk(rows)
    ra = sum(r["amount"] or 0 for r in risky)
    print(f"  {'AT RISK':<13}{len(risky):>6}{ra:>14,.0f}{100 * ra / tot:>7.1f}%")
    print("\n  Every one of these was booked as gross in the week it ran and the")
    print("  driver was paid on it. The P&L has no line that ever takes it back.")

    print("\n== ONE CUSTOMER IS THE WHOLE CREDIT PROBLEM ==")
    for cust, (n, amt) in concentration(rows)[:8]:
        print(f"  {cust:<36}{n:>5}{amt:>13,.0f}")
    denied = sum(a for _, (_, a) in concentration(rows))
    stl = sum(a for c, (_, a) in concentration(rows) if c.upper().startswith("STL"))
    print(f"  {'STL as a share of all credit denials':<36}{'':>5}"
          f"{100 * stl / denied if denied else 0:>12.1f}%")
    print("\n  The factor has refused credit on this customer across ALL THREE")
    print("  operating companies and over more than a year. That is a standing")
    print("  credit decision, not a run of late invoices -- so every load hauled")
    print("  for them since is a receivable the group finances itself.")
    print("  The P&L ALSO carries 'STL charges' as an overhead COST, so money is")
    print("  moving in both directions with the same name on it. Which of the two")
    print("  is the real position cannot be read off either side alone.")


if __name__ == "__main__":
    main()
