"""
Google-Sheets P&L against the verified bank statements.

This is the comparison the whole pipeline exists to make: the P&L is what the
business has been deciding on, the bank is what actually happened, and the gap
between them is the finding.

THE FACTORING TRAP. Revenue does not arrive as customers paying invoices. It
arrives as a factor (Triumph Finance) advancing against those invoices and
keeping a fee. So bank deposits are STRUCTURALLY smaller than P&L gross, always,
and the difference is not an error -- it is the cost of factoring plus timing.
Comparing the two raw numbers and calling the gap a discrepancy would be wrong;
comparing them and NOT quantifying the gap would miss a real cost line. This
reports the gap as a rate so it can be judged.

Timing is the second structural difference. A load invoiced in the last week of
a month is advanced in the first week of the next, so a strict monthly cut
always shows the P&L ahead. The whole-period comparison is the sound one; the
monthly table is for shape, not for verdicts.

What each side is:
  P&L gross       what was invoiced, per the weekly per-unit sheets
  factor advances deposits from the factor, on verified statements
  other deposits  everything else landing in the account -- intercompany
                  transfers, owner injections. NOT revenue, and kept separate,
                  because folding it in makes revenue look healthier than it is.

Usage:
    python analysis/reconcile_pnl_vs_bank.py --pnl pnl_unit_week_AFG.csv \
        --bank boa_txns.csv --account 4504 --entity AFG
"""
import argparse
import collections
import csv
from pathlib import Path

FACTORS = ("TRIUMPH", "RTS FINANCIAL", "APEX CAPITAL", "OTR CAPITAL",
           "COMPASS FUNDING", "TAFS", "PORTER FREIGHT", "ENGLAND CARRIER")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pnl", required=True)
    ap.add_argument("--bank", required=True)
    ap.add_argument("--account", required=True)
    ap.add_argument("--entity", required=True)
    args = ap.parse_args()

    pnl = [r for r in csv.DictReader(Path(args.pnl).open()) if r.get("week_start")]
    bank = [r for r in csv.DictReader(Path(args.bank).open())
            if r["account_last4"] == args.account]
    if not pnl or not bank:
        raise SystemExit("no rows on one side -- nothing to compare")

    b0, b1 = min(r["txn_date"] for r in bank), max(r["txn_date"] for r in bank)
    # Only weeks fully inside the bank window can be compared: a week running
    # past the last statement has revenue with nowhere to land yet.
    inwin = [r for r in pnl if r["week_start"] >= b0 and r["week_end"] <= b1]
    dropped = len(pnl) - len(inwin)

    def f(r, k):
        return float(r[k]) if r.get(k) else 0.0

    gross = sum(f(r, "gross") for r in inwin)
    lines = (("driver pay", sum(f(r, "driver_salary") for r in inwin)),
             ("fuel / DEF / fees", sum(f(r, "def_fuel_fee") for r in inwin)),
             ("truck rental", sum(f(r, "truck_rental") for r in inwin)),
             ("toll & scale", sum(f(r, "toll_scale") for r in inwin)))

    adv_idx = {id(r) for r in bank
               if float(r["amount"]) > 0
               and any(k in r["description"].upper() for k in FACTORS)}
    adv = [r for r in bank if id(r) in adv_idx]
    other_in = [r for r in bank if float(r["amount"]) > 0 and id(r) not in adv_idx]
    advances = sum(float(r["amount"]) for r in adv)
    other = sum(float(r["amount"]) for r in other_in)
    outflow = sum(float(r["amount"]) for r in bank if float(r["amount"]) < 0)

    print(f"\n{args.entity}  --  P&L vs verified bank account {args.account}")
    print(f"  bank window : {b0} .. {b1}   ({len(bank):,} verified transactions)")
    print(f"  P&L weeks   : {len(inwin)} fully inside that window"
          f"{f', {dropped} outside and excluded' if dropped else ''}\n")

    gap = gross - advances
    print(f"  {'P&L gross (invoiced)':<32}{gross:>16,.2f}")
    print(f"  {'factor advances (banked)':<32}{advances:>16,.2f}   {len(adv)} deposits")
    print(f"  {'gap':<32}{gap:>16,.2f}"
          + (f"   {gap / gross * 100:.1f}% of invoiced" if gross else ""))
    print(f"\n  {'other deposits (NOT revenue)':<32}{other:>16,.2f}   "
          f"{len(other_in)} deposits")
    print(f"  {'total withdrawals':<32}{outflow:>16,.2f}")

    print(f"\n  P&L cost lines over the same weeks:")
    for name, v in lines:
        pct = f"   {v / gross * 100:5.1f}% of gross" if gross else ""
        print(f"    {name:<28}{v:>16,.2f}{pct}")

    pm, bm = collections.defaultdict(float), collections.defaultdict(float)
    for r in inwin:
        pm[r["week_start"][:7]] += f(r, "gross")
    for r in adv:
        bm[r["txn_date"][:7]] += float(r["amount"])
    print(f"\n  {'month':<10}{'P&L gross':>15}{'advanced':>15}{'gap':>15}{'gap %':>9}"
          f"   (timing, not a verdict)")
    for k in sorted(set(pm) | set(bm)):
        g, a = pm[k], bm[k]
        print(f"  {k:<10}{g:>15,.2f}{a:>15,.2f}{g - a:>15,.2f}"
              + (f"{(g - a) / g * 100:8.1f}%" if g else "        -"))

    print(f"\n  The gap is the factor's fee plus timing. It is a real cost line and "
          f"appears\n  nowhere in the per-unit P&L -- every unit is credited with "
          f"gross it never fully received.")


if __name__ == "__main__":
    main()
