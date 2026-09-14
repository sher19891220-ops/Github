"""Registration: IRP apportioned plates, HVUT, renewals and plate transfers.

The first registration document in the corpus (`data/raw/permits/`, uploaded
2026-09-05). It matters for two reasons.

FIRST, IT IS A COST LINE THAT APPEARS NOWHERE ELSE. The weekly P&L has no
registration column and `analysis/truck_breakeven.py` has no registration line,
so every per-truck cost figure in this pipeline has been missing it. It is not
large -- about $1,800 a truck a year -- but it is FIXED and annual, which is
exactly the shape that matters for an idle truck.

SECOND, IT IS BILLED IN GROUPS, AND A GROUP HIDES A DUPLICATE. Nearly every
payment here covers several trucks at once, so the unit of the document is the
payment and the unit of the analysis is the truck. Expanding the groups is what
makes two identical $2,493.34 payments for the same three trucks visible.

WHAT THE ARITHMETIC PROVES, AND WHAT IT ONLY SUGGESTS:

    HVUT is $550 a truck a year, flat -- every one of the six group payments is
    an exact multiple of it, so the groups are trustworthy and the unit lists
    can be checked against the money.
    HVUT prorates by month of first use. Unit 7584 paid $458.33, which is
    exactly 10/12 of $550, so it entered service in September.
    IRP does NOT prorate to anything flat. It is apportioned on miles per
    jurisdiction and on weight, so $437 to $1,430 a truck is a real spread and
    not an error -- do not "correct" it to an average.
"""
import re
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data/raw/permits/55e7b638-IRP_expenses_report__List_Exact.xlsx"

# The federal heavy vehicle use tax at 80,000 lb. Flat, annual, and the reason
# every HVUT group total divides exactly.
HVUT_ANNUAL = 550.0
HVUT_YEAR_STARTS = "July"  # so a proration of 10/12 means first use in September
MONTHS = ("January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December")

SECTIONS = {
    "1.": "hvut",
    "2.": "renewal",
    "3.": "irp",
    "4.": "individual",
}


def units(cell):
    """Truck numbers out of a comma-separated cell.

    Deliberately NOT a bare \\d+ over the whole string: the Note column carries
    counts ("10 trucks together") and dollar figures, and a digit grab there
    invents trucks that do not exist.
    """
    if cell is None:
        return []
    return [int(t) for t in re.findall(r"\b(\d{3,6})\b", str(cell))]


