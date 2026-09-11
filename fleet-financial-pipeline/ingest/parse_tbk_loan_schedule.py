"""TBK Bank equipment-finance amortization schedules for Iron Lease LLC.

Two loans confirmed in the corpus so far, both against the same account-5151
`TBK BANK, SSB ... IRON LN PYMNT` ACH line `analysis/iron_lease.py` already
knew about only as a fleet-wide bank total ($332,431, CLAUDE.md) -- these
schedules are what actually produced that number, loan by loan, and let it
be checked rather than merely observed.

Read with pdfplumber: the header fields extract as fragmented, spaced-out
text on some renders (kerned "C o m p o u n d") but the CASH FLOW DATA and
AMORTIZATION SCHEDULE tables extract as clean fixed-format rows -- this
reader depends only on those two blocks, and skips the unreliable header
text entirely rather than fight it. The loan's own file number is not
printed in the body text at all; it is the number in TBK's own filename and
the bank memo's `ACH LN PYMNT/PMT` suffix, so it is passed in by the caller.
"""
import re
from pathlib import Path

import pdfplumber

LOAN_LINE = re.compile(
    r"^Loan\s+(\d{2}/\d{2}/\d{4})\s+([\d,]+\.\d{2})$")
PAYMENT_ROW = re.compile(
    r"^(\d+)\s+(\d{2}/\d{2}/\d{4})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+"
    r"([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$")
# The label ("Nominal Annual Rate") renders with a stray '.' kerned between
# every letter on some exports -- 'Nom..i.n..a..l. .A..n..n..u..a..l.' -- so
# this matches on the number-before-a-percent-sign shape alone, which the
# corruption never touches, rather than the label text.
RATE_LINE = re.compile(r"^\D*([\d]+\.[\d]+)\s*%\s*$")
FIRST_PAYMENT_LINE = re.compile(
    r"^\d+\s+Payment\s+(\d{2}/\d{2}/\d{4})\s+([\d,]+\.\d{2})\s+(\d+)\s+(\w+)")


def money(s):
    return float(s.replace(",", ""))


def read(path, loan_id):
    """One row per scheduled payment, plus the loan's own terms. `loan_id` is
    the lender's loan number (e.g. '400722502') -- supplied by the caller,
    since it is not printed anywhere in the document body."""
    text = "\n".join(p.extract_text() or "" for p in pdfplumber.open(path).pages)
    lines = text.splitlines()

    origination = None
    rate = None
    monthly_payment = None
    n_payments = None
    rows = []
    for line in lines:
        m = LOAN_LINE.match(line.strip())
        if m:
            origination = {"date": m.group(1), "amount": money(m.group(2))}
            continue
        m = RATE_LINE.search(line)
        if m:
            rate = float(m.group(1))
            continue
        m = FIRST_PAYMENT_LINE.match(line.strip())
        if m:
            monthly_payment = money(m.group(2))
            n_payments = int(m.group(3))
            continue
        m = PAYMENT_ROW.match(line.strip())
        if m:
            rows.append({"payment_no": int(m.group(1)), "date": m.group(2),
                        "payment": money(m.group(3)), "interest": money(m.group(4)),
                        "principal": money(m.group(5)), "balance": money(m.group(6))})

    return {"loan_id": loan_id, "borrower": "IRON LEASE LLC",
            "origination_date": origination["date"] if origination else None,
            "principal": origination["amount"] if origination else None,
            "annual_rate_pct": rate, "monthly_payment": monthly_payment,
            "n_payments": n_payments, "rows": rows}


def controls(loan):
    """The one internal check a schedule can be held to: its own rows must
    sum to its own stated principal and, payment-for-payment, its own
    monthly payment amount."""
    fails = []
    if len(loan["rows"]) != loan["n_payments"]:
        fails.append(f"{loan['loan_id']}: {len(loan['rows'])} rows parsed, "
                     f"schedule states {loan['n_payments']} payments")
    principal_sum = sum(r["principal"] for r in loan["rows"])
    if loan["principal"] is not None and abs(principal_sum - loan["principal"]) > 0.02:
        fails.append(f"{loan['loan_id']}: rows' principal sums to "
                     f"{principal_sum:,.2f}, loan was {loan['principal']:,.2f}")
    for r in loan["rows"][:-1]:                 # the final row may true up
        if abs(r["payment"] - loan["monthly_payment"]) > 0.01:
            fails.append(f"{loan['loan_id']} payment {r['payment_no']}: "
                         f"{r['payment']:,.2f} vs stated {loan['monthly_payment']:,.2f}")
    if loan["rows"] and abs(loan["rows"][-1]["balance"]) > 0.01:
        fails.append(f"{loan['loan_id']}: final balance is "
                     f"{loan['rows'][-1]['balance']:,.2f}, not zero")
    return fails


def paid_through(loan, as_of):
    """Rows with a payment date on or before `as_of` (YYYY-MM-DD str) -- the
    contractual schedule, not a claim about which ones actually cleared the
    bank. Cross against the bank feed for that."""
    from datetime import date
    cutoff = date.fromisoformat(as_of)
    out = []
    for r in loan["rows"]:
        m, d, y = r["date"].split("/")
        if date(int(y), int(m), int(d)) <= cutoff:
            out.append(r)
    return out


LOANS = [
    (Path(__file__).resolve().parent.parent /
     "data/raw/iron_lease/financing/amort_400722502_2025-04-07.pdf", "400722502"),
    (Path(__file__).resolve().parent.parent /
     "data/raw/iron_lease/financing/amort_400725362_2026-04-16.pdf", "400725362"),
]


def load_all():
    return [read(p, loan_id) for p, loan_id in LOANS if p.exists()]


if __name__ == "__main__":
    for loan in load_all():
        fails = controls(loan)
        print(f"Loan {loan['loan_id']}: ${loan['principal']:,.2f} at "
              f"{loan['annual_rate_pct']}%, {loan['n_payments']} x "
              f"${loan['monthly_payment']:,.2f}/mo from {loan['origination_date']}")
        print("  controls: all pass" if not fails else "  CONTROLS FAILED:")
        for f in fails:
            print(f"    {f}")
