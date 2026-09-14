"""Iron Lease's weekly invoices to Zone, Xtrack and AFG.

WHY THIS SOURCE SETTLES SOMETHING NOTHING ELSE CAN. The bank shows money moving
between Iron Lease and the operating companies and cannot say what it was for --
CLAUDE.md records a finding that had to be withdrawn for exactly that reason.
These 82 invoices are the billing side, and they are itemised:

    Truck rental      one weekly lump for the whole leased fleet
    Truck Mileage     miles x a per-mile rate ($0.10 and $0.12 both appear,
                      sometimes as two lines on ONE invoice)
    EFS money code #  a CREDIT -- roadside/repair spend the operating company
    Repair #          already paid, netted off what it owes
    Truck repair #

So an invoice's face value is not what Iron Lease charged. Rent plus mileage is
the charge; the EFS and repair lines are deductions from it, and the Total is
what actually got paid. Reading only the Total understates both the lease charge
and the maintenance flowing back the other way.

TRAPS

1. THE MINUS SIGN IS U+2212, NOT A HYPHEN. `−$407.15` does not match a regex
   written with `-`, and the credit reads as a positive charge -- which flips a
   deduction into a bill and breaks the invoice total by twice its value.

2. DESCRIPTIONS WRAP. A repair line runs onto two or three lines with no
   number, so the parser has to fold continuations into the item above rather
   than treat each printed line as an item.

3. THE SERVICE PERIOD IS NOT THE INVOICE DATE. Every rental and mileage line
   carries its own `MM.DD.YY-MM.DD.YY` week, typically ending 5-19 days before
   the invoice is issued. Bucketing these by invoice date misdates the charge.

4. ONE INVOICE HAS QTY AND RATE SWAPPED AT SOURCE. AFG 07.31.26 prints
   `Truck Mileage 07.20.26-07.26.26 0.12 $1,151.00 $138.12` -- the per-mile rate
   in the Qty column and the miles in the Rate column. The Amount is right, so
   the invoice total still ties; only a per-mile figure built from qty and rate
   goes wrong, and it goes wrong by four orders of magnitude. normalise_swapped()
   puts them back and records that it did.

CONTROL: the line amounts must sum to the printed Total, and Total + Payment
must equal Balance due. Both hold on all 82 invoices or the parse is wrong.
"""
import argparse
import glob
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INVOICE_DIR = ROOT / "data/raw/iron/invoices"

MINUS = "−"          # trap 1
NUM = r"[-−]?\$?[\d,]+\.?\d*"
# The sign of a credit sits on the RATE on some invoices ('1 −$77.73 −$77.73')
# and on the QTY on others ('-1 $407.15 −$407.15'). A rate pattern that allows
# no sign silently DROPS the whole line -- it does not mis-add it -- so the
# invoice total comes out high by exactly the credit and the credit vanishes
# from the maintenance flowing back. Ten of the 82 failed this way.
ITEM = re.compile(r"^\s*(\d+)\.\s+(.*?)\s+([-−]?[\d,]+(?:\.\d+)?)\s+"
                  r"([-−]?)\$([\d,]+\.\d{2})\s+([-−]?)\$([\d,]+\.\d{2})\s*$")
PERIOD = re.compile(r"(\d{2}\.\d{2}\.\d{2})\s*-\s*(\d{2}\.\d{2}\.\d{2})")
FIELD = {
    "invoice_no": re.compile(r"Invoice no\.:\s*(\S+)"),
    "invoice_date": re.compile(r"Invoice date:\s*(\S+)"),
    "due_date": re.compile(r"Due date:\s*(\S+)"),
    "terms": re.compile(r"Terms:\s*(.+)"),
}
FOOT = {"total": re.compile(r"^Total\s+([-−]?\$[\d,]+\.\d{2})"),
        "payment": re.compile(r"^Payment\s+([-−]?\$[\d,]+\.\d{2})"),
        "balance_due": re.compile(r"^Balance due\s+([-−]?\$[\d,]+\.\d{2})")}
# Order matters: 'Truck repair' must be tested before 'Truck rental'/'Truck Mileage'
# would ever be, and before the bare 'Repair' fallback.
CATEGORY = [(re.compile(r"^Truck rental", re.I), "rent"),
            (re.compile(r"^Truck Mileage", re.I), "mileage"),
            (re.compile(r"^EFS money code", re.I), "efs_credit"),
            (re.compile(r"^(Truck repair|Repair)\b", re.I), "repair_credit")]


def money(s):
    if s is None:
        return None
    neg = s.startswith("-") or s.startswith(MINUS)
    v = float(s.lstrip("-" + MINUS).lstrip("$").replace(",", ""))
    return -v if neg else v


def iso(d):
    """MM/DD/YYYY or MM.DD.YY -> YYYY-MM-DD."""
    p = re.split(r"[./]", d)
    if len(p) != 3:
        return None
    m, day, y = p
    y = y if len(y) == 4 else "20" + y
    return f"{y}-{int(m):02d}-{int(day):02d}"


def categorise(desc):
    for pat, cat in CATEGORY:
        if pat.match(desc):
            return cat
    return "other"


BARE_NUMBER = re.compile(r"^\s*(\d+)\.\s*$")


