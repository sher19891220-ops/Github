# Setup plan — hand this to the Claude Code session on the Mac Mini

Everything here needs tailnet access to `100.77.103.37`. Run it from Claude Code
Desktop on a machine joined to the tailnet, not from the web/sandboxed version.

Model: Opus 5. Drop to Sonnet 5 for repetitive parser tuning; come back to Opus
for taxonomy design, reconciliation logic and the findings analysis.

Read `CLAUDE.md` first — it holds the conventions that must not be re-derived.

---

## Phase 0 — Reconnaissance (do this before writing anything)

```bash
psql -h 100.77.103.37 -U aiops -d aiops -f db/postgres/000_discover_aiops.sql > recon_aiops.txt
```

Three answers decide the whole design. Report them explicitly:

1. **Real table and column names** for units, maintenance, miles, revenue.
2. **Is there per-unit mileage history?** If no, cost-per-mile and break-even
   miles are unavailable and the analysis degrades to break-even *dollars* —
   much blunter. This is the single highest-value question.
3. **Does QuickManage repair-order COST reach aiops, or only Samsara fault
   codes?** If only fault codes, maintenance cost has to come from card
   statements and per-unit cost is materially less reliable. Say so plainly.

Also confirm the QuickManage API: list the real endpoints, pull one small sample,
show it before building any ingest.

## Phase 1 — Schema

```bash
psql -h 100.77.103.37 -U aiops -d aiops -f db/postgres/001_finance_schema.sql
```

Applied and verified against PostgreSQL 16 — tables, constraints, controls and
idempotency all tested. Safe to re-run.

Then fill in the ops bridge from the Phase 0 answers:

```bash
cp db/postgres/002_ops_views.sql.template db/postgres/002_ops_views.sql
# replace every @@PLACEHOLDER@@ with real names, then:
psql -h 100.77.103.37 -U aiops -d aiops -f db/postgres/002_ops_views.sql
psql -h 100.77.103.37 -U aiops -d aiops -f db/postgres/003_analysis_views.sql
```

The template fails loudly if applied unedited. That is deliberate.

**Do not copy units/maintenance/miles/revenue into `finance`.** They are read
through views. Copying creates drift, and drift means two different answers to
"what did this truck cost" with no way to tell which is right.

Seed the reference data:
- all 7 entities (see `CLAUDE.md` for ids and DOT numbers)
- every bank/card account, with `amount_sign_multiplier = -1` on **every credit
  card** whose export reports charges as positive

## Phase 2 — One month, all entities. Not 36.

Ingest a single month across all seven entities first. One month exposes every
bank format variant, entity-mapping gap and taxonomy hole at a scale where the
output can still be eyeballed. Thirty-six months against an unconverged taxonomy
gives you three years of miscategorized data and no cheap way to find the bad rows.

Before ingesting anything, **check what each bank offers for download**. Pull
CSV or OFX/QFX from the bank portal wherever it exists — most banks give 12–24
months. OFX parses unambiguously; PDF parsing is the hard, error-prone part of
this entire project. Reserve PDF for the older months with no alternative.

For every statement, record its beginning and ending balance in a manifest:

```csv
account_id,period_start,period_end,beginning_balance,ending_balance,source_file
ZONE_CHASE_OP,2026-01-01,2026-01-31,50000.00,49000.00,chase_zone_jan26.csv
```

Then, after every ingest batch:

```bash
python analysis/check_statement_totals.py register --manifest statements.csv --dsn "$AIOPS_DSN"
python analysis/check_statement_totals.py check --strict --dsn "$AIOPS_DSN"
```

**This gate is not optional.** It names the two failure modes that are otherwise
completely silent and self-consistent:
- `double_counted` — the live `ingest_pdf.py` bug (both extraction passes append)
- `sign_inverted` — a card export ingested without negation, booking spend as revenue

Do not run P&L or reconciliation on data that fails this check.

### Fix these before the backfill
All confirmed by running the code, all still present (see `CLAUDE.md`):
1. `ingest_pdf.py` double-insert
2. `match_intercompany.py` ignoring its own `DATE_TOLERANCE_DAYS` (pairs across 199 days)
3. `intercompany` evaluated last in `categorize.py` — move it first
4. `LOVE'S` apostrophe variant
5. `uncategorized_summary()` signed sum → `abs()`
6. per-account card sign convention

Drive uncategorized dollars toward zero, reporting in **dollars, not row counts**:
```sql
SELECT * FROM finance.v_uncategorized_by_entity;
```

## Phase 2b — Google Sheets and odometer

