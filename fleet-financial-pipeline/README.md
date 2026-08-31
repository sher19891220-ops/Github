# Fleet Financial Forensic Pipeline

Tested and working. Built to run either right here in a Claude chat session
(re-upload this folder each time) or, better, inside **Claude Code Desktop**
pointed at this folder as a real repo — so it persists and you just keep
adding statements to it month over month.

## Setup (one time)
```
pip install -r requirements.txt
python db/init_db.py
```

`.gitignore` keeps real statements, the database, and API credentials out of the
repo. Check it before adding anything to `data/raw/` — those are live bank
statements and the repo is not the place for them.

## Monthly workflow
1. Drop new statement files into `data/raw/`
2. Ingest each one:
   ```
   python ingest/ingest_excel.py data/raw/chase_zone_jan26.xlsx ZONE_CHASE_OP ZONE
   python ingest/ingest_pdf.py   data/raw/amex_xtrack_jan26.pdf  XTRACK_AMEX_4417 XTRACK
   ```
   (account_id is your own label — pick a naming convention and stick to it,
   e.g. `<ENTITY>_<BANK>_<LAST4>`)
3. Log maintenance events (from QuickManage repair orders / Samsara fault data)
   directly into the `maintenance_events` table — either write a small ingest
   script for QuickManage's export format once you confirm what it looks like,
   or insert manually while you're validating the pipeline.
4. Run:
   ```
   python analysis/match_intercompany.py
   python analysis/build_pnl.py
   ```
5. Check `data/processed/`:
   - `monthly_pnl_by_entity.csv` — real P&L per entity, intercompany transfers excluded
   - `per_unit_cost_and_downtime.csv` — cost + downtime per truck/trailer, bleeding_flag=True on the ones worth investigating first
   - `uncategorized_dollars_by_entity.csv` — track this toward zero; every dollar here is a gap in the taxonomy

## What needs your input to get sharp
- **`taxonomy/categorize.py`** — the CATEGORY_RULES list is a starting point.
  After the first real statement batch, `uncategorized_dollars_by_entity.csv`
  will show you exactly what's missing. Add those keywords and re-run.
- **`ingest/ingest_pdf.py`** — bank PDF layouts vary. If a bank's statement
  produces zero matched lines, run `page.extract_text()` on one page to see
  the raw layout and adjust `LINE_PATTERN`.
- **`db/schema.sql` → `units` table** — populate this once with your real
  truck/trailer roster (unit_number, entity, in/out service dates) so
  per-unit reporting is complete, not just for units that happen to appear
  in transaction memos.

## New tables added: incidents, assets, compliance_costs
- `incidents` — accidents/crashes, tracks out-of-pocket cost separately from insurance deductible
  paid, per unit and per driver. Feeds a claims-ratio / driver-risk view later.
- `assets` — truck/trailer purchases and lease/rent obligations, with term and lienholder, so
  capex and financing obligations are tracked distinctly from routine cash-out categorization.
- `compliance_costs` — registration, IFTA, permits, tracked per unit/period so these don't get
  buried inside a generic "fees" bucket.

These aren't ingested from bank statements alone — they need either manual entry from your
actual records (insurance claims log, purchase agreements, IFTA filings) or a QuickBooks-based
ingest (see below), since bank memos rarely carry the detail (deductible vs. premium, which
unit an accident involved, lease term length) that these tables need.

## QuickBooks — dual-source reconciliation model (see PROMPT.md for full detail)
QuickBooks is the categorized P&L source of truth once connected — real GL detail, and if
Classes/Locations are set up per entity/truck, use that instead of re-deriving categories from
memos. **Bank/card statement ingestion does NOT get demoted or dropped once QuickBooks is
connected — both run permanently, in parallel.** Bank data can't be miscoded the way a manual GL
entry can, so it's the reconciliation check: every bank/card transaction should match a QuickBooks
entry (amount, date ±3 days, category). Build `reconcile_quickbooks_vs_bank.py` to flag three
mismatch types: (1) in bank but never booked in QuickBooks, (2) booked in QuickBooks but no
matching cash movement, (3) matched but categorized differently between the two sources. Claude
Code should build `ingest_quickbooks.py` against the QuickBooks Online API (OAuth2) pulling GL
detail directly, once credentials are provided.

