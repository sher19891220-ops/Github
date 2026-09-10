"""
Weekly P&L against bank cash, per company.

ACCOUNT MAP -- established from which statement archive each account's PDFs came
out of, not guessed from the number:
    ZONE    0271, 1558      XTRACK  5525, 5745      AFG  4504      SHOP  8660

WHY THE TWO SIDES CANNOT SIMPLY BE SUBTRACTED

Factoring. Most freight is sold to Triumph, so what reaches the bank is the
advance net of the fee, days after the load. P&L gross will therefore sit ABOVE
bank deposits structurally, and a gap is not evidence of anything until the
factoring statements say what the advance rate is. The P&L itemises a factoring
FEE (about 2,059 a week at ZONE, 2,655 at XTRACK) but the fee is not the advance.

Timing. The P&L books a load in the week it ran; the bank sees it when it
settles. Week-by-week the two will not line up even when the totals do, so the
comparison is run on cumulative totals as well as per week.

Payment rails. Relay, EFS and Bestpass itemise weekly and hit the bank as one
consolidated draft, so rail totals are RECONCILED against the draft, never
summed alongside it.

What this module therefore reports is the SHAPE of the difference -- level,
trend, and whether it moves with volume -- rather than a variance that pretends
the two sides are the same measurement.

AND THE FINDING THAT LIMITS ALL OF IT: THE GROUP RUNS ONE OPERATING ACCOUNT.

Revenue lands in each company's own account and is then swept out -- XTRACK
sweeps 95% of what it receives, its second account 93%, ZONE's second 71% --
into ZONE 0271, which pays for everything. All 15.4M of fuel and all 6.5M of
lease and rent for the whole group leave from that one account. XTRACK spends
203,966 of its own 9.1M; AFG spends 334,096 of its 982,449.

So a per-company cash P&L cannot be built from the bank. The bank cannot say
whose fuel a fuel payment was, because every company's fuel leaves the same
account on the same draft. The per-company split exists ONLY in the weekly P&L
allocation, and there is nothing in the cash to check it against. Any statement
of the form "company X's real costs were Y" is an allocation, not a measurement,
and must be labelled as one.

What the bank CAN still verify: group-level totals, the category mix, the
payment rails, and whether the group as a whole spends what it says it spends.
"""
import argparse
import collections
import csv
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "ingest"))
from ingest_weekly_pnl import week_key, overhead_row, labeled, blocks, WANT

ACCOUNTS = {"0271": "ZONE", "1558": "ZONE", "5525": "XTRACK", "5745": "XTRACK",
            "4504": "AFG", "8660": "SHOP"}
NOT_SPEND = ("intercompany", "internal_transfer", "card_payment")


def monday(d):
    return d - timedelta(days=d.weekday())


def bank_by_week(path):
    """Company -> week-Monday -> {'in': x, 'out': y} from verified transactions."""
    out = collections.defaultdict(lambda: collections.defaultdict(
        lambda: {"in": 0.0, "out": 0.0, "cats": collections.Counter()}))
    for r in csv.DictReader(Path(path).open()):
        co = ACCOUNTS.get(r.get("account"))
        if not co or not r.get("date"):
            continue
        try:
            d = date.fromisoformat(r["date"][:10])
            amt = float(r["amount"])
        except (ValueError, TypeError):
            continue
        cell = out[co][monday(d).isoformat()]
        cat = r.get("category", "")
        if amt > 0:
            cell["in"] += amt
        elif cat not in NOT_SPEND:
            cell["out"] += -amt
            cell["cats"][cat] += -amt
    return out


def pnl_by_week(files):
    import openpyxl
    out = {}
    for co, path in files.items():
        wb = openpyxl.load_workbook(path, data_only=True)
        weeks = {}
        for tab in wb.sheetnames:
            k = week_key(tab)
            if not k:
                continue
            ws = wb[tab]
            d = {"tab": tab}
            d.update(overhead_row(ws))
            d.update(labeled(ws, WANT))
            b = blocks(ws)
            d["unit_gross"] = sum(x[0] for x in b)
            d["unit_miles"] = sum(x[1] for x in b)
            weeks[k] = d
        out[co] = weeks
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bank", default="data/processed/cash_categorized.csv")
    ap.add_argument("--zone", required=True)
    ap.add_argument("--xtrack", required=True)
    ap.add_argument("--afg", required=True)
    a = ap.parse_args()

    bank = bank_by_week(a.bank)
    pnl = pnl_by_week({"ZONE": a.zone, "XTRACK": a.xtrack, "AFG": a.afg})

    for co in ("ZONE", "XTRACK", "AFG"):
        wks = sorted(pnl[co])
        print(f"\n{'=' * 78}\n{co}  --  {len(wks)} weeks, {wks[0]} to {wks[-1]}\n{'=' * 78}")
        print(f"  {'week':<12}{'P&L gross':>12}{'bank in':>12}{'ratio':>8}"
              f"{'bank out':>12}{'P&L net':>11}")
        tg = tin = tout = tnet = 0.0
        covered = 0
        for w in wks:
            d = pnl[co][w]
            g = d.get("gross") or 0.0
            b = bank[co].get(w, {"in": 0.0, "out": 0.0})
            n = d.get("net_profit")
            tg += g; tin += b["in"]; tout += b["out"]; tnet += n or 0.0
            if b["in"] or b["out"]:
                covered += 1
            ratio = f"{b['in'] / g:.2f}" if g else "-"
            print(f"  {w:<12}{g:>12,.0f}{b['in']:>12,.0f}{ratio:>8}"
                  f"{b['out']:>12,.0f}{(n or 0):>11,.0f}")
        print(f"  {'-' * 66}")
        print(f"  {'TOTAL':<12}{tg:>12,.0f}{tin:>12,.0f}"
              f"{(tin / tg if tg else 0):>8.2f}{tout:>12,.0f}{tnet:>11,.0f}")
        print(f"\n  weeks with any bank activity: {covered}/{len(wks)}")
        if tg:
            print(f"  bank receipts are {100 * tin / tg:.0f}% of P&L gross "
                  f"-- the rest is factored, and the advance rate is unconfirmed")
        print(f"  bank outflow vs P&L net: cash out {tout:,.0f} against a stated "
              f"net of {tnet:,.0f}")


if __name__ == "__main__":
    main()
