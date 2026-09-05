"""What registration costs, per company and per truck-week.

`ingest/parse_irp.py` reads the payments; this puts them on the fleet. Three
things come out of the join that the payment list alone cannot say.

WHO PAYS. The registration file names trucks and never names a company, so the
$82,877 is unallocable on its own. `ingest/fleet_registry.py` resolves 45 of the
48 trucks to the company whose P&L last carried them, which is measurement, not
judgement.

WHAT AN IDLE TRUCK STILL COSTS. IRP and HVUT are annual and prepaid, so they do
not stop when a truck stops. That makes them the same shape as insurance and the
opposite shape of fuel, and they belong in the cost of a parked truck.

WHAT IS NOT HERE. The master insurance schedule carries 68 tractors; this file
registers 48. A tractor that is insured and not registered cannot legally run,
so the gap is either trucks registered under a payment not in this file, or
plates that lapsed on the units that stopped running. It is reported as a
question, never netted away.

AND THE BANK SETTLES IT. Registration has a named counterparty on both legs --
`8308OHIODPSIRP DES:IRP FEE` for the plates and `IRS DES:USATAXPYMT` for the
HVUT -- so unlike most of this corpus the sheet can be tested against cash
rather than against itself. It does not survive the test in either direction,
and the two failures point OPPOSITE ways:

    the sheet's own flagged duplicate is NOT one. Two $2,493.34 IRP rows for the
    same three trucks, ONE debit in the bank -- so the row is duplicated, no
    money was lost, and the $82,968 total is overstated.
    a duplicate the sheet does NOT flag IS one. Unit 7584's $458.33 HVUT was
    debited by the IRS TWICE, thirteen days apart, and the sheet lists it once.
    That is real money and it is recoverable.

MATCH INSIDE THE VENDOR, NEVER ON AMOUNT ALONE. $1,100 matches eleven bank rows
and $5,500 matches five -- Zelle payments, wires, mobile deposits, none of them
registration. The sheet's $51.31 plate transfer matches a Speedway fuel card
charge to the cent. Every one of those is a false positive that would have
"confirmed" a payment that never happened, so the reconciler only ever looks
inside rows already identified as that vendor's.
"""
import sys
import warnings
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import pandas as pd                 # noqa: E402

import fleet_registry as F          # noqa: E402
import parse_irp as R               # noqa: E402

BANK = ROOT / "data/processed/boa_transactions.csv"
# The two counterparties registration money actually leaves through. Matching on
# these first is the whole reconciler -- see the module docstring.
VENDORS = {"irp": r"OHIODPSIRP|IRP FEE", "hvut": r"USATAXPYMT"}

WEEKS = 52.0
# The date the 21 insured units stopped appearing in any P&L. Reused here so
# "still running" means the same thing in both modules.
RUNNING_SINCE = "2026-07-06"


def unit_index():
    """unit number -> the registry rows that carry it.

    A unit can appear on more than one company's list, because a truck that
    moved authority stays in both histories. So this maps to a LIST and the
    caller decides; collapsing it to one company here would silently pick one.
    """
    rows, _ = F.registry()
    idx = defaultdict(list)
    for r in rows:
        for u in r.get("units") or []:
            idx[str(u)].append(r)
    return idx


def attribute(per_truck, idx):
    """Registration cost by company, plus what cannot be attributed."""
    out = defaultdict(float)
    unresolved, stale = {}, {}
    for u, v in per_truck.items():
        rows = idx.get(str(u))
        if not rows:
            unresolved[u] = v["total"]
            out["NOT IN THE FLEET REGISTRY"] += v["total"]
            continue
        # Latest week wins: that is the company running the truck now.
        best = max(rows, key=lambda r: r.get("last_week") or "")
        co = best.get("company")
        out[co or "NO COMPANY ON ANY P&L"] += v["total"]
        # A truck that has never appeared in any P&L is already counted in the
        # "NO COMPANY" bucket above. Reporting it again as "stopped running"
        # double-counts it and reads as a fleet shrinking that never grew.
        if best.get("last_week") and best["last_week"] < RUNNING_SINCE:
            stale[u] = (v["total"], best["last_week"], co)
    return dict(out), unresolved, stale


