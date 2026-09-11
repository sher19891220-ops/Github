"""What Iron Lease charges the operating companies, and whether any of it is cash.

CLAUDE.md already warns that classifying a transfer `intercompany` says the
money moved and never why. The 82 weekly invoices are the missing "why" -- they
itemise what Iron Lease billed -- and the account-5151 statements are the test
of whether the billing and the banking are the same event. They are not, and
that is the finding.

    charged   = Truck rental + Truck Mileage
    credited  = EFS money code + Repair lines, all negative
    net       = what the invoice says was paid

Every invoice in the set is stamped "Paid in Full". Only four of the seventy
that fall inside the bank window have a deposit matching their total within a
dollar and a month, which is roughly what coincidence yields against 58
deposits; 42 of those 58 deposits are exact multiples of $1,000 and no invoice
total is round. So these invoices are settled by NETTING, not by payment, and
"Paid in Full" is a bookkeeping state.

Three consequences that change how other numbers must be read:

  - Iron Lease rent in an operating company's P&L is a BOOK charge. Treating it
    as cash out overstates that company's cash cost and understates the group's
    reliance on funding transfers.
  - A third of what Iron Lease bills goes straight back as maintenance credits,
    so the invoice Total understates both the lease charge and the repair flow.
  - Iron Lease's only real outgoings are trucks: Fleet Advantage and EquipLinc
    purchases plus TBK equipment-finance instalments. No payroll (Zone runs it),
    no insurance, no maintenance leaves account 5151.
"""
import argparse
import json
import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))
sys.path.insert(0, str(ROOT / "analysis"))
from parse_iron_lease_invoices import load as load_invoices, controls as invoice_controls
import parse_tbk_loan_schedule as TBK

IRON_LEASE_TXN = ROOT / "data/processed/iron_lease_transactions.csv"

CHARGE = ("rent", "mileage")
CREDIT = ("efs_credit", "repair_credit")
# A credit line names the date the work was done, in the description, as the
# LAST MM.DD.YY in it. That is not the invoice date -- see credit_lag().
SERVICE_DATE = re.compile(r"(\d{2})\.(\d{2})\.(\d{2})")


def lines(invoices):
    rows = []
    for v in invoices:
        for L in v["lines"]:
            rows.append({"entity": v["entity"], "invoice_no": v.get("invoice_no"),
                         "invoice_date": v.get("invoice_date"), "invoice_total": v.get("total"),
                         "kind": L["category"], "amount": L["amount"], "qty": L["qty"],
                         "rate": L["rate"], "week": L.get("period_start"),
                         "desc": L["desc"]})
    return pd.DataFrame(rows)


def billing(df):
    t = df.pivot_table(index="entity", columns="kind", values="amount",
                       aggfunc="sum", margins=True).fillna(0.0)
    for c in CHARGE + CREDIT:
        if c not in t:
            t[c] = 0.0
    t["charged"] = t[list(CHARGE)].sum(axis=1)
    t["credited"] = t[list(CREDIT)].sum(axis=1)
    t["net_invoiced"] = t.charged + t.credited
    t["credit_pct_of_charge"] = -100 * t.credited / t.charged
    return t[["rent", "mileage", "charged", "efs_credit", "repair_credit",
              "credited", "credit_pct_of_charge", "net_invoiced"]]


def credit_lag(df):
    """Days between the work and the invoice that credits it back."""
    c = df[df.kind.isin(CREDIT)].copy()

    def svc(desc):
        m = SERVICE_DATE.findall(desc)
        if not m:
            return None
        mm, dd, yy = m[-1]
        return f"20{yy}-{mm}-{dd}"

    c["service_date"] = c.desc.map(svc)
    c = c[c.service_date.notna()]
    c["lag_days"] = (pd.to_datetime(c.invoice_date)
                     - pd.to_datetime(c.service_date, errors="coerce")).dt.days
    return c[c.lag_days.between(-60, 500)]


def rent_vs_pnl(df):
    """Iron Lease's weekly rent against the operating company's whole rent line."""
    from ingest_weekly_pnl import read_workbook, WORKBOOKS
    pnl = {k: read_workbook(f) for k, f in WORKBOOKS.items()}
    r = df[(df.kind == "rent") & df.week.notna()]
    out = []
    for _, x in r.iterrows():
        p = pnl.get(x.entity, {}).get(x.week)
        if not p or not p.get("truck_rent"):
            continue
        out.append({"entity": x.entity, "week": x.week, "iron_rent": x.amount,
                    "pnl_truck_rent": p["truck_rent"],
                    "trucks": (p.get("cd_trucks") or 0) + (p.get("oo_trucks") or 0)})
    o = pd.DataFrame(out)
    o["iron_share_pct"] = 100 * o.iron_rent / o.pnl_truck_rent
    return o.sort_values(["entity", "week"])


