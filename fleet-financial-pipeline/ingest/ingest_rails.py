"""
Payment-rail transaction reports: Relay Payments and Bestpass tolls.

A rail is not a category. Both of these settle to the bank as consolidated
drafts -- Relay as $40-60k lumps, Bestpass as a monthly ACH -- so the bank
shows only the total. These files are the itemization underneath, and they
carry two things the bank never will: the UNIT the charge belongs to, and, for
Relay, the discount actually received per gallon.

TOTAL ROWS ARE IN THE DATA. Each Relay export ends with a grand-total row.
Summed with the detail they double the file exactly: the three exports first
read as $7,057,340 when the real figure is $3,528,670. Rows are kept only when
they carry a transaction id, which the totals do not.

Bestpass prints three money columns and they are NOT alternatives:
    Amount            the toll as posted by the agency
    Discounted Amount what was actually charged after any agency discount
    Fee Amount        Bestpass's own fee on top
Cost is the discounted amount plus the fee. Taking "Amount" alone understates
the fee; taking both Amount and Discounted Amount double-counts the toll.

Usage:
    python ingest/ingest_rails.py --relay f1.xlsx f2.xlsx --bestpass b1.xlsx --outdir out/
"""
import argparse
import csv
import sys
import warnings
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_intake import repair_xlsx

warnings.filterwarnings("ignore")


def num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace("$", "").replace(",", "").strip()
    if not s or s.lower() in ("none", "n/a", "-", "null"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def txt(v):
    s = str(v).strip() if v is not None else ""
    return "" if s.lower() in ("none", "null") else s


def isodate(v):
    if hasattr(v, "date"):
        return v.date().isoformat()
    s = txt(v)[:10]
    for f in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(s, f).date().isoformat()
        except ValueError:
            pass
    return s


def rows_of(path, workdir):
    import openpyxl
    wb = openpyxl.load_workbook(repair_xlsx(Path(path), Path(workdir)),
                                read_only=True, data_only=True)
    ws = wb.active
    it = ws.iter_rows(values_only=True)
    hdr = [txt(h).lower() for h in next(it)]
    idx = {h: j for j, h in enumerate(hdr) if h}
    for r in it:
        yield idx, r
    wb.close()


def load_relay(path, workdir):
    out = []
    for idx, r in rows_of(path, workdir):
        g = lambda k: (r[idx[k]] if k in idx and idx[k] < len(r) else None)
        # a grand-total row has no transaction id; keeping it doubles the file
        if not txt(g("id")):
            continue
        amt = num(g("amount"))
        if amt is None:
            continue
        out.append({"source_file": Path(path).name, "txn_id": txt(g("id")),
                    "txn_date": isodate(g("date")), "merchant": txt(g("merchant")),
                    "state": txt(g("state")), "city": txt(g("city")),
                    "driver": txt(g("driver")), "truck": txt(g("truck #")),
                    "odometer": num(g("odometer")), "type": txt(g("type")),
                    "sub_type": txt(g("sub type")), "product": txt(g("product")),
                    "fuel_item": txt(g("fuel item")),
                    "amount": -abs(amt), "fee": num(g("fee")),
                    "gallons": num(g("gals")), "retail_price": num(g("retail price")),
                    "discounted_price": num(g("discounted price")),
                    "discount_per_gal": num(g("discount per gallon")),
                    "discount": num(g("discount"))})
    return out


def load_bestpass(path, workdir):
    out = []
    for idx, r in rows_of(path, workdir):
        g = lambda k: (r[idx[k]] if k in idx and idx[k] < len(r) else None)
        tid = txt(g("transaction id"))
        posted = num(g("amount"))
        if posted is None and not tid:
            continue
        disc = num(g("discounted amount"))
        fee = num(g("fee amount")) or 0.0
        # what actually got charged: discounted toll plus Bestpass's fee
        charged = (disc if disc is not None else posted or 0.0) + fee
        out.append({"source_file": Path(path).name, "txn_id": tid,
                    "post_date": isodate(g("post date")),
                    "desc": txt(g("transaction desc")), "unit": txt(g("unit")),
                    "plate": txt(g("license plate")), "state": txt(g("license state")),
                    "agency": txt(g("agency")), "service": txt(g("service")),
                    "toll_class": txt(g("toll class")), "miles": num(g("miles")),
                    "posted_amount": posted, "discounted_amount": disc,
                    "fee_amount": fee, "amount": -abs(charged)})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--relay", nargs="*", default=[])
    ap.add_argument("--bestpass", nargs="*", default=[])
    ap.add_argument("--workdir", default="/tmp/xlsxrepair")
    ap.add_argument("--outdir", default="data/processed")
    args = ap.parse_args()
    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)

    if args.relay:
        rows = []
        for f in args.relay:
            r = load_relay(f, args.workdir)
            print(f"  relay    {Path(f).name[:40]:<42}{len(r):>8,} txns")
            rows += r
        cols = list(rows[0].keys())
        with (out / "relay_txns.csv").open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
        print(f"  -> {len(rows):,} Relay transactions  "
              f"${sum(abs(r['amount']) for r in rows):,.2f}\n")

    if args.bestpass:
        rows = []
        for f in args.bestpass:
            r = load_bestpass(f, args.workdir)
            print(f"  bestpass {Path(f).name[:40]:<42}{len(r):>8,} txns")
            rows += r
        cols = list(rows[0].keys())
        with (out / "bestpass_tolls.csv").open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
        print(f"  -> {len(rows):,} toll transactions  "
              f"${sum(abs(r['amount']) for r in rows):,.2f}")


if __name__ == "__main__":
    main()