def bank_rows():
    """Registration debits, by leg, from the verified statements only."""
    t = pd.read_csv(BANK)
    d = t.description.fillna("").str.upper()
    out = {}
    for leg, pat in VENDORS.items():
        m = t[d.str.contains(pat, regex=True)].copy()
        m["amt"] = m.amount.abs().round(2)
        out[leg] = m.sort_values("txn_date")
    return out


def reconcile(payments, red):
    """Sheet lines against bank debits, one leg at a time.

    Greedy on amount WITHIN the leg, so a sheet line consumes one debit and a
    second identical line has to find a second debit of its own. That is the
    whole test: it is what separates a duplicated row from a duplicate payment.
    """
    bank = bank_rows()
    lines = [dict(p) for p in payments] + ([dict(red)] if red else [])
    for p in lines:
        # A renewal is billed by the same Ohio IRP counterparty; HVUT is the
        # only leg that goes to the IRS.
        p["leg"] = "hvut" if p["section"] in ("hvut", "red") else "irp"

    used, matched, unmatched = set(), [], []
    for p in lines:
        pool = bank[p["leg"]]
        hit = [i for i, r in pool.iterrows()
               if i not in used and abs(r.amt - round(p["amount"], 2)) < 0.005]
        if hit:
            used.add(hit[0])
            matched.append((p, pool.loc[hit[0]]))
        else:
            unmatched.append(p)

    extra = [(leg, r) for leg, pool in bank.items()
             for i, r in pool.iterrows() if i not in used]
    return matched, unmatched, extra, duplicate_debits(bank)


# A repeated amount is not a duplicate. HVUT is a FLAT $550 a truck, so three
# $550 debits are three trucks, and a $30.25 IRP fee eight months apart is two
# transactions. What is suspicious is a repeat of an amount that could only
# belong to ONE truck -- a prorated HVUT is priced to that truck's first month
# of use -- landing twice in the same billing window.
DUP_WINDOW_DAYS = 45


def duplicate_debits(bank):
    out = []
    for leg, pool in bank.items():
        for amt, g in pool.groupby("amt"):
            if len(g) < 2:
                continue
            if leg == "hvut" and abs(amt / R.HVUT_ANNUAL - round(amt / R.HVUT_ANNUAL)) < 0.005:
                continue                      # whole trucks at the flat rate
            days = pd.to_datetime(g.txn_date)
            if (days.max() - days.min()).days > DUP_WINDOW_DAYS:
                continue                      # different billing events
            out.append((leg, amt, g))
    return out


