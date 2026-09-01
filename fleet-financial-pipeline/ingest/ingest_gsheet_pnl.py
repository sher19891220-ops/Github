"""
Weekly per-unit P&L workbooks (the "<Entity> Profit and Loss Weekly" sheets).

One Google Sheet per operating company, ONE TAB PER WEEK, named for the week it
covers ("08.17.26-08.23.26"). Each tab holds two independent things side by
side, and both matter:

  cols A-O   repeated per-unit blocks: a "Unit# | Driver | Gross | Mileage |
             Driver Salary | ... " header, one row per LOAD, then a "Total" row
             that is the unit's week. The unit number is in column A of the
             first row of the block; the rows under it are that unit's loads.
  cols P-V   a weekly summary panel of label/value pairs -- "Total gross",
             "Total driver pay", "Salaries of OO", "C drivers" / "OO drivers",
             "OO trucks" / "CD trucks". This panel is where the owner-operator
             split lives, and it exists nowhere else in the corpus.

Two things to know before trusting anything this produces:

1. THE WEEK IS ONLY IN THE TAB NAME. The cell contents carry no date at all, so
   a text export of this workbook loses the time axis entirely. The tab name is
   the sole source of the period -- which is why this reads .xlsx and not the
   text rendering. Tab names are hand-typed and carry stray spaces and mixed
   separators; parse_week() is deliberately forgiving about that and refuses
   rather than guesses when it cannot read one.

2. THESE ARE ASSERTIONS, NOT CASH. This is the P&L the business has been
   deciding on -- hand-maintained, and the thing the bank data exists to test.
   Values are kept in the sheet's own orientation (costs positive) and are NOT
   sign-flipped here; normalisation happens at comparison time so that a
   mismatch is visible rather than absorbed. Formula cells that evaluated to
   #DIV/0! or #REF! are recorded as null, never as zero: a zero would silently
   average into a per-mile figure.

Usage:
    python ingest/ingest_gsheet_pnl.py AFG_PnL.xlsx --entity AFG --outdir out/
"""
import argparse
import csv
import re
import warnings
from datetime import date
from pathlib import Path

warnings.filterwarnings("ignore")

UNIT_COLS = ["unit", "driver", "gross", "mileage", "driver_salary",
             "insur_admin_trl", "def_fuel_fee", "truck_rental", "toll_scale",
             "additional_charges", "subtotal", "other_charges", "total",
             "per_mile", "fuel_avr"]

# "08.17.26-08.23.26", " 04.27.26- 05.03.26", "07.20.26 - 07.26.26"
WEEK = re.compile(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})\s*[-–]\s*"
                  r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})")

ERR = ("#DIV/0!", "#REF!", "#VALUE!", "#N/A", "#NAME?", "#NUM!", "#NULL!")


def parse_week(tab):
    m = WEEK.search(tab.replace(" ", ""))
    if not m:
        return None, None
    a, b, c, d, e, f = (int(x) for x in m.groups())
    y1 = c + 2000 if c < 100 else c
    y2 = f + 2000 if f < 100 else f
    try:
        return date(y1, a, b), date(y2, d, e)
    except ValueError:
        return None, None


def num(v):
    """Formula errors become None, never 0.0 -- a zero would average in."""
    if v is None or (isinstance(v, str) and (not v.strip() or v.strip() in ERR)):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace("$", "").replace(",", "").strip()
    if s in ERR or not s:
        return None
    neg = s.startswith("(") and s.endswith(")")
    try:
        x = float(s.strip("()"))
    except ValueError:
        return None
    return -x if neg else x


def txt(v):
    return str(v).strip() if v is not None else ""