def cash_test(invoices, txn, tol=1.0, window=30):
    """Does any deposit look like a payment of an invoice?

    Matching on amount alone, in a two-month window, is a DELIBERATELY generous
    test: it will produce coincidental hits. That is the point -- if even a
    generous test finds almost nothing, the invoices are not being paid in cash.
    """
    t = txn.copy()
    t["txn_date"] = pd.to_datetime(t.txn_date)
    dep = t[t.amount > 0]
    last = t.txn_date.max()
    matched, unmatched = [], []
    for v in invoices:
        if not v.get("invoice_date") or not v.get("total"):
            continue
        d = pd.Timestamp(v["invoice_date"])
        if d > last:
            continue
        w = dep[(dep.txn_date >= d - pd.Timedelta(days=window))
                & (dep.txn_date <= d + pd.Timedelta(days=window))]
        (matched if ((w.amount - v["total"]).abs() < tol).any() else unmatched).append(v)
    round_dep = dep[dep.amount % 1000 == 0]
    return {"invoices_in_bank_window": len(matched) + len(unmatched),
            "with_a_matching_deposit": len(matched),
            "with_none": len(unmatched),
            "unmatched_value": sum(v["total"] for v in unmatched),
            "deposits": len(dep), "deposit_total": dep.amount.sum(),
            "round_thousand_deposits": len(round_dep),
            "round_thousand_value": round_dep.amount.sum()}


def tbk_bank_rows(txn_path=IRON_LEASE_TXN):
    """Account 5151's own TBK loan debits and their return-item reversals,
    the two row shapes that matter for this specific reconciliation."""
    t = pd.read_csv(txn_path)
    t["txn_date"] = pd.to_datetime(t.txn_date)
    debits = t[t.description.str.contains("TBK BANK", na=False) & (t.amount < 0)].copy()
    debits["amount"] = -debits["amount"]
    returns = t[t.description.str.contains("RETURN OF POSTED", case=False, na=False)].copy()
    return debits.sort_values("txn_date"), returns.sort_values("txn_date")