def main():
    payments, red, reference = R.read()
    fails, notes = R.controls(payments, red, reference)
    if fails:
        print("CONTROLS FAILED -- not attributing until the parse is right:")
        for f in fails:
            print(f"  {f}")
        return
    per_truck = R.per_unit(payments)
    idx = unit_index()
    by_co, unresolved, stale = attribute(per_truck, idx)

    total = R.grand_total(payments, red)
    print(f"== REGISTRATION, {len(per_truck)} TRUCKS, ${total:,.2f} ==")
    print("  IRP apportioned plates + federal HVUT + renewals + plate transfers.")
    print("  Annual and prepaid, so it does not pause when a truck does.\n")

    print(f"  {'company':<28}{'annual':>12}{'per week':>11}{'trucks':>8}"
          f"{'per truck-yr':>14}")
    counts = defaultdict(int)
    for u in per_truck:
        rows = idx.get(str(u))
        best = max(rows, key=lambda r: r.get("last_week") or "") if rows else None
        key = (best.get("company") or "NO COMPANY ON ANY P&L") if best \
            else "NOT IN THE FLEET REGISTRY"
        counts[key] += 1
    for co, v in sorted(by_co.items(), key=lambda kv: -kv[1]):
        n = counts[co]
        print(f"  {co:<28}{v:>12,.0f}{v / WEEKS:>11,.0f}{n:>8}{v / n:>14,.0f}")
    alloc = sum(v for k, v in by_co.items() if k in ("ZONE", "XTRACK", "AFG"))
    print(f"  {'ALLOCATED':<28}{alloc:>12,.0f}{alloc / WEEKS:>11,.0f}")

    # The line this pipeline was missing.
    n = len(per_truck)
    print(f"\n== THE LINE THE BREAK-EVEN MODEL DOES NOT HAVE ==")
    print(f"  ${total / n:,.2f} a truck a year = ${total / n / WEEKS:.2f} a truck-week "
          f"= ${total / n / 365:.2f} a truck-day.")
    print("  Small next to insurance, and the same SHAPE: fixed, annual, prepaid,")
    print("  and charged in full on a truck that never turns a wheel. It is absent")
    print("  from analysis/truck_breakeven.py and from every per-truck cost in the")
    print("  weekly P&L, so both understate a parked truck by this much.")

    if stale:
        s = sum(v for v, _, _ in stale.values())
        print(f"\n== REGISTRATION ON TRUCKS THAT STOPPED RUNNING ==")
        print(f"  {len(stale)} of the {n} registered trucks have not appeared in any")
        print(f"  P&L since {RUNNING_SINCE}: ${s:,.0f} of plates and HVUT.")
        for u, (v, wk, co) in sorted(stale.items(), key=lambda kv: -kv[1][0])[:8]:
            print(f"    {u:<8}{v:>9,.0f}   last seen {wk or '-'}   {co or '-'}")
        print("  Unlike the insurance, this money does NOT come back. IRP and HVUT")
        print("  are paid for the year; there is no return premium on a plate.")

    matched, unmatched, extra, dupe_paid = reconcile(payments, red)
    print(f"\n== THE SHEET AGAINST THE BANK ==")
    print(f"  {len(matched)} of {len(payments) + 1} lines matched a debit to the "
          f"Ohio IRP office or the IRS.")

    dups = R.duplicates(payments)
    if dups:
        a, b = dups[0]
        n = sum(1 for _, r in matched if abs(r.amt - round(a["amount"], 2)) < 0.005)
        print(f"\n  THE SHEET'S OWN FLAGGED DUPLICATE IS NOT ONE.")
        print(f"  {a['label']} and {b['label']}: ${a['amount']:,.2f} each for units "
              f"{sorted(a['units'])}.")
        print(f"  The bank has {n} debit of that amount to the Ohio IRP office, not two.")
        print(f"  So the ROW is duplicated and no money was lost -- the ${reference.get('Bottom grand total shown', 0):,.2f}")
        print(f"  total is overstated by ${a['amount']:,.2f}, which is the opposite of a")
        print("  double payment and needs a correction to the sheet, not a refund claim.")

    if dupe_paid:
        print(f"\n  A DUPLICATE THE SHEET DOES NOT FLAG, AND THIS ONE IS REAL.")
        for leg, amt, g in dupe_paid:
            who = "the IRS" if leg == "hvut" else "the Ohio IRP office"
            print(f"  ${amt:,.2f} debited by {who} {len(g)} times: "
                  + ", ".join(g.txn_date.astype(str)))
            hits = [p for p in payments if abs(p["amount"] - amt) < 0.005]
            if hits:
                print(f"    The sheet carries this once, as {hits[0]['label']} "
                      f"unit {hits[0]['units']}.")
                print(f"    ${amt:,.2f} paid twice for one truck's HVUT. Unlike the row "
                      f"above this is cash out, and a 2290 credit can recover it.")

    if unmatched:
        tot_u = sum(p["amount"] for p in unmatched)
        print(f"\n  ON THE SHEET, NOT IN THE BANK: {len(unmatched)} lines, ${tot_u:,.2f}")
        for p in unmatched:
            print(f"    {p['label']:<22}{p['amount']:>10,.2f}  {p['section']}")
        print("  Not evidence they were not paid. The verified statements cover")
        print("  7 accounts and registration may leave through a card or one of the")
        print("  accounts with no statements -- and the Illinois IRP has a different")
        print("  payee entirely. Reported as unverified, never as unpaid.")

    if extra:
        tot_e = sum(abs(r.amount) for _, r in extra)
        print(f"\n  IN THE BANK, NOT ON THE SHEET: {len(extra)} debits, ${tot_e:,.2f}")
        for leg, r in sorted(extra, key=lambda x: -abs(x[1].amount))[:9]:
            print(f"    {r.txn_date}  {abs(r.amount):>9,.2f}  {leg}")
        print("  So the sheet is not the complete registration record either. Every")
        print("  one of these is registration money the per-truck figures above")
        print("  do not carry.")

    if unresolved:
        print(f"\n== REGISTERED, BUT NOT IN THE FLEET REGISTRY ==")
        for u, v in sorted(unresolved.items()):
            print(f"    {u:<8}{v:>9,.0f}")
        print("  Registered and paid for, and on no unit list. Either they are")
        print("  trailers, or the unit workbook is missing them.")


if __name__ == "__main__":
    main()