def money(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = re.sub(r"[$,\s]", "", str(v))
    try:
        return float(s)
    except ValueError:
        return None


def read(path=SOURCE):
    """Payments, each with its amount and the units it covers.

    Section-driven rather than row-indexed: the sheet is a hand-made list and a
    row number is the first thing that moves when someone adds a payment.
    """
    ws = openpyxl.load_workbook(path, data_only=True)["Easy Grouped List"]
    rows = [[c for c in r] for r in ws.iter_rows(values_only=True)]

    payments, reference, section, red = [], {}, None, None
    for r in rows:
        a = str(r[0]).strip() if r[0] is not None else ""
        if not a:
            continue
        head = a[:2]
        if head in SECTIONS:
            section = SECTIONS[head]
            continue
        if a.startswith("RED MARK"):
            section = "red"
            continue
        if a.startswith("REFERENCE TOTALS"):
            section = "reference"
            continue
        if a in ("Group", "Payment", "IRP Payment", "Type"):   # column headers
            continue
        amt = money(r[1])
        if amt is None:
            continue
        if section == "reference":
            reference[a] = amt
            continue
        # Section 4 is one unit per row and puts the unit in column C; the group
        # sections put a list there. units() handles both.
        u = units(r[2])
        rec = {"section": section, "label": a, "amount": amt, "units": u,
               "note": (str(r[3]) if r[3] is not None else "")}
        if section == "red":
            red = rec
        else:
            payments.append(rec)
    return payments, red, reference


def per_unit(payments):
    """Split each group payment evenly over the trucks it names.

    Even splitting is CORRECT for HVUT -- it is a flat $550 and the groups
    divide exactly -- and is an ASSUMPTION for IRP, which is apportioned per
    truck on miles and weight. The assumption is named here rather than buried:
    a group's per-truck IRP is its average, not its actual.
    """
    out = {}
    for p in payments:
        if not p["units"]:
            continue
        each = p["amount"] / len(p["units"])
        for u in p["units"]:
            out.setdefault(u, {"total": 0.0, "lines": []})
            out[u]["total"] += each
            out[u]["lines"].append((p["section"], p["label"], each))
    return out


def duplicates(payments):
    """Payments with the same amount covering the same set of trucks.

    Keyed on the SET of units, not the printed order: the two $2,493.34 entries
    list the same three trucks as `1596, 1365, 1564` and `1564, 1596, 1365`, and
    a string comparison of the cell would call them different payments.
    """
    seen, dups = {}, []
    for p in payments:
        if not p["units"]:
            continue
        k = (round(p["amount"], 2), frozenset(p["units"]))
        if k in seen:
            dups.append((seen[k], p))
        else:
            seen[k] = p
    return dups


def controls(payments, red, reference):
    fails, notes = [], []

    # HVUT is flat, so every group total must be a whole number of trucks at
    # $550 -- or a whole number of MONTHS of one, because HVUT prorates from the
    # month of first use. Testing only for whole trucks calls a correct
    # proration an error: unit 7584's $458.33 is exactly 10/12 of $550.
    for p in payments:
        if p["section"] != "hvut" or not p["units"]:
            continue
        implied = p["amount"] / HVUT_ANNUAL
        if abs(implied - len(p["units"])) <= 0.001:
            continue
        months = implied * 12 / len(p["units"])
        if abs(months - round(months)) < 0.01 and round(months) < 12:
            m = round(months)
            first = MONTHS[(MONTHS.index(HVUT_YEAR_STARTS) + (12 - m)) % 12]
            notes.append(f"{p['label']} unit {p['units'][0]}: ${p['amount']:,.2f} "
                         f"is {m}/12 of ${HVUT_ANNUAL:.0f} -- a PRORATION, not an "
                         f"error. HVUT runs from {HVUT_YEAR_STARTS} and is "
                         f"charged from the month of first use, so this truck "
                         f"went into service in {first}.")
        elif abs(implied - round(implied)) < 0.001:
            notes.append(f"{p['label']}: ${p['amount']:,.0f} is "
                         f"{round(implied)} trucks at ${HVUT_ANNUAL:.0f} but "
                         f"{len(p['units'])} are listed")
        else:
            fails.append(f"{p['label']}: ${p['amount']:,.2f} is neither a whole "
                         f"number of trucks nor a proration of ${HVUT_ANNUAL:.0f}")

    if red:
        implied = red["amount"] / HVUT_ANNUAL
        if abs(implied - len(red["units"])) > 0.001:
            notes.append(f"red-marked second year: ${red['amount']:,.0f} is "
                         f"{implied:.0f} trucks at ${HVUT_ANNUAL:.0f} but "
                         f"{len(red['units'])} are listed")

    # The stated HVUT total should be the six groups plus the second year.
    groups = sum(p["amount"] for p in payments
                 if p["section"] == "hvut" and len(p["units"]) > 1)
    stated_hvut = reference.get("HVUT TAX ALL 25/26")
    if stated_hvut is not None and red:
        if abs(groups + red["amount"] - stated_hvut) > 0.01:
            fails.append(f"HVUT groups + second year ${groups + red['amount']:,.2f} "
                         f"vs the stated ${stated_hvut:,.2f}")

    return fails, notes


def grand_total(payments, red):
    return sum(p["amount"] for p in payments) + (red["amount"] if red else 0.0)


def main():
    payments, red, reference = read()
    fails, notes = controls(payments, red, reference)

    print(f"{len(payments)} payments + the second-year HVUT block, "
          f"{len({u for p in payments for u in p['units']})} distinct trucks")
    print("controls: all pass" if not fails else "CONTROLS FAILED:")
    for f in fails:
        print(f"  {f}")
    if notes:
        print("\n== THE MONEY AND THE UNIT LIST DISAGREE ==")
        for n in notes:
            print(f"  {n}")

    print("\n== WHAT WAS PAID ==")
    for sec in ("hvut", "renewal", "irp", "individual"):
        rows = [p for p in payments if p["section"] == sec]
        if not rows:
            continue
        print(f"  {sec.upper()}")
        for p in rows:
            n = len(p["units"]) or 1
            print(f"    {p['label']:<22}{p['amount']:>11,.2f}  {n:>2} trucks"
                  f"{p['amount'] / n:>10,.2f}/truck  {','.join(str(u) for u in p['units'])[:44]}")
    if red:
        print(f"  SECOND YEAR\n    {red['label']:<22}{red['amount']:>11,.2f}"
              f"  {len(red['units']):>2} trucks")

    tot = grand_total(payments, red)
    print(f"\n  {'TOTAL':<22}{tot:>11,.2f}")
    stated = reference.get("Bottom grand total shown")
    if stated is not None and abs(tot - stated) > 0.01:
        d = stated - tot
        print(f"  {'stated in the file':<22}{stated:>11,.2f}")
        print(f"  {'difference':<22}{-d:>11,.2f}")
        # Not a rounding drift. $91.67 is 2/12 of $550 -- the stated total
        # carries 7584's HVUT at a full year while the itemization prorates it.
        m = d / HVUT_ANNUAL * 12
        if abs(m - round(m)) < 0.02:
            print(f"  ...which is exactly {round(m)}/12 of ${HVUT_ANNUAL:.0f}: the "
                  f"grand total charges a full year of HVUT on the one truck the")
            print("     itemization prorates. The itemized figure is the right one.")

    dups = duplicates(payments)
    if dups:
        print("\n== THE SAME MONEY, TWICE, FOR THE SAME TRUCKS ==")
        for a, b in dups:
            print(f"  {a['label']} and {b['label']}: ${a['amount']:,.2f} each, "
                  f"units {sorted(a['units'])}")
            print(f"    ${a['amount']:,.2f} is at risk. Test it against the bank "
                  f"before treating it as cost.")

    pu = per_unit(payments)
    print(f"\n== COST PER TRUCK ==  ({len(pu)} trucks)")
    ranked = sorted(pu.items(), key=lambda kv: -kv[1]["total"])
    for u, v in ranked[:6]:
        print(f"  {u:<8}{v['total']:>10,.2f}   "
              + ", ".join(f"{s}" for s, _, _ in v["lines"]))
    print("  ...")
    for u, v in ranked[-3:]:
        print(f"  {u:<8}{v['total']:>10,.2f}   "
              + ", ".join(f"{s}" for s, _, _ in v["lines"]))
    vals = [v["total"] for v in pu.values()]
    mean = sum(vals) / len(vals)
    print(f"\n  mean ${mean:,.2f} a truck a year = ${mean / 52:,.2f} a truck-week")
    print(f"  range ${min(vals):,.2f} to ${max(vals):,.2f}")

    irp = [p for p in payments if p["section"] == "irp" and p["units"]]
    rates = sorted(p["amount"] / len(p["units"]) for p in irp)
    print(f"\n  IRP alone runs ${rates[0]:,.2f} to ${rates[-1]:,.2f} a truck "
          f"({rates[-1] / rates[0]:.1f}x). IRP is apportioned on miles per")
    print("  jurisdiction and on weight, so that spread is real. An average "
          "rate per truck is wrong for every truck.")


if __name__ == "__main__":
    main()