def parse_sheet(ws, entity, tab):
    """Returns (unit_week_rows, weekly_metric_rows)."""
    w0, w1 = parse_week(tab)
    rows = [list(r) for r in ws.iter_rows(values_only=True)]

    units, metrics = [], []
    cur_unit = cur_driver = None
    in_block = False

    for r in rows:
        def c(i):
            return r[i] if i < len(r) else None

        head = txt(c(0))
        # --- per-unit blocks -------------------------------------------------
        if head == "Unit#":
            in_block, cur_unit, cur_driver = True, None, None
            continue
        if in_block:
            if cur_unit is None and head and head != "Unit#":
                cur_unit = txt(c(0)).rstrip(".0") if txt(c(0)).endswith(".0") else head
                cur_driver = txt(c(1))
            if txt(c(1)) == "Total":
                rec = {"entity": entity, "tab": tab,
                       "week_start": w0.isoformat() if w0 else "",
                       "week_end": w1.isoformat() if w1 else "",
                       "unit": cur_unit or "", "driver": cur_driver or ""}
                for j, name in enumerate(UNIT_COLS):
                    if j < 2:
                        continue
                    rec[name] = num(c(j))
                # Each tab ships ~82 pre-built empty blocks as scaffolding for
                # a fleet larger than the one that ran. Keep a block only if it
                # names a unit or driver, or moved money. An idle truck with
                # gross 0 and a negative total is NOT empty -- that is rent and
                # insurance accruing on a truck that did not run, which is
                # exactly the kind of cost this analysis exists to find.
                vals = [v for k, v in rec.items()
                        if k in UNIT_COLS[2:] and v not in (None, 0.0)]
                if rec["unit"] or rec["driver"] or vals:
                    units.append(rec)
                in_block = False

        # --- weekly summary panel (label in col P, value in col Q) -----------
        label = txt(c(15))
        # A label column that parses as a number is not a label: it is the
        # VALUE row of a multi-across band (the C drivers / OO drivers split),
        # which parse_split_rows handles by position. Without this guard every
        # such value becomes its own bogus one-off metric name.
        if label and not label.startswith("#") and num(label) is None:
            v = num(c(16))
            if v is not None:
                metrics.append({"entity": entity, "tab": tab,
                                "week_start": w0.isoformat() if w0 else "",
                                "week_end": w1.isoformat() if w1 else "",
                                "metric": label, "value": v})
        # the C/OO split is a 4-across header with its values on the next row,
        # so it is captured by label position rather than the P/Q pair.
        if label in ("C drivers", "US salary"):
            hdr = [txt(c(i)) for i in range(15, 20)]
            metrics.append({"entity": entity, "tab": tab,
                            "week_start": w0.isoformat() if w0 else "",
                            "week_end": w1.isoformat() if w1 else "",
                            "metric": "__ROW__" + "|".join(hdr), "value": 0.0})
    return units, metrics


def parse_split_rows(ws, entity, tab):
    """The 'C drivers / OO drivers / Discount / Total' and
    'US salary / Owner's / Tas_team salaries / Other charges / Net profit'
    bands are headers with their values on the FOLLOWING row."""
    w0, w1 = parse_week(tab)
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    out = []
    for i, r in enumerate(rows[:-1]):
        labels = [txt(r[j]) if j < len(r) else "" for j in range(15, 21)]
        if labels[0] in ("C drivers", "US salary"):
            nxt = rows[i + 1]
            for k, lab in enumerate(labels):
                if not lab:
                    continue
                v = num(nxt[15 + k]) if 15 + k < len(nxt) else None
                if v is not None:
                    out.append({"entity": entity, "tab": tab,
                                "week_start": w0.isoformat() if w0 else "",
                                "week_end": w1.isoformat() if w1 else "",
                                "metric": lab, "value": v})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("--entity", required=True)
    ap.add_argument("--outdir", default="data/processed")
    args = ap.parse_args()

    import openpyxl
    wb = openpyxl.load_workbook(args.xlsx, read_only=True, data_only=True)

    all_units, all_metrics, undated = [], [], []
    for tab in wb.sheetnames:
        ws = wb[tab]
        u, m = parse_sheet(ws, args.entity, tab)
        m = [x for x in m if not x["metric"].startswith("__ROW__")]
        m += parse_split_rows(ws, args.entity, tab)
        all_units += u
        all_metrics += m
        if parse_week(tab) == (None, None):
            undated.append(tab)

    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)
    up = out / f"pnl_unit_week_{args.entity}.csv"
    mp = out / f"pnl_metrics_{args.entity}.csv"
    with up.open("w", newline="") as fh:
        cols = ["entity", "tab", "week_start", "week_end", "unit", "driver"] + UNIT_COLS[2:]
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(all_units)
    with mp.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["entity", "tab", "week_start",
                                           "week_end", "metric", "value"])
        w.writeheader()
        w.writerows(all_metrics)

    weeks = sorted({r["week_start"] for r in all_units if r["week_start"]})
    print(f"{args.entity}: {len(wb.sheetnames)} tabs -> "
          f"{len(all_units):,} unit-weeks, {len(all_metrics):,} weekly metrics")
    if weeks:
        print(f"  period: {weeks[0]} .. {max(r['week_end'] for r in all_units if r['week_end'])}")
    if undated:
        print(f"  {len(undated)} tab(s) with no readable week -- NOT dated, "
              f"reported rather than guessed: {', '.join(undated[:6])}")
    print(f"  -> {up}\n  -> {mp}")


if __name__ == "__main__":
    main()