```bash
psql "$AIOPS_DSN" -f db/postgres/004_multi_source.sql
python ingest/ingest_gsheets.py pnl --dsn "$AIOPS_DSN" --csv exports/zone_pnl.csv --entity ZONE
python ingest/ingest_gsheets.py odo --dsn "$AIOPS_DSN" --csv exports/odometer.csv
python analysis/reconcile_all_sources.py derive-bank --dsn "$AIOPS_DSN"
python analysis/reconcile_all_sources.py pnl     --dsn "$AIOPS_DSN" --min-spread 500
python analysis/reconcile_all_sources.py mileage --dsn "$AIOPS_DSN"
```

Both P&L layouts auto-detect: wide (categories down, months across — the usual
hand-built shape) and tidy. Total/subtotal rows are dropped and reported; summing
them back in would double-count the whole sheet.

**Run `mileage` before anything per-mile.** It names odometer anomalies by cause
(`rollback_or_typo` is a correctable transposed digit; `ecu_or_dash_swap` is real
hardware history to clamp, not negative mileage) and excludes both deltas a bad
reading corrupts.

Unmapped Sheets categories are reported in **dollars of sheet value**. Map them in
`source_category_map` — an unmapped line is dollars silently missing from the
comparison, which is worse than a visibly wrong one.

**Google Sheets access:** a Google Cloud service account with the Sheets API
enabled, JSON key at `config/gsheets_service_account.json` (gitignored). Each
spreadsheet must be **shared with that service account's `client_email`** as
Viewer — that is the step people forget, and without it the API 404s on a sheet
that plainly exists. `--csv` needs no auth and is the fastest way to start.

## Phase 3 — QuickBooks

```bash
python ingest/ingest_quickbooks.py --realm <realm_id> --sync-accounts   # ALWAYS first
python ingest/ingest_quickbooks.py --realm <realm_id> --start 2026-01-01 --end 2026-01-31
python analysis/reconcile_quickbooks_vs_bank.py --period 2026-01
```

`--sync-accounts` first, always — without account types the GL sign is a guess.

**Test QuickBooks depth early.** Pull one old month and one recent month and
compare both against bank. If the books were restarted or cleaned up, QuickBooks
is not the source of truth for the older periods and bank becomes primary. Find
this out before committing to a three-year backfill.

## Phase 4 — Backfill 36 months

Only once the taxonomy has converged and the statement control passes clean on a
full month. Re-ingest is safe: uniqueness is `(source_file_hash, file_line_no)`,
so re-running a file updates in place. Cross-file duplicates (a monthly and a
quarterly export overlapping) are flagged, never auto-deleted:

```sql
SELECT * FROM finance.v_suspected_duplicate_transactions;
```

## Phase 5 — Findings

```sql
SELECT * FROM finance.v_bleeding_units;            -- ranked by contribution
SELECT * FROM finance.v_breakeven_by_entity;       -- break-even miles per truck
SELECT * FROM finance.v_unmatched_intercompany;    -- money that never came back
SELECT * FROM finance.reconciliation_results WHERE NOT resolved;
```

`v_bleeding_units` replaces the original `bleeding_flag`, which fired for nearly
every unit because it compared cost against nothing. It ranks by contribution
(revenue minus fully-loaded cost) and flags cost-per-mile more than 25% over the
fleet median, chronic downtime, and — importantly — missing mileage or revenue
data rather than silently scoring those units as healthy.

`downtime_opportunity_cost` is usually larger than the repair invoice and appears
nowhere in a P&L. In validation, a unit with three breakdowns showed $6,333 of
lost revenue against $11,400 of repairs — that ratio is the argument for the
Samsara/QuickManage integration.

Write the findings memo: top 5 bleeding points ranked by dollar impact, specific
transactions and units backing each claim, QuickBooks/bank disagreements worth
investigating, and an explicit split between **confirmed** and **inference**.

---

## Repo and skills

One private repo. Statements, the database, and credentials never enter git —
`.gitignore` enforces this. 36 months of PDFs belongs on the NAS, not in version
control.

Worth building with `skill-creator` once real statements are in hand:
- **one skill per bank/card statement layout** — the best defense against the
  PDF grind; each layout you crack becomes permanent instead of re-derived
- **`/monthly-close`** — ingest → statement control → categorize → reconcile →
  intercompany → P&L → uncategorized report
- **`/findings`** — how you want bleeding points ranked and evidenced

Built-in skills that apply: `pdf` (statements, and OCR for scanned ones), `xlsx`
(Excel statements in, deliverable spreadsheets out), `docx` for the memo.

## Still open

- The `finance`-schema recommendation assumes the ops tables carry mileage and
  repair cost. Phase 0 confirms or refutes it. If mileage is absent, say so
  before building anything that depends on cost-per-mile.
- Fuel and toll ingest need real sample exports and the billing cycle — a
  consolidated weekly draft is one bank line covering hundreds of transactions,
  and reconciliation must match draft-total to detail-sum, not one-to-one.
  See `docs/INPUT_FORMATS.md`.