def join_orphan_numbers(text):
    """Some items print their number on a line of its own.

    On one invoice item 13 renders as '13.' followed by the body on the next
    line. The item regex then misses it and the continuation rule folds the body
    into item 12's description, so a $1,016.25 credit disappears and the invoice
    total comes out high by exactly that.
    """
    out, lines = [], text.split("\n")
    i = 0
    while i < len(lines):
        m = BARE_NUMBER.match(lines[i])
        if m and i + 1 < len(lines) and lines[i + 1].strip():
            out.append(f"{m.group(1)}. {lines[i + 1].strip()}")
            i += 2
        else:
            out.append(lines[i])
            i += 1
    return "\n".join(out)


def parse_text(text, source):
    text = join_orphan_numbers(text)
    inv = {"source": source, "lines": []}
    for k, pat in FIELD.items():
        m = pat.search(text)
        if m:
            inv[k] = m.group(1).strip()
    for k, pat in FOOT.items():
        for ln in text.split("\n"):
            m = pat.match(ln.strip())
            if m:
                inv[k] = money(m.group(1))
                break
    inv["paid_in_full"] = "Paid in Full" in text
    for ln in text.split("\n"):
        m = ITEM.match(ln)
        if m:
            n, desc, qty, rsign, rate, sign, amt = m.groups()
            a = money(sign + "$" + amt)
            inv["lines"].append({"n": int(n), "desc": desc.strip(),
                                 "category": categorise(desc),
                                 "qty": money(qty), "rate": money(rsign + "$" + rate),
                                 "amount": a})
        elif inv["lines"] and ln.strip() and not re.match(
                r"^(Total|Payment|Balance|Paid|token|#\s)", ln.strip()):
            inv["lines"][-1]["desc"] += " " + ln.strip()      # trap 2
    for L in inv["lines"]:                                     # trap 4
        if (L["category"] == "mileage" and L["rate"] and L["qty"]
                and abs(L["rate"]) > 1 and 0 < abs(L["qty"]) < 1):
            L["qty"], L["rate"] = L["rate"], L["qty"]
            L["qty_rate_swapped_at_source"] = True
    for L in inv["lines"]:                                     # trap 3
        p = PERIOD.search(L["desc"])
        if p:
            L["period_start"], L["period_end"] = iso(p.group(1)), iso(p.group(2))
    if inv.get("invoice_date"):
        inv["invoice_date"] = iso(inv["invoice_date"])
    if inv.get("due_date"):
        inv["due_date"] = iso(inv["due_date"])
    return inv


def entity(text, path):
    m = re.search(r"Bill to\s*\n\s*(.+)", text)
    name = (m.group(1) if m else Path(path).parent.name).strip().lower()
    if "xtrack" in name:
        return "XTRACK"
    if "zone" in name:
        return "ZONE"
    if "afg" in name:
        return "AFG"
    return None


def load(pattern=None):
    import pdfplumber
    files = sorted(glob.glob(pattern or str(INVOICE_DIR / "*/*.pdf")))
    out = []
    for f in files:
        with pdfplumber.open(f) as pdf:
            text = "\n".join((p.extract_text() or "") for p in pdf.pages)
        inv = parse_text(text, str(Path(f).relative_to(ROOT)))
        inv["entity"] = entity(text, f)
        out.append(inv)
    return out


def controls(invoices, tol=0.01):
    fails = []
    for inv in invoices:
        name = Path(inv["source"]).name
        s = sum(L["amount"] for L in inv["lines"])
        if inv.get("total") is None:
            fails.append((name, "no printed Total", None))
        elif abs(s - inv["total"]) > tol:
            fails.append((name, "line amounts vs printed Total", round(s - inv["total"], 2)))
        if inv.get("payment") is not None and inv.get("balance_due") is not None:
            gap = inv["total"] + inv["payment"] - inv["balance_due"]
            if abs(gap) > tol:
                fails.append((name, "Total + Payment vs Balance due", round(gap, 2)))
        if not inv["entity"]:
            fails.append((name, "no billed entity", None))
        if not any(L["category"] == "rent" for L in inv["lines"]):
            fails.append((name, "no Truck rental line", None))
        for L in inv["lines"]:
            if L["category"] == "mileage" and L.get("rate") and abs(L["rate"]) > 1 \
                    and not L.get("qty_rate_swapped_at_source") and L.get("period_start"):
                fails.append((name, "mileage line with an implausible per-mile rate",
                              f"{L['rate']} on {L['desc'][:40]}"))
        for L in inv["lines"]:
            if L["category"] == "other":
                fails.append((name, "uncategorised line", L["desc"][:60]))
    return fails


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", help="write the parsed invoices here")
    a = ap.parse_args()
    inv = load()
    print(f"{len(inv)} invoices")
    fails = controls(inv)
    if fails:
        print(f"CONTROLS FAILED ({len(fails)}):")
        for n, what, detail in fails[:30]:
            print(f"  {n:<28}{what}{'' if detail is None else f': {detail}'}")
    else:
        print("controls: all pass")
    if a.json:
        json.dump(inv, open(a.json, "w"), indent=1)
        print(f"-> {a.json}")


if __name__ == "__main__":
    sys.exit(main())