def tbk_financing(txn_path=IRON_LEASE_TXN, window_days=3):
    """Reconciles the two TBK equipment-finance loans against account 5151's
    own bank feed, and corrects a real overstatement in what this pipeline
    had been calling 'the TBK equipment-finance total': two of the recurring
    ACH debits bounced and were returned the next business day, then
    re-collected under a 'RETRY PYMT' memo two days later. Both look like
    real, distinct payments if the return credit is not matched against them
    -- CLAUDE.md's $332,431 figure was computed exactly that way, and is
    $28,887.00 (two payments) too high as a result.

    Returns each loan's own controls, its bank-confirmed real payment count
    and cash paid, the bounced-and-returned debits found, and each loan's
    interest/principal/remaining-balance position as of its last confirmed
    payment -- a real, contractual future obligation this pipeline has not
    priced anywhere else.
    """
    loans = TBK.load_all()
    debits, returns = tbk_bank_rows(txn_path)

    # A debit is a bounce if a RETURN OF POSTED CHECK for the same amount
    # posts within `window_days` after it -- the retry that follows it a
    # day or two later is the one real payment for that cycle.
    bounced_idx = set()
    for _, d in debits.iterrows():
        hit = returns[((returns.amount - d.amount).abs() < 0.01)
                      & (returns.txn_date >= d.txn_date)
                      & (returns.txn_date <= d.txn_date + pd.Timedelta(days=window_days))]
        if len(hit):
            bounced_idx.add(d.name)
    real = debits.drop(index=bounced_idx)
    bounced = debits.loc[sorted(bounced_idx)]

    out = []
    for loan in loans:
        fails = TBK.controls(loan)
        suffix = loan["loan_id"][-4:]
        matches = real[real.description.str.contains(suffix, regex=False)]
        n_real = len(matches)
        cash_paid = round(matches.amount.sum(), 2)
        rows_to_date = loan["rows"][:n_real]
        interest_paid = round(sum(r["interest"] for r in rows_to_date), 2)
        principal_paid = round(sum(r["principal"] for r in rows_to_date), 2)
        remaining_balance = (rows_to_date[-1]["balance"] if rows_to_date
                             else loan["principal"])
        remaining_rows = loan["rows"][n_real:]
        out.append({
            "loan_id": loan["loan_id"], "principal": loan["principal"],
            "annual_rate_pct": loan["annual_rate_pct"],
            "controls_pass": not fails, "control_failures": fails,
            "payments_confirmed": n_real, "payments_total": loan["n_payments"],
            "cash_paid_confirmed": cash_paid,
            "interest_paid_confirmed": interest_paid,
            "principal_paid_confirmed": principal_paid,
            "remaining_balance": remaining_balance,
            "remaining_payments": len(remaining_rows),
            "remaining_cash_obligation": round(
                sum(r["payment"] for r in remaining_rows), 2),
            "remaining_interest": round(
                sum(r["interest"] for r in remaining_rows), 2),
        })

    raw_debit_total = round(debits.amount.sum(), 2)
    real_total = round(real.amount.sum(), 2)
    return {"loans": out, "bounced": bounced, "raw_debit_total": raw_debit_total,
            "real_total": real_total,
            "overstatement": round(raw_debit_total - real_total, 2)}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--txn", help="parsed Iron Lease bank transactions (csv)")
    a = ap.parse_args()

    inv = load_invoices()
    fails = invoice_controls(inv)
    print(f"{len(inv)} invoices, "
          f"{min(v['invoice_date'] for v in inv)} .. {max(v['invoice_date'] for v in inv)}")
    print("invoice controls: all pass" if not fails else f"CONTROLS FAILED ({len(fails)}):")
    for n, what, detail in fails[:20]:
        print(f"  {n}: {what}{'' if detail is None else f' — {detail}'}")

    df = lines(inv)
    fmt = lambda v: f"{v:,.0f}"
    print("\n== WHAT IRON LEASE BILLED, AND HANDED BACK ==")
    print(billing(df).to_string(float_format=fmt))

    print("\n== MILEAGE RATES CHARGED ==")
    m = df[(df.kind == "mileage") & df.week.notna() & df.rate.between(0.01, 1)]
    print(m.groupby(["entity", "rate"]).agg(lines=("amount", "size"), miles=("qty", "sum"),
                                            amount=("amount", "sum"), first=("week", "min"),
                                            last=("week", "max")).to_string(float_format=fmt))

    c = credit_lag(df)
    print("\n== HOW LATE THE CREDITS ARE (days from the work to the credit) ==")
    print(c.groupby("kind").lag_days.describe()[["count", "mean", "50%", "75%", "max"]]
          .to_string(float_format=fmt))
    late = c[c.lag_days > 60]
    print(f"  more than 60 days late: {len(late)} of {len(c)} credits, "
          f"${-late.amount.sum():,.0f} of ${-c.amount.sum():,.0f}")

    print("\n== IRON LEASE RENT AS A SHARE OF THE OPERATING COMPANY'S RENT LINE ==")
    rv = rent_vs_pnl(df)
    print(rv.groupby("entity").agg(weeks=("week", "size"), first=("week", "min"),
                                   last=("week", "max"), iron_rent=("iron_rent", "mean"),
                                   pnl_rent=("pnl_truck_rent", "mean"),
                                   share_pct=("iron_share_pct", "mean"))
          .to_string(float_format=lambda v: f"{v:,.1f}"))

    if a.txn and Path(a.txn).exists():
        print("\n== IS ANY OF IT CASH? ==")
        for k, v in cash_test(inv, pd.read_csv(a.txn)).items():
            print(f"  {k:<28}{v:>14,.0f}")

    if IRON_LEASE_TXN.exists() and TBK.load_all():
        print("\n== TBK EQUIPMENT FINANCE, LOAN BY LOAN ==")
        r = tbk_financing()
        print(f"  Two loans, {r['real_total']:,.2f} confirmed paid to the bank so far "
              f"(the earlier ${r['raw_debit_total']:,.2f} figure this corpus quoted was "
              f"${r['overstatement']:,.2f} too high -- {len(r['bounced'])} debit(s) "
              "bounced and were returned the next business day, then re-collected days "
              "later under a RETRY PYMT memo; both looked like a second real payment "
              "unless matched against the return.)\n")
        for loan in r["loans"]:
            print(f"  Loan {loan['loan_id']}: ${loan['principal']:,.2f} at "
                  f"{loan['annual_rate_pct']}%, controls "
                  f"{'pass' if loan['controls_pass'] else 'FAIL'}")
            print(f"    confirmed: {loan['payments_confirmed']}/{loan['payments_total']} "
                  f"payments, ${loan['cash_paid_confirmed']:,.2f} paid "
                  f"(${loan['interest_paid_confirmed']:,.2f} interest, "
                  f"${loan['principal_paid_confirmed']:,.2f} principal)")
            print(f"    remaining: {loan['remaining_payments']} payments, "
                  f"${loan['remaining_balance']:,.2f} balance, "
                  f"${loan['remaining_cash_obligation']:,.2f} future cash "
                  f"(${loan['remaining_interest']:,.2f} of it interest) -- "
                  "a contractual future obligation not priced anywhere else "
                  "in this pipeline.")


if __name__ == "__main__":
    main()
