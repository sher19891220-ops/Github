"""
P&L driver pay against what actually left the bank.

The per-unit P&L records driver pay as the GROSS SETTLEMENT -- what the driver
earned on the loads. The bank shows the NET -- what was actually transmitted
after deductions. Those two numbers are supposed to differ, and the difference
is not slippage: it is the deduction pool, and it is the single place where the
Truck Max recovery chain becomes measurable.

    Truck Max repairs the truck  ->  bills ZONE / XTRACK / AFG
      ->  that company deducts the bill from the DRIVER'S SETTLEMENT

Every dollar of that recovery lives in this gap, alongside escrow withholding,
paycheck holds, advances, and insurance deductions. So:

    gross settlement (P&L)  -  net paid (bank)  =  deductions withheld

A gap of zero would mean nothing is being recovered from drivers at all. A gap
that is large and growing is either strong recovery or drivers being ground
down -- this measures it; it does not judge it.

Payroll does not all move through one rail. ADP is the payroll processor, but
1099 contractors also get paid by Zelle and by wire, and counting only ADP
understates net pay and inflates the apparent deduction. All three rails are
counted, and each is shown so a rail that is missing from a period is visible
rather than silently zero.

Usage:
    python analysis/reconcile_payroll.py --pnl pnl_unit_week_AFG.csv \
        --bank boa_txns.csv --account 4504 --entity AFG
"""
import argparse
import collections
import csv
import re
from pathlib import Path

RAILS = (("ADP", r"\bADP\b"),
         ("Zelle", r"\bZELLE\b"),
         ("wire", r"\bWIRE\b"),
         ("check", r"^Check\b"))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pnl", required=True)
    ap.add_argument("--bank", required=True)
    ap.add_argument("--account", required=True)
    ap.add_argument("--entity", required=True)
    ap.add_argument("--rails", default="ADP,Zelle",
                    help="comma-separated rails to count as driver pay "
                         "(default ADP,Zelle; wires are usually intercompany)")
    args = ap.parse_args()

    want = {r.strip().lower() for r in args.rails.split(",")}
    pnl = [r for r in csv.DictReader(Path(args.pnl).open()) if r.get("week_start")]
    bank = [r for r in csv.DictReader(Path(args.bank).open())
            if r["account_last4"] == args.account]
    b0, b1 = min(r["txn_date"] for r in bank), max(r["txn_date"] for r in bank)
    inwin = [r for r in pnl if r["week_start"] >= b0 and r["week_end"] <= b1]

    gross_settlement = sum(float(r["driver_salary"]) for r in inwin
                           if r.get("driver_salary"))

    by_rail, counted = {}, 0.0
    for name, pat in RAILS:
        m = [r for r in bank if float(r["amount"]) < 0
             and re.search(pat, r["description"], re.I)]
        by_rail[name] = (len(m), sum(float(r["amount"]) for r in m))
        if name.lower() in want:
            counted += -by_rail[name][1]

    print(f"\n{args.entity}  --  driver pay: P&L gross settlement vs bank net paid")
    print(f"  window {b0} .. {b1}   {len(inwin)} P&L weeks, "
          f"{len(bank):,} verified bank transactions\n")
    print(f"  {'gross settlement (P&L)':<34}{gross_settlement:>16,.2f}")
    for name, (n, v) in by_rail.items():
        mark = "counted" if name.lower() in want else "not counted as driver pay"
        print(f"  {'  paid via ' + name:<34}{-v:>16,.2f}   {n:>3} payments   {mark}")
    print(f"  {'net paid (counted rails)':<34}{counted:>16,.2f}")
    gap = gross_settlement - counted
    print(f"  {'deductions withheld':<34}{gap:>16,.2f}"
          + (f"   {gap / gross_settlement * 100:.1f}% of gross settlement"
             if gross_settlement else ""))

    pm = collections.defaultdict(float)
    for r in inwin:
        if r.get("driver_salary"):
            pm[r["week_start"][:7]] += float(r["driver_salary"])
    bmm = collections.defaultdict(float)
    for name, pat in RAILS:
        if name.lower() not in want:
            continue
        for r in bank:
            if float(r["amount"]) < 0 and re.search(pat, r["description"], re.I):
                bmm[r["txn_date"][:7]] += -float(r["amount"])
    print(f"\n  {'month':<10}{'gross settle':>15}{'net paid':>15}{'withheld':>15}{'%':>8}")
    for k in sorted(set(pm) | set(bmm)):
        g, n = pm[k], bmm[k]
        print(f"  {k:<10}{g:>15,.2f}{n:>15,.2f}{g - n:>15,.2f}"
              + (f"{(g - n) / g * 100:7.1f}%" if g else "       -"))

    print(f"\n  This gap is where Truck Max's repair billing is recovered. To split it "
          f"into\n  repair recovery vs escrow vs holds vs advances, the settlement "
          f"deduction lines\n  are needed -- the paylist gives rates, not the "
          f"per-week deduction detail.")


if __name__ == "__main__":
    main()
