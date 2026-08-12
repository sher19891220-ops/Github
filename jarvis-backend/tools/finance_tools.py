"""
Finance tools: Plaid (bank accounts + transactions) and QuickBooks.

PLAID SETUP (bank accounts):
  1. Sign up at plaid.com/developers (free sandbox, paid production)
  2. Get Client ID and Secret from dashboard
  3. Run: python setup_plaid.py  — connects your bank accounts
  4. Set PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKENS in .env
  Note: PLAID_ACCESS_TOKENS is comma-separated if you have multiple banks.

QUICKBOOKS SETUP:
  1. Sign up at developer.intuit.com
  2. Create an app → get Client ID and Client Secret
  3. Run: python setup_quickbooks.py  — completes OAuth flow
  4. Set QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REALM_ID, QB_ACCESS_TOKEN, QB_REFRESH_TOKEN in .env
"""

import os
import logging
from datetime import datetime, timedelta

log = logging.getLogger(__name__)

# Plaid
PLAID_CLIENT_ID = os.environ.get("PLAID_CLIENT_ID", "")
PLAID_SECRET = os.environ.get("PLAID_SECRET", "")
PLAID_ENV = os.environ.get("PLAID_ENV", "production")
# Multiple banks supported: comma-separated access tokens
PLAID_ACCESS_TOKENS = [t.strip() for t in os.environ.get("PLAID_ACCESS_TOKENS", os.environ.get("PLAID_ACCESS_TOKEN", "")).split(",") if t.strip()]

# QuickBooks
QB_CLIENT_ID = os.environ.get("QB_CLIENT_ID", "")
QB_CLIENT_SECRET = os.environ.get("QB_CLIENT_SECRET", "")
QB_REALM_ID = os.environ.get("QB_REALM_ID", "")
QB_ACCESS_TOKEN = os.environ.get("QB_ACCESS_TOKEN", "")
QB_REFRESH_TOKEN = os.environ.get("QB_REFRESH_TOKEN", "")


# ── Plaid (REST API — no SDK required) ────────────────────────────────────────

def _plaid_url():
    env_hosts = {
        "sandbox": "https://sandbox.plaid.com",
        "development": "https://development.plaid.com",
        "production": "https://production.plaid.com",
    }
    return env_hosts.get(PLAID_ENV.lower(), "https://production.plaid.com")