## Bringing in QuickManage / Samsara / Motive directly
Once you confirm what export/API access you have from those systems, the
better move is a dedicated `ingest_quickmanage.py` / `ingest_samsara.py` that
pulls repair orders and fault codes directly into `maintenance_events` —
far more reliable than reconstructing maintenance history from card
statement memos alone. Bank/card data is best used as the cash-movement
reconciliation layer on top of that, not the primary source for per-truck cost.


## Bulk intake

Point it at a folder of mixed financial files. Archives are expanded, including
nested ones — `.zip` in-process, `.rar` (RAR5) and `.7z` via the 7z binary
(`apt-get install p7zip-full p7zip-rar`):

```
python ingest/bulk_intake.py scan /path/to/upload
```

Every file is fingerprinted on **content**, not extension. A `.csv` can be a bank
statement, a P&L, an odometer log, a fuel report or a toll report, and the
extension says nothing about which — routing on extension silently loads a P&L
into the transactions table. Anything that cannot be identified confidently is
quarantined rather than guessed at.

It reports: what each file is, byte-identical duplicates, statements whose
account could not be read from the filename, entities with no files at all, and
scanned PDFs with no text layer (which need OCR — check the bank portal for a
CSV/OFX download of the same period first).

Output is `data/processed/intake_manifest.csv`. Fill in `period_start`,
`period_end`, `beginning_balance`, `ending_balance` per statement — those four
columns drive the statement-total control, which is what proves the parse was
correct. Without them a bad parse is invisible.

Name files `<ENTITY>_<BANK>_<LAST4>_<period>` and entity/account are inferred
automatically.

## QuickBooks ingestion + reconciliation

```
python ingest/ingest_quickbooks.py --realm <realm_id> --sync-accounts        # once per company file
python ingest/ingest_quickbooks.py --realm <realm_id> --start 2026-01-01 --end 2026-01-31
python analysis/reconcile_quickbooks_vs_bank.py --period 2026-01
```

`ingest_quickbooks.py` pulls the QuickBooks Online **GeneralLedger** report, not
the transaction query API — the report already carries the posted GL account,
Class and Location per line, which is the categorization we want to use instead
of re-deriving it from memos.

**Status: structurally complete, not yet live.** Report parsing, GL-account →
taxonomy mapping, sign normalization and the upsert are implemented and tested
offline against `tests/fixtures/qb_gl_sample.json`. Only the two network calls
need credentials — see `docs/INPUT_FORMATS.md`. Nothing else changes when they land.

Run the parser without credentials any time:
```
python ingest/ingest_quickbooks.py --parse-fixture tests/fixtures/qb_gl_sample.json --realm R1
```

### Sign convention (important)
Both `transactions.amount` and `qb_transactions.amount` are **cash-flow signed:
negative = money out, positive = money in.**

QuickBooks GL reports use debit-positive/credit-negative, which is *not* the same
thing. A $1,240 fuel purchase posts as +1240 to Fuel and −1240 to Chase. Cash left
in both views, so `normalize_amount()` passes bank/credit-card lines through
unchanged and flips income/expense lines. Flipping both would put the bank leg at
+1240 and it would never match the statement. Run `--sync-accounts` before your
first GL pull so account types are known — without them the sign is a guess, and
the ingest warns when it had to guess.

### Reconciliation
`reconcile_quickbooks_vs_bank.py` implements the dual-source model: matches on
amount (±$0.01) and date (±3 days, tunable), one-to-one, preferring the closest
date and breaking ties on memo/vendor overlap. Reports in **dollars per entity**,
not row counts, and writes `data/processed/qb_bank_reconciliation.csv` plus a
durable `reconciliation_results` table.

Matching happens against the *cash-facing view* of each QuickBooks transaction,
not per GL line — a 3-way split purchase is one cash movement, and matching line
by line would report it as three unmatched bank transactions.

Findings you've investigated stay investigated:
```sql
UPDATE reconciliation_results SET resolved=1 WHERE recon_id=<id>;
```
Re-runs carry `resolved` forward, so the report stays short enough to keep reading.

Exercise the whole matching path with no real data:
```
python analysis/reconcile_quickbooks_vs_bank.py --seed-mock --db /tmp/test.db --period 2026-01
```

## What I need from you
`docs/INPUT_FORMATS.md` — exact formats for QuickBooks credentials, fuel exports,
toll exports, and the incident/asset/compliance records that can't come from bank
memos. Collect those and the remaining build steps unblock.
