"""
American Express activity exports (the "activity*.xlsx" files).

Three things about this source that will corrupt the books if taken at face
value:

1. SIGN IS INVERTED RELATIVE TO EVERY OTHER SOURCE. AmEx prints a charge as a
   POSITIVE number, because the export is written from the card's point of
   view -- what you owe went up. Under this project's convention (negative =
   money out) every charge must be negated. Card payments and merchant refunds
   print negative and become positive: cash leaving the bank to pay the card is
   recorded on the BANK side, and on the card side it is a reduction of debt,
   not income. Load this file unflipped and a year of fuel and repairs lands in
   revenue.

2. THE FILES OVERLAP. The corpus holds one full-history export and nineteen
   per-statement-period extracts of the SAME card. Concatenating them
   multiplies the card several times over. AmEx's Reference number is a stable
   per-transaction id, so dedup is exact rather than fuzzy -- no date/amount
   tolerance needed, and no risk of collapsing two genuinely identical
   same-day charges (the six identical CAT Scale charges on 11/26/2025 have six
   distinct references, and all six are real).

3. THERE IS NO BALANCE PAIR IN THE EXPORT, so the statement-total control
   cannot run. The card is not self-verifying. What IS available is a
   cross-source control: every payment to the card appears here as a large
   negative AND appears on the bank statements, which are verified. Matching
   those two populations is what makes the card trustworthy; see
   analysis/reconcile_card_payments.py.

Header block carries the masked account number and the closing date:

    Transaction Details | Business Platinum Card(R) / Closing Date : Feb 24, 2025
    Account Number
    XXXX-XXXXXX-52006
    Date | Receipt | Description | Amount | Extended Details | ... | Reference | Category

Note: 1008 and 2006 are the same physical card (AmEx Platinum); the operator
confirmed this. Statements print different masks for the basic and supplemental
card on one account, so both map to account_id AMEX-2006.

Usage:
    python ingest/ingest_amex.py <folder> --out amex_txns.csv
"""
import argparse
import csv
import re
import warnings
from datetime import datetime
from pathlib import Path

warnings.filterwarnings("ignore")

ACCT_MASK = re.compile(r"^X{4}-X{6}-(\d{4,6})$")
# Two header dialects for the same product line: a single closing date, or the
# period the export covers. Both appear in this corpus.
CLOSING = re.compile(r"Closing Date\s*:\s*([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})", re.I)
PERIOD = re.compile(r"/\s*([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})\s+to\s+([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})", re.I)
PRODUCT = re.compile(r"^(.*?Card)\b")

# Both masks are the same physical account.
ACCOUNT_ALIASES = {"52006": "AMEX-2006", "2006": "AMEX-2006",
                   "51008": "AMEX-2006", "1008": "AMEX-2006"}


def _date(s):
    return datetime.strptime(" ".join(s.split()), "%b %d, %Y").date().isoformat()


def account_id(mask_digits):
    return ACCOUNT_ALIASES.get(mask_digits,
                               f"AMEX-{mask_digits[-4:]}" if mask_digits else "AMEX-UNKNOWN")


def load(path: Path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active

    acct, closing, period_start, product, hdr = "", "", "", "", None
    rows = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if hdr is None:
            a = str(row[0] or "").strip()
            b = str(row[1] or "").strip()
            m = ACCT_MASK.match(a)
            if m:
                acct = m.group(1)
            if b:
                c = CLOSING.search(b)
                pr = PERIOD.search(b)
                if c:
                    closing = _date(c.group(1))
                elif pr:
                    period_start, closing = _date(pr.group(1)), _date(pr.group(2))
                p = PRODUCT.match(b)
                if p:
                    product = p.group(1)
            if a == "Date" and str(row[2] or "") == "Description":
                hdr = {str(v).strip(): j for j, v in enumerate(row) if v}
            continue

        d_raw = row[0]
        amt = row[hdr.get("Amount", 3)]
        if d_raw is None or not isinstance(amt, (int, float)):
            continue
        d = d_raw.date() if hasattr(d_raw, "date") else None
        if d is None:
            try:
                d = datetime.strptime(str(d_raw).strip(), "%m/%d/%Y").date()
            except ValueError:
                continue

        def cell(name):
            j = hdr.get(name)
            return str(row[j]).strip() if j is not None and row[j] is not None else ""

        rows.append({
            "source_file": path.name,
            "source_path": str(path),
            "account_id": account_id(acct),
            "period_start": period_start,
            "closing_date": closing,
            "txn_date": d.isoformat(),
            # the one line that matters: AmEx's sign is the opposite of ours
            "amount": round(-float(amt), 2),
            "description": cell("Description")[:300],
            "merchant_category": cell("Category"),
            "reference": cell("Reference"),
            "city_state": cell("City/State").replace("\n", " "),
            "control": "none",
        })
    wb.close()
    return rows, {"account": acct, "closing": closing,
                  "period_start": period_start, "product": product}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("--glob", default="activity*.xlsx")
    ap.add_argument("--out", default="data/processed/amex_txns.csv")
    args = ap.parse_args()

    files = sorted(Path(args.folder).rglob(args.glob))
    seen, kept, dup_rows, no_ref = {}, [], 0, 0
    print(f"{'file':<22}{'acct':<8}{'closing':<12}{'rows':>7}{'new':>7}{'dup':>7}")
    print("-" * 63)
    for f in files:
        rows, meta = load(f)
        new = 0
        for r in rows:
            key = r["reference"]
            if not key:
                # no stable id: fall back to the natural key, and say so
                no_ref += 1
                key = f"{r['account_id']}|{r['txn_date']}|{r['amount']}|{r['description'][:40]}"
            if key in seen:
                dup_rows += 1
                continue
            seen[key] = r["source_file"]
            kept.append(r)
            new += 1
        print(f"{f.name:<22}{meta['account']:<8}{(meta['closing'] or '-'):<12}"
              f"{len(rows):>7}{new:>7}{len(rows) - new:>7}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cols = ["source_file", "source_path", "account_id", "period_start", "closing_date", "txn_date",
            "amount", "description", "merchant_category", "reference",
            "city_state", "control"]
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(kept)

    charges = [r for r in kept if r["amount"] < 0]
    credits_ = [r for r in kept if r["amount"] > 0]
    print(f"\n{len(kept):,} unique transactions -> {out}")
    print(f"  {dup_rows:,} duplicate rows dropped (same Reference in more than one export)")
    if no_ref:
        print(f"  {no_ref:,} rows had no Reference; deduped on date+amount+description instead")
    print(f"  charges  : {len(charges):,}   ${sum(r['amount'] for r in charges):,.2f}")
    print(f"  credits/payments: {len(credits_):,}   ${sum(r['amount'] for r in credits_):,.2f}")
    if kept:
        print(f"  period   : {min(r['txn_date'] for r in kept)} .. {max(r['txn_date'] for r in kept)}")
    print("\n  Sign has been flipped to this project's convention: negative = money out.")
    print("  control: none in-file. Verify via card payments against the bank statements.")


if __name__ == "__main__":
    main()
