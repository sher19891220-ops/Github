# Project: Zone LLC Multi-Entity Fleet Financial Forensic Pipeline

## Context
Multi-entity OTR dry van trucking operation, Columbus, OH.
Entities: Zone LLC (DOT 3456354, ~34 trucks), Xtrack LLC (DOT 4086204, ~45 trucks),
AFG Transportco LLC (~18 trucks), Iron Lease LLC, Truck Max USA LLC,
Shaeffer Technologies LLC (brokerage), RunStar LLC.

## Existing infrastructure — integrate, do not rebuild
OpsAI stack on a Mac Mini M4 (Tailscale IP 100.77.103.37):
- PostgreSQL `aiops` (localhost:5432, user `aiops`) — system of record for operational data
- QuickManage TMS API already connected for Zone/Xtrack/AFG
- Samsara ingest service (`samsara-ingest.js`) feeding `aiops` on a scheduled cadence
- Fleet Board dashboard (`samsara-dashboard.js`, port 8420) reading from that Postgres data
- Green Light/Quantum ELD in use across Xtrack, Zone, AFG
- MCP server at `/Users/sher/opsai-mcp/index.js`

**First job: reconnaissance.** Connect to the Mac Mini, inspect the real `aiops` Postgres schema,
and inspect the QuickManage API's actual endpoints before writing any new ingestion. Report back
what's already there.

## Data sources I will be connecting, in addition to the above
- **QuickBooks** — the real general ledger. If Classes/Locations are set up per entity or per
  truck in QuickBooks, use that instead of re-deriving categories from memos.
- **Fuel reports** (from fuel card provider — Comdata/EFS/etc.)
- **Toll reports** (PrePass/Bestpass or direct toll authority)
- **Insurance**: premiums, registrations, IFTA payments, permits
- **Truck/trailer purchases** and **lease/rent payments** — capex and financing obligations, need
  term/lienholder tracked, not just categorized as a monthly expense
- **Accident/incident costs paid out of pocket**, and **insurance deductibles paid** — tracked per
  unit and per driver, separate from routine maintenance
- **Platform payments** (load boards, broker fees, other platform fees)
- Bank/card statements — see dual-source reconciliation model below; this is NOT a temporary
  stand-in, it runs permanently alongside QuickBooks

## Dual-source reconciliation model — this is the design, not a fallback
Both QuickBooks and raw bank/card statement ingestion run permanently, in parallel:
- **QuickBooks** = the categorized P&L source of truth (GL detail, Classes/Locations per entity/truck)
- **Bank/card statement ingestion** = independent reconciliation layer — every transaction that
  hits a bank/card account should also appear in QuickBooks with matching amount, date (±3 days),
  and category. Build a reconciliation script that flags three things distinctly:
    1. In bank/card but missing from QuickBooks entirely (something never got booked)
    2. In QuickBooks but not matched to a bank/card transaction (booked but cash never moved, or
       booked against the wrong account)
    3. Matched but categorized differently between the two (bank-memo-derived category vs.
       QuickBooks category disagree — worth a look, not necessarily wrong)

Do not treat bank ingestion as a temporary stand-in to be dropped once QuickBooks is connected —
it's a permanent second source, specifically because it can't be miscoded the way a manual GL
entry can. The disagreement between the two sources is itself a bleeding-point signal.

## What already exists in this repo
- `db/schema.sql` — SQLite schema: entities, accounts, units, transactions, maintenance_events,
  plus `incidents`, `assets`, `compliance_costs` for accident payouts/deductibles, capex/lease
  obligations, and registration/IFTA/permit costs respectively
- `ingest/ingest_excel.py`, `ingest/ingest_pdf.py` — bank/card statement parsers
- `taxonomy/categorize.py` — categorization rules covering insurance_deductible,
  accident_incident, insurance_premium, registration, ifta, permits, capex_truck_trailer,
  lease_rent, loan_finance, platform_fees, plus fuel/maintenance/driver_settlement/tolls/
  factoring_fees/subscriptions_saas/intercompany
- `analysis/match_intercompany.py`, `analysis/build_pnl.py`
- `README.md` — read this fully before doing anything else

Read all of this and the README before writing any code. Extend the existing schema and
conventions — don't rebuild from scratch.

## Architecture decision I need you to make and justify
Should `units`/`maintenance_events` read directly from the existing `aiops` Postgres (one source
of truth) or stay separate with a sync job? Look at the real `aiops` schema before deciding.
Same question applies to whether this whole pipeline should migrate from SQLite into `aiops`
Postgres now that QuickBooks, QuickManage, and multiple report sources are all feeding in —
at this data volume and source count, one Postgres database is probably right, but confirm
against the real schema rather than assuming.

## What I need from you right now
1. Confirm Mac Mini / `aiops` access, report the real schema back to me.
2. Confirm QuickManage API access, pull a small real sample, show me before building full ingest.
3. Once I provide QuickBooks API credentials: build `ingest_quickbooks.py` against the QuickBooks
   Online API (OAuth2), pulling GL detail directly — this becomes the categorized P&L source,
   running permanently alongside bank/card ingestion per the reconciliation model above.
4. Build ingest scripts for fuel reports and toll reports once I give you sample exports —
   confirm the exact format each provider gives before assuming a layout.
5. Tell me exactly what format you need for accident/incident records, asset/lease agreements,
   and compliance costs (registration/IFTA/permits) — these need manual entry or a structured
   log from me since they won't come cleanly from bank memos.
6. Build `reconcile_quickbooks_vs_bank.py` implementing the three-way mismatch check above, once
   both sources have real data flowing.
7. Make and justify the architecture decision above.
8. As real data lands: ingest, categorize, and after each batch report — in dollars, not row
   counts — what's uncategorized and the biggest taxonomy gaps. Update `categorize.py` yourself.
9. Once there's real volume: run P&L/intercompany matching and the QuickBooks-vs-bank
   reconciliation, then write a findings memo — top 5 bleeding points ranked by dollar impact,
   with specific transactions/units backing each claim, plus any QuickBooks/bank disagreements
   worth investigating. State what the data shows; flag explicitly what's inference vs. confirmed.

## How I want you to work
- Direct, execution-focused. Skip theory and caveats I didn't ask for.
- Query real systems before assuming their structure.
- Make reasonable calls on ambiguous data, note the assumption, keep moving.
- Flag real data-quality problems plainly.
- End each work session telling me the concrete next input you need from me.
