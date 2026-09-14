"""
Apply the taxonomy to every verified cash transaction and report where the
money actually went, per entity, from cash alone.

This deliberately uses ONLY sources that passed a control:
  * the 147 BofA statements, which reconcile to their balance delta to the penny
  * the AmEx card, verified against those statements via its payments

No P&L, no bank-feed export, no assertion of any kind. If a number appears here
it is because money moved and a statement proves it.

Two rules that decide whether the output is meaningful:

1. THREE KINDS OF MOVEMENT ARE NOT SPEND, and all three are excluded from the
   ranking rather than merely noted:

     intercompany       between our own legal entities; nets to zero for the
                        group. A $400,000 transfer would otherwise outrank
                        every real leak by an order of magnitude.
     internal_transfer  between accounts we hold. Same logic, no counterparty
                        name at all, and the largest single pile in the corpus
                        before it had a rule.
     card_payment       paying AmEx is not spending. The CHARGES on that card
                        are the spend and are already ingested from the card
                        export. Counting both books every card dollar twice --
                        once where it was spent, once as a lump to AmEx -- and
                        both numbers are individually correct, which is what
                        makes it dangerous.

2. UNCATEGORIZED IS MEASURED IN ABSOLUTE DOLLARS, NOT NET. Summing signed
   amounts lets a -$9,500 and a +$9,500 report as $0.00 of unknown when the
   truth is $19,000 of unexamined movement in both directions. Netting is how
   an uncategorized pile hides.

Usage:
    python analysis/categorize_cash.py --bank boa_txns.csv --card amex_txns.csv
"""
import argparse
import collections
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from taxonomy.categorize import classify

# last-4 -> entity, from the statements themselves
ACCOUNTS = {
    "0271": "ZONE", "1558": "ZONE_OH", "5745": "XTRACK", "5525": "XTRACK",
    "5151": "IRON_LEASE", "8660": "TRUCKMAX", "4504": "AFG",
    "AMEX-2006": "CARD_2006",
}


def load(bank, card):
    rows = []
    for r in csv.DictReader(Path(bank).open()):
        rows.append({"src": "bank", "account": r["account_last4"],
                     "entity": ACCOUNTS.get(r["account_last4"], "UNKNOWN"),
                     "date": r["txn_date"], "amount": float(r["amount"]),
                     "memo": r["description"]})
    if card:
        for r in csv.DictReader(Path(card).open()):
            rows.append({"src": "card", "account": r["account_id"],
                         "entity": ACCOUNTS.get(r["account_id"], "CARD"),
                         "date": r["txn_date"], "amount": float(r["amount"]),
                         "memo": r["description"]})
    for r in rows:
        c = classify(r["memo"], r["amount"])
        r["category"], r["confidence"], r["rule"] = c.category, c.confidence, c.rule
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bank", required=True)
    ap.add_argument("--card")
    ap.add_argument("--out")
    args = ap.parse_args()

    rows = load(args.bank, args.card)
    if args.out:
        with Path(args.out).open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=["src", "account", "entity", "date",
                                               "amount", "category", "confidence",
                                               "rule", "memo"])
            w.writeheader()
            w.writerows(rows)

    print(f"\n{len(rows):,} verified transactions "
          f"({sum(1 for r in rows if r['src'] == 'bank'):,} bank, "
          f"{sum(1 for r in rows if r['src'] == 'card'):,} card)")
    print(f"period {min(r['date'] for r in rows)} .. {max(r['date'] for r in rows)}\n")

    # ---- outflow ranking, intercompany held out ---------------------------
    out = [r for r in rows if r["amount"] < 0]
    agg = collections.defaultdict(lambda: [0.0, 0])
    for r in out:
        a = agg[r["category"]]
        a[0] += r["amount"]
        a[1] += 1
    total_out = sum(r["amount"] for r in out)
    NOT_SPEND = ("intercompany", "internal_transfer", "card_payment")
    real = {k: v for k, v in agg.items() if k not in NOT_SPEND}
    real_total = sum(v[0] for v in real.values())

    print(f"CASH OUT  {total_out:,.2f} gross movement")
    for k in NOT_SPEND:
        v, n = agg.get(k, [0.0, 0])
        print(f"  less {k:<20}{v:>16,.2f}   {n:>6,} txns")
    print(f"  {'REAL OUTFLOW TO RANK':<25}{real_total:>16,.2f}\n")
    print(f"  {'category':<24}{'amount':>16}{'share':>9}{'txns':>8}")
    print("  " + "-" * 57)
    for k, (v, n) in sorted(real.items(), key=lambda kv: kv[1][0]):
        print(f"  {k:<24}{v:>16,.2f}{v / real_total * 100:>8.1f}%{n:>8,}")

    # ---- inflow ------------------------------------------------------------
    inn = [r for r in rows if r["amount"] > 0]
    iagg = collections.defaultdict(lambda: [0.0, 0])
    for r in inn:
        a = iagg[r["category"]]
        a[0] += r["amount"]
        a[1] += 1
    print(f"\nCASH IN  {sum(r['amount'] for r in inn):,.2f} total")
    print(f"  {'category':<24}{'amount':>16}{'txns':>8}")
    print("  " + "-" * 48)
    for k, (v, n) in sorted(iagg.items(), key=lambda kv: -kv[1][0])[:10]:
        print(f"  {k:<24}{v:>16,.2f}{n:>8,}")

    # ---- the honest uncategorized number -----------------------------------
    unc = [r for r in rows if r["category"] == "uncategorized"]
    gross = sum(abs(r["amount"]) for r in unc)
    net = sum(r["amount"] for r in unc)
    print(f"\nUNCATEGORIZED  {len(unc):,} transactions")
    print(f"  absolute movement : {gross:,.2f}   <- the real exposure")
    print(f"  net               : {net:,.2f}   <- what a signed sum would have said")
    print(f"  {gross / sum(abs(r['amount']) for r in rows) * 100:.1f}% of all "
          f"cash movement is unclassified")

    print(f"\n  largest uncategorized counterparties:")
    cp = collections.defaultdict(lambda: [0.0, 0])
    for r in unc:
        key = " ".join(r["memo"].split()[:4])[:44]
        cp[key][0] += abs(r["amount"])
        cp[key][1] += 1
    for k, (v, n) in sorted(cp.items(), key=lambda kv: -kv[1][0])[:15]:
        print(f"    {v:>14,.2f}  {n:>4}x  {k}")


if __name__ == "__main__":
    main()
