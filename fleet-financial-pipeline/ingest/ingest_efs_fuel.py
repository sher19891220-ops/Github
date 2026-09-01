"""
EFS / WEX fuel-card transaction reports.

This is the itemization behind the single largest line in the whole analysis.
The bank shows the card settling as consolidated drafts -- 626 of them totalling
$12,262,134 -- with no indication of what was bought. That number was carried
into the findings as "fuel" with an explicit caveat that a fuel card also
carries cash advances, scales, DEF and tires, and that only the itemization
could say how much of it is actually diesel. This module is that check.

The Item column is what makes it possible: every line names what was purchased,
with quantity and unit price, so diesel can be separated from everything else
that rides the same card.

Two file defects to know about, both repaired by bulk_intake.repair_xlsx:
  * the export declares <dimension ref="A1"/> on a 24,634-row sheet. openpyxl
    trusts it and returns ONE row, with no error -- the file reads as an empty
    report instead of a year of fuel.
  * Bestpass writes no shared-string table at all.

Odometer readings come along for free on every line, which is a second,
independent mileage source to check the odometer sheets against.

Usage:
    python ingest/ingest_efs_fuel.py <files...> --entity ZONE --out efs.csv
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

# What the Item column calls diesel. Everything else is not fuel, however much
# it looks like a fuel-card charge.
DIESEL = ("diesel", "ulsd", "dsl", "biodiesel", "def")
FIELDS = ["card", "txn_date", "invoice", "unit", "driver", "odometer",
          "location", "city", "state", "fees", "item", "unit_price", "qty", "amount"]


def num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace("$", "").replace(",", "").strip()
    if not s:
        return None
    neg = s.startswith("(") and s.endswith(")")
    try:
        x = float(s.strip("()"))
    except ValueError:
        return None
    return -x if neg else x


def load(path, entity, workdir):
    import openpyxl
    wb = openpyxl.load_workbook(repair_xlsx(Path(path), Path(workdir)),
                                read_only=True, data_only=True)
    ws = wb.active
    it = ws.iter_rows(values_only=True)
    hdr = [str(h or "").strip().lower() for h in next(it)]
    idx = {}
    for j, h in enumerate(hdr):
        for k, names in (("card", ("card #",)), ("txn_date", ("tran date",)),
                         ("invoice", ("invoice",)), ("unit", ("unit",)),
                         ("driver", ("driver name",)), ("odometer", ("odometer",)),
                         ("location", ("location name",)), ("city", ("city",)),
                         ("state", ("state/ prov", "state/prov")),
                         ("fees", ("fees",)), ("item", ("item",)),
                         ("unit_price", ("unit price",)), ("qty", ("qty",)),
                         ("amount", ("amt", "amount"))):
            if h in names and k not in idx:
                idx[k] = j
    out = []
    for r in it:
        def g(k):
            j = idx.get(k)
            return r[j] if j is not None and j < len(r) else None
        amt = num(g("amount"))
        if amt is None:
            continue
        d = g("txn_date")
        if hasattr(d, "date"):
            d = d.date().isoformat()
        else:
            try:
                d = datetime.strptime(str(d).strip()[:10], "%m/%d/%Y").date().isoformat()
            except ValueError:
                d = str(d)[:10]
        item = str(g("item") or "").strip()
        out.append({"entity": entity, "source_file": Path(path).name,
                    "card": str(g("card") or "").strip(), "txn_date": d,
                    "invoice": str(g("invoice") or "").strip(),
                    "unit": str(g("unit") or "").strip(),
                    "driver": str(g("driver") or "").strip(),
                    "odometer": num(g("odometer")), "location": str(g("location") or "").strip(),
                    "city": str(g("city") or "").strip(), "state": str(g("state") or "").strip(),
                    "fees": num(g("fees")), "item": item,
                    "unit_price": num(g("unit_price")), "qty": num(g("qty")),
                    # project convention: negative = money out
                    "amount": -abs(amt),
                    "is_diesel": "yes" if any(k in item.lower() for k in DIESEL) else "no"})
    wb.close()
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--entity", required=True)
    ap.add_argument("--workdir", default="/tmp/xlsxrepair")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    rows = []
    for f in args.files:
        r = load(f, args.entity, args.workdir)
        print(f"  {Path(f).name[:46]:<48}{len(r):>8,} lines")
        rows += r

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with Path(args.out).open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["entity", "source_file"] + FIELDS + ["is_diesel"])
        w.writeheader()
        w.writerows(rows)
    print(f"\n{len(rows):,} card lines -> {args.out}")
    if rows:
        print(f"  period {min(r['txn_date'] for r in rows)} .. {max(r['txn_date'] for r in rows)}")


if __name__ == "__main__":
    main()
