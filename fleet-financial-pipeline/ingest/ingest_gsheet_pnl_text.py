"""
Same weekly P&L workbooks as ingest_gsheet_pnl.py, but read from Drive's TEXT
rendering instead of .xlsx.

Why this exists: Google Drive refuses to export a spreadsheet above its size
limit, and the two largest P&Ls -- ZONE (3 years of weeks) and Xtrack -- are
over it. Their numbers are still reachable through the text rendering, so the
choice is between these numbers without a time axis and no numbers at all.

WHAT IS LOST, STATED PLAINLY: the text rendering does not carry tab names, and
the cells themselves contain no dates. So every week here is identified only by
its ORDINAL position in the workbook. This module therefore never writes a
week_start. Totals across the whole file are sound; anything that needs a date
-- monthly comparison against bank statements, seasonality, tying a week to a
statement period -- is NOT available from this path and must come from an
.xlsx export of the same sheet.

Week boundaries are detected by the once-per-tab appearance of the summary
panel's anchor metric rather than by guessing at blank lines, which appear both
between tabs and inside them.

Usage:
    python ingest/ingest_gsheet_pnl_text.py zone.txt --entity ZONE --outdir out/
"""
import argparse
import csv
import json
import re
from pathlib import Path

from ingest_gsheet_pnl import UNIT_COLS, num, txt

ANCHOR = "Total gross"       # appears exactly once per weekly tab
UNMESCAPE = re.compile(r"\\(.)")


def cells(line):
    if not line.startswith("|"):
        return []
    parts = [UNMESCAPE.sub(r"\1", c).strip() for c in line.split("|")[1:-1]]
    return parts


def load_rows(path):
    raw = Path(path).read_text()
    try:
        raw = json.loads(raw)["fileContent"]
    except (ValueError, KeyError):
        pass
    out = []
    for line in raw.split("\n"):
        c = cells(line)
        if c and not all(x in ("", ":-:", "---") or set(x) <= set(":- ") for x in c):
            out.append(c)
    return out


def parse(rows, entity):
    units, metrics = [], []
    week = 0
    cur_unit = cur_driver = None
    in_block = False

    for i, r in enumerate(rows):
        def c(j):
            return r[j] if j < len(r) else None

        head = txt(c(0))
        if head == "Unit#":
            in_block, cur_unit, cur_driver = True, None, None
            continue
        if in_block:
            if cur_unit is None and head and head != "Unit#":
                cur_unit, cur_driver = head, txt(c(1))
            if txt(c(1)) == "Total":
                rec = {"entity": entity, "week_ordinal": week,
                       "unit": cur_unit or "", "driver": cur_driver or ""}
                for j, name in enumerate(UNIT_COLS):
                    if j >= 2:
                        rec[name] = num(c(j))
                vals = [v for k, v in rec.items()
                        if k in UNIT_COLS[2:] and v not in (None, 0.0)]
                if rec["unit"] or rec["driver"] or vals:
                    units.append(rec)
                in_block = False

        label = txt(c(15))
        if label == ANCHOR:
            week += 1
        if label and not label.startswith("#") and num(label) is None:
            v = num(c(16))
            if v is not None:
                metrics.append({"entity": entity, "week_ordinal": week,
                                "metric": label, "value": v})
        if label in ("C drivers", "US salary") and i + 1 < len(rows):
            nxt = rows[i + 1]
            for k in range(6):
                lab = txt(c(15 + k))
                if not lab:
                    continue
                v = num(nxt[15 + k]) if 15 + k < len(nxt) else None
                if v is not None:
                    metrics.append({"entity": entity, "week_ordinal": week,
                                    "metric": lab, "value": v})
    return units, metrics, week


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("textfile")
    ap.add_argument("--entity", required=True)
    ap.add_argument("--outdir", default="data/processed")
    args = ap.parse_args()

    rows = load_rows(args.textfile)
    units, metrics, weeks = parse(rows, args.entity)

    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)
    up = out / f"pnl_unit_week_{args.entity}.csv"
    mp = out / f"pnl_metrics_{args.entity}.csv"
    with up.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["entity", "week_ordinal", "unit",
                                           "driver"] + UNIT_COLS[2:],
                           extrasaction="ignore")
        w.writeheader()
        w.writerows(units)
    with mp.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["entity", "week_ordinal", "metric", "value"])
        w.writeheader()
        w.writerows(metrics)

    print(f"{args.entity}: {weeks} weekly panels -> {len(units):,} unit-weeks, "
          f"{len(metrics):,} metrics")
    print(f"  NO DATES: the text rendering carries no tab names, so weeks are "
          f"ordinals only. Totals are sound; per-period comparison is not "
          f"available from this path.")
    print(f"  -> {up}\n  -> {mp}")


if __name__ == "__main__":
    main()