def _plaid_post(endpoint, payload):
    import httpx
    url = f"{_plaid_url()}{endpoint}"
    body = {"client_id": PLAID_CLIENT_ID, "secret": PLAID_SECRET, **payload}
    resp = httpx.post(url, json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()


def bank_accounts():
    """Get all connected bank accounts with current and available balances."""
    if not PLAID_CLIENT_ID or not PLAID_ACCESS_TOKENS:
        return (
            "Bank integration not configured.\n"
            "Setup: sign up at plaid.com/developers, get API keys, run setup_plaid.py\n"
            "Then add PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKENS to .env"
        )
    try:
        all_accounts = []
        for token in PLAID_ACCESS_TOKENS:
            data = _plaid_post("/accounts/get", {"access_token": token})
            all_accounts.extend(data.get("accounts", []))

        if not all_accounts:
            return "No bank accounts found."

        total_available = sum(
            float(a["balances"].get("available") or 0)
            for a in all_accounts
            if a.get("type") == "depository"
        )

        lines = [f"🏦 Bank Accounts ({len(all_accounts)} total | ~${total_available:,.2f} total available)\n"]
        for acc in all_accounts:
            b = acc["balances"]
            official = acc.get("official_name", "")
            lines.append(
                f"• {acc['name']}"
                + (f" ({official})" if official and official != acc["name"] else "")
                + f"\n"
                f"  Type: {acc['type']} / {acc['subtype']}\n"
                f"  Current balance:   ${float(b.get('current') or 0):,.2f}\n"
                f"  Available balance: ${float(b.get('available') or 0):,.2f}"
                + (f"\n  Credit limit: ${float(b['limit']):,.2f}" if b.get("limit") else "")
                + f"\n  Account ending: ...{acc.get('mask', 'N/A')}\n"
                f"  Account ID: {acc['account_id']}"
            )
        return "\n\n".join(lines)
    except Exception as e:
        return f"Bank accounts error: {e}"


def bank_transactions(days=30, account_id=None, category=None):
    """
    Get bank transactions from the past N days across all connected accounts.
    Optionally filter by account_id or category keyword.
    """
    if not PLAID_CLIENT_ID or not PLAID_ACCESS_TOKENS:
        return "Bank integration not configured. Run setup_plaid.py first."
    try:
        start = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        end = datetime.now().strftime("%Y-%m-%d")

        all_txns = []
        for token in PLAID_ACCESS_TOKENS:
            payload = {"access_token": token, "start_date": start, "end_date": end}
            if account_id:
                payload["options"] = {"account_ids": [account_id]}
            data = _plaid_post("/transactions/get", payload)
            all_txns.extend(data.get("transactions", []))

        if category:
            all_txns = [t for t in all_txns if any(category.lower() in c.lower() for c in (t.get("category") or []))]

        all_txns.sort(key=lambda t: t["date"], reverse=True)

        total_debit = sum(float(t["amount"]) for t in all_txns if t["amount"] > 0)
        total_credit = sum(abs(float(t["amount"])) for t in all_txns if t["amount"] < 0)

        lines = [
            f"💳 Transactions: {start} → {end} ({len(all_txns)} transactions)\n"
            f"Total spent: ${total_debit:,.2f} | Total received: ${total_credit:,.2f}\n"
            f"Net: ${total_credit - total_debit:+,.2f}\n"
        ]

        for t in all_txns[:100]:
            amount = float(t["amount"])
            amount_str = f"+${abs(amount):,.2f}" if amount < 0 else f"-${amount:,.2f}"
            cat_str = " > ".join(t.get("category") or ["Uncategorized"])
            pending = " [PENDING]" if t.get("pending") else ""
            lines.append(
                f"{t['date']}{pending} | {amount_str:>12} | {t.get('merchant_name') or t['name']}\n"
                f"  Category: {cat_str}\n"
                f"  Account: ...{t['account_id'][-4:]}"
            )

        if len(all_txns) > 100:
            lines.append(f"\n... and {len(all_txns) - 100} more transactions.")

        return "\n\n".join(lines)
    except Exception as e:
        return f"Bank transactions error: {e}"


# ── QuickBooks ─────────────────────────────────────────────────────────────────

def _qb_client():
    from quickbooks import QuickBooks
    return QuickBooks(
        client_id=QB_CLIENT_ID,
        client_secret=QB_CLIENT_SECRET,
        access_token=QB_ACCESS_TOKEN,
        refresh_token=QB_REFRESH_TOKEN,
        company_id=QB_REALM_ID,
        minorversion=65,
        sandbox=os.environ.get("QB_SANDBOX", "false").lower() == "true"
    )


def _qb_check():
    if not QB_ACCESS_TOKEN:
        return (
            "QuickBooks not configured.\n"
            "Setup: create app at developer.intuit.com, run setup_quickbooks.py\n"
            "Then add QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REALM_ID, QB_ACCESS_TOKEN, QB_REFRESH_TOKEN to .env"
        )
    return None


def qb_invoices(status=None, days=90):
    """Get QuickBooks invoices. status: 'Open' or 'Paid'. days: look back N days."""
    err = _qb_check()
    if err:
        return err
    try:
        from quickbooks.objects.invoice import Invoice
        qb = _qb_client()

        since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        where = f"TxnDate >= '{since}'"
        invoices = Invoice.filter(Where=where, qb=qb)

        if status:
            if status.lower() == "open":
                invoices = [i for i in invoices if float(i.Balance or 0) > 0]
            elif status.lower() == "paid":
                invoices = [i for i in invoices if float(i.Balance or 0) == 0]

        invoices.sort(key=lambda i: float(i.Balance or 0), reverse=True)

        total_outstanding = sum(float(i.Balance or 0) for i in invoices)
        total_billed = sum(float(i.TotalAmt or 0) for i in invoices)

        lines = [
            f"📋 QuickBooks Invoices — last {days} days ({len(invoices)} invoices)\n"
            f"Total billed: ${total_billed:,.2f} | Outstanding: ${total_outstanding:,.2f} | "
            f"Collected: ${total_billed - total_outstanding:,.2f}\n"
        ]

        for inv in invoices:
            balance = float(inv.Balance or 0)
            total = float(inv.TotalAmt or 0)
            status_str = "✅ PAID" if balance == 0 else f"⚠️ OUTSTANDING ${balance:,.2f}"
            customer = inv.CustomerRef.name if inv.CustomerRef else "Unknown"
            lines.append(
                f"Invoice #{inv.DocNumber} — {status_str}\n"
                f"  Customer: {customer}\n"
                f"  Amount: ${total:,.2f}\n"
                f"  Date: {inv.TxnDate}\n"
                f"  Due: {inv.DueDate or 'N/A'}\n"
                f"  Balance: ${balance:,.2f}\n"
                f"  ID: {inv.Id}"
            )

        return "\n\n".join(lines)
    except Exception as e:
        return f"QuickBooks invoices error: {e}"


def qb_expenses(days=30, category=None):
    """Get QuickBooks expenses (purchases/bills) from the past N days."""
    err = _qb_check()
    if err:
        return err
    try:
        from quickbooks.objects.purchase import Purchase
        qb = _qb_client()

        since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        purchases = Purchase.filter(Where=f"TxnDate >= '{since}'", qb=qb)
        purchases.sort(key=lambda p: float(p.TotalAmt or 0), reverse=True)

        total = sum(float(p.TotalAmt or 0) for p in purchases)

        lines = [
            f"💸 QuickBooks Expenses — last {days} days ({len(purchases)} transactions)\n"
            f"Total: ${total:,.2f}\n"
        ]

        for p in purchases:
            vendor = p.EntityRef.name if p.EntityRef else "Unknown"
            lines.append(
                f"{p.TxnDate} | ${float(p.TotalAmt or 0):,.2f} | {vendor}\n"
                f"  Payment: {p.PaymentType or 'N/A'}\n"
                f"  Account: {p.AccountRef.name if p.AccountRef else 'N/A'}\n"
                f"  ID: {p.Id}"
            )

        return "\n\n".join(lines)
    except Exception as e:
        return f"QuickBooks expenses error: {e}"


def qb_profit_loss(start_date=None, end_date=None):
    """
    Get QuickBooks Profit & Loss report.
    Defaults to current month. Dates: YYYY-MM-DD format.
    """
    err = _qb_check()
    if err:
        return err
    try:
        import requests
        if not start_date:
            start_date = datetime.now().strftime("%Y-%m-01")
        if not end_date:
            end_date = datetime.now().strftime("%Y-%m-%d")

        is_sandbox = os.environ.get("QB_SANDBOX", "false").lower() == "true"
        base = "https://sandbox-quickbooks.api.intuit.com" if is_sandbox else "https://quickbooks.api.intuit.com"
        url = f"{base}/v3/company/{QB_REALM_ID}/reports/ProfitAndLoss"

        headers = {"Authorization": f"Bearer {QB_ACCESS_TOKEN}", "Accept": "application/json"}
        params = {"start_date": start_date, "end_date": end_date, "minorversion": 65}

        res = requests.get(url, headers=headers, params=params, timeout=30)
        res.raise_for_status()
        data = res.json()

        lines = [f"📈 Profit & Loss — {start_date} to {end_date}\n"]

        def parse_rows(rows, indent=0):
            for row in rows:
                if row.get("type") == "Section":
                    header = row.get("Header", {})
                    col_data = header.get("ColData", [])
                    if col_data:
                        lines.append("  " * indent + f"\n{'  ' * indent}── {col_data[0].get('value', '')} ──")
                    sub_rows = row.get("Rows", {}).get("Row", [])
                    parse_rows(sub_rows, indent + 1)
                    summary = row.get("Summary", {})
                    if summary:
                        cols = summary.get("ColData", [])
                        if len(cols) >= 2:
                            val = cols[1].get("value", "0")
                            lines.append("  " * indent + f"TOTAL {cols[0].get('value', '')}: ${float(val or 0):,.2f}")
                elif row.get("type") == "Data":
                    cols = row.get("ColData", [])
                    if len(cols) >= 2:
                        val = cols[1].get("value", "0")
                        lines.append("  " * indent + f"{cols[0].get('value', '')}: ${float(val or 0):,.2f}")

        rows = data.get("Rows", {}).get("Row", [])
        parse_rows(rows)
        return "\n".join(lines)
    except Exception as e:
        return f"QuickBooks P&L error: {e}"


def qb_customers(search=None):
    """List QuickBooks customers, optionally filtered by name search."""
    err = _qb_check()
    if err:
        return err
    try:
        from quickbooks.objects.customer import Customer
        qb = _qb_client()

        if search:
            customers = Customer.filter(Where=f"DisplayName LIKE '%{search}%'", qb=qb)
        else:
            customers = Customer.all(qb=qb)

        lines = [f"👥 QuickBooks Customers ({len(customers)} total)\n"]
        for c in customers[:30]:
            lines.append(
                f"• {c.DisplayName}\n"
                f"  Email: {c.PrimaryEmailAddr.Address if c.PrimaryEmailAddr else 'N/A'}\n"
                f"  Phone: {c.PrimaryPhone.FreeFormNumber if c.PrimaryPhone else 'N/A'}\n"
                f"  Balance: ${float(c.Balance or 0):,.2f}\n"
                f"  ID: {c.Id}"
            )
        return "\n\n".join(lines)
    except Exception as e:
        return f"QuickBooks customers error: {e}"
