"""
Cross-source control for the credit card.

The AmEx export has no beginning/ending balance, so the statement-total control
cannot run on it -- the card cannot verify itself. What it CAN be verified
against is the bank, which is verified: every payment to the card leaves a bank
account, so the same event is written down twice by two independent parties.

    AmEx side : a positive row, "MOBILE PAYMENT - THANK YOU" / "AUTOPAY PAYMENT"
    Bank side : a negative row, "AMERICAN EXPRESS DES:ACH PMT ..."

Matching those two populations answers three separate questions, and the value
is in keeping them separate:

  matched            both sides agree. The card's spend total is trustworthy
                     for the periods these payments cover.
  card_only          the card was paid from an account whose statements are not
                     in the corpus. Not an error -- a GAP, and it names exactly
                     which bank account is still missing.
  bank_only          the bank paid AmEx and the card export does not show it.
                     Means the card export does not cover that period, so any
                     spend total that spans it is understated.

Dates differ by a few days by design: a mobile payment posts to the card
immediately and clears the bank on the ACH cycle. Amount is the hard key;
date is a window, and a match outside the window is reported rather than
silently accepted.

Usage:
    python analysis/reconcile_card_payments.py --card amex_txns.csv --bank boa_txns.csv
"""
import argparse
import csv
from datetime import date, datetime
from pathlib import Path

AMOUNT_TOL = 0.01
DATE_WINDOW = 7          # ACH settlement lag, in days
CARD_PAYMENT = ("payment", "thank you")
BANK_CARD = ("american express", "amex")


def d(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def load_card(path):
    out = []
    for r in csv.DictReader(Path(path).open()):
        amt = float(r["amount"])
        desc = r["description"].lower()
        # a payment is a positive row that says so; a merchant refund is also
        # positive and is NOT a payment, so require the wording.
        if amt > 0 and any(k in desc for k in CARD_PAYMENT):
            out.append({"date": d(r["txn_date"]), "amount": amt,
                        "desc": r["description"], "acct": r["account_id"],
                        "src": r["source_file"]})
    return out


def load_bank(path):
    out = []
    for r in csv.DictReader(Path(path).open()):
        amt = float(r["amount"])
        desc = r["description"].lower()
        if amt < 0 and any(k in desc for k in BANK_CARD):
            out.append({"date": d(r["txn_date"]), "amount": -amt,
                        "desc": r["description"], "acct": r["account_last4"],
                        "src": r["source_file"]})
    return out


def match(card, bank):
    """One-to-one greedy on amount, then nearest date. Each bank row can absorb
    at most one card payment; without that a single $30,000 draft would satisfy
    three identical $30,000 payments and hide two of them."""
    used = set()
    pairs, card_only = [], []
    for c in sorted(card, key=lambda r: r["date"]):
        cands = [(abs((b["date"] - c["date"]).days), i)
                 for i, b in enumerate(bank)
                 if i not in used and abs(b["amount"] - c["amount"]) <= AMOUNT_TOL]
        cands.sort()
        if cands and cands[0][0] <= DATE_WINDOW:
            lag, i = cands[0]
            used.add(i)
            pairs.append((c, bank[i], lag))
        elif cands:
            # amount agrees but the date is far outside settlement -- report,
            # do not quietly pair.
            lag, i = cands[0]
            used.add(i)
            pairs.append((c, bank[i], lag))
        else:
            card_only.append(c)
    bank_only = [b for i, b in enumerate(bank) if i not in used]
    return pairs, card_only, bank_only


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--card", required=True)
    ap.add_argument("--bank", required=True)
    args = ap.parse_args()

    card, bank = load_card(args.card), load_bank(args.bank)
    pairs, card_only, bank_only = match(card, bank)

    tight = [p for p in pairs if p[2] <= DATE_WINDOW]
    loose = [p for p in pairs if p[2] > DATE_WINDOW]

    print(f"\nCard-payment cross-source control  (AmEx <-> verified bank statements)\n")
    print(f"  card payments in export       : {len(card):>5}   ${sum(c['amount'] for c in card):>14,.2f}")
    print(f"  AmEx drafts on bank statements: {len(bank):>5}   ${sum(b['amount'] for b in bank):>14,.2f}")
    print()
    print(f"  matched within {DATE_WINDOW} days        : {len(tight):>5}   "
          f"${sum(p[0]['amount'] for p in tight):>14,.2f}")
    if loose:
        print(f"  matched on amount, date outside : {len(loose):>5}   "
              f"${sum(p[0]['amount'] for p in loose):>14,.2f}   <- verify these by hand")
    print(f"  card only (paid from an account not in the corpus): {len(card_only):>4}   "
          f"${sum(c['amount'] for c in card_only):>14,.2f}")
    print(f"  bank only (card export does not cover the period) : {len(bank_only):>4}   "
          f"${sum(b['amount'] for b in bank_only):>14,.2f}")

    if card_only:
        print(f"\n  Card payments with no matching bank draft "
              f"-- the funding account is missing from the corpus:")
        print(f"  {'date':<12}{'amount':>14}  description")
        for c in sorted(card_only, key=lambda r: -r["amount"])[:15]:
            print(f"  {c['date'].isoformat():<12}{c['amount']:>14,.2f}  {c['desc'][:52]}")
        if len(card_only) > 15:
            print(f"  ... and {len(card_only) - 15} more")

    if bank_only:
        print(f"\n  AmEx drafts on verified statements with no matching card payment "
              f"-- card spend for these periods is NOT in the corpus:")
        print(f"  {'date':<12}{'acct':<7}{'amount':>14}  description")
        for b in sorted(bank_only, key=lambda r: r["date"])[:15]:
            print(f"  {b['date'].isoformat():<12}{b['acct']:<7}{b['amount']:>14,.2f}  {b['desc'][:46]}")
        if len(bank_only) > 15:
            print(f"  ... and {len(bank_only) - 15} more")

    if loose:
        print(f"\n  Amount matched but settlement lag > {DATE_WINDOW} days:")
        for c, b, lag in sorted(loose, key=lambda p: -p[2])[:10]:
            print(f"  {c['date'].isoformat()} card / {b['date'].isoformat()} bank "
                  f"({lag}d)  {c['amount']:,.2f}")


if __name__ == "__main__":
    main()
