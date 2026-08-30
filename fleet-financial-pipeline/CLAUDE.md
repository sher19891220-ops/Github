# Fleet Financial Forensic Pipeline — working context

Multi-entity OTR dry van operation, Columbus OH. This pipeline reconstructs real
P&L per entity and real cost per unit, and finds where money is leaking.

Read `PROMPT.md` for the full brief and `README.md` for the operator workflow.
This file is the set of conventions that must not be re-derived or guessed.

---

## Entities

| entity_id | Legal name | DOT | Notes |
|---|---|---|---|
| `ZONE` | Zone LLC | 3456354 | ~34 trucks |
| `XTRACK` | Xtrack LLC | 4086204 | ~45 trucks |
| `AFG` | AFG Transportco LLC | — | ~18 trucks |
| `IRON_LEASE` | Iron Lease LLC | — | leasing entity — leases units to the operating companies |
| `TRUCKMAX` | Truck Max USA LLC | — | |
| `SHAEFFER` | Shaeffer Technologies LLC | — | brokerage |
| `RUNSTAR` | RunStar LLC | — | |

`IRON_LEASE` leasing to `ZONE`/`XTRACK`/`AFG` is **intercompany**. Those lease
payments are not a group-level expense and must not be counted as one.

## Account naming

`<ENTITY>_<BANK>_<LAST4>` — e.g. `ZONE_CHASE_OP`, `XTRACK_AMEX_4417`.
Never invent a new convention. Every account must exist in `accounts` before
transactions referencing it are ingested.

---

## Sign convention — get this wrong and every downstream number is wrong

**All amount columns are cash-flow signed: negative = money out, positive = money in.**

This is *not* how the sources present it:

| Source | Native convention | What ingest must do |
|---|---|---|
| Bank checking export | debit negative | pass through |
| **Credit card export (AmEx etc.)** | **charge POSITIVE** | **negate** |
| QuickBooks GL report | debit positive / credit negative | pass through bank + credit-card lines, **flip income/expense lines** (`normalize_amount()`) |

Card sign handling is per-account and belongs in `accounts.account_type`, not
hardcoded per file. A card statement ingested without negation books spend as
revenue.

For QuickBooks: run `--sync-accounts` before the first GL pull. Without account
types the sign is a guess, and the ingest warns when it had to guess.

---

## Sources — four, all permanent

| Source | Role | Nature |
|---|---|---|
| Google Sheets | the P&L the business has been deciding on | hand-maintained — an assertion to test, never truth |
| QuickBooks | categorized GL | stated |
| Bank/card | independent cash movement | derived — cannot be miscoded like a manual entry |
| QuickManage / Samsara | odometer, repair orders, revenue | measured |

They all normalize into `pnl_observations` / `odometer_readings` with a `source`
column. **Do not write pairwise reconcilers.** Two sources is one pair; four is
six, and six scripts that disagree with each other is worse than none. One N-way
variance view compares them; a fifth source is a loader, not a reconciler.

`v_pnl_source_variance.outlier_source` names the odd one out when two sources
agree and one does not. Agreement between an independent cash feed and a GL is
hard to achieve by accident, so that column is the strongest signal in the
pipeline.

**Mileage before money.** Cost-per-mile is linear in mileage — a 10% mileage
error moves cost-per-mile 10%, larger than most effects being hunted. Reconcile
odometer readings before trusting any per-mile figure. Source preference:
Samsara (telematics) > QuickManage > Google Sheets (hand-keyed).

A bad odometer reading corrupts **two** deltas — the one into it and the one out
of it. A transposed digit shows as a negative delta, then the correction back to
reality shows as a large positive one that can sit under any plausibility ceiling
and pass silently. Both are excluded (`is_tainted`).

## Taxonomy invariants

1. **`intercompany` is evaluated FIRST**, before every other rule. Entity names
   collide with generic keywords and lose otherwise. Confirmed failures if it
   runs last: `TRANSFER TO IRON LEASE LLC` → `lease_rent` (the entity name
   literally contains "lease"), `ACH XTRACK LLC LOAN REPAYMENT` → `loan_finance`,
   `WIRE TO ZONE LLC INSURANCE REIMB` → `insurance_premium`. A transfer
   miscategorized this way never reaches the intercompany matcher and stays in
   the P&L as a real expense forever.
2. A QuickBooks GL account beats a memo keyword. `categorize()` fills gaps only.
3. Chain names need apostrophe variants — `LOVE'S TRAVEL STOP` must match.
4. **Rules must match plurals.** Accounting and P&L line labels are almost always
   plural, and `\btoll\b` does not match "Tolls". Confirmed misses: `Tolls`,
   `Repairs`, `Permits`, `Settlements`, `Subscriptions` all fall to
   `uncategorized`. There is also no `maintenance` keyword in the maintenance
   rule at all, so `Repairs and Maintenance` — a near-universal P&L line — misses
   entirely.
5. **The taxonomy is expense-only.** There is no `revenue` category, and a P&L
   cannot be built without one. Revenue and owner draws need adding before the
   Sheets P&L can reconcile.
4. When adding rules, drive `uncategorized_dollars_by_entity.csv` toward zero and
   report in **dollars, not row counts**.

---

## Controls that must never be bypassed

**Statement-total reconciliation.** Every ingested statement must satisfy
`sum(transactions) == ending_balance - beginning_balance`, within $0.01.
A statement that fails this is a bad parse — fix the parser, do not ingest.
Run `python analysis/check_statement_totals.py` after every ingest batch.
This is the control that catches double-inserted rows and dropped pages.

**Ingest idempotency.** Uniqueness is `(source_file_hash, file_line_no)`.
Re-ingesting a file updates rows in place. Cross-file duplicates (the same
transaction in both a monthly and a quarterly export) are *flagged for review*,
never auto-deleted — see `v_suspected_duplicate_transactions`.

**Dual-source reconciliation is permanent.** QuickBooks is the categorized P&L
source; bank/card ingestion is an independent cash-movement source that runs
alongside it forever. Bank data cannot be miscoded the way a manual GL entry can.
The disagreement between the two is itself the signal. Never treat bank ingestion
as a temporary stand-in.

---

## Known defects in the original modules — do not reintroduce

These were found by review and are **not yet fixed** in `ingest_excel.py`,
`ingest_pdf.py`, `match_intercompany.py`, `build_pnl.py`:

- `ingest_pdf.py` appends from **both** `extract_tables()` and `extract_text()`
  on the same page with no dedup → every transaction inserted twice.
- `match_intercompany.py` defines `DATE_TOLERANCE_DAYS = 3` and never uses it.
  Verified: it pairs a $25,000 transfer across **199 days**. Also restarts
  `pair_id` at 1 every run, colliding with existing pairs.
- `build_pnl.py` `bleeding_flag = (txn_net < 0) | (breakdown_count >= 4)` fires
  for nearly every unit, because unit-tagged transactions are almost all
  expenses. Needs revenue and miles per unit to mean anything.
- `uncategorized_summary()` sums a **signed** amount, so a −$9,500 unknown debit
  and a +$9,500 unknown credit report as $0.00 uncategorized. Needs `abs()`.
- PDF dates parse without a year (`03/14`) and default to the current year.
- SQLite ships with `PRAGMA foreign_keys` OFF, so every `REFERENCES` in the
  original schema is unenforced. New code turns it on.

---

## Data locations

- Statements: gitignored working directory / NAS. **Never commit statements,
  the database, or API credentials.**
- Credentials: `config/*_credentials.json` or env vars. Gitignored.
- Target database: `aiops` Postgres, `finance` schema (see `db/postgres/`).
  SQLite under `db/` is the pre-migration local version.

## Confirmed vs. assumed

**Confirmed:** the defects listed above (each reproduced by running the code);
the QuickBooks GL sign behavior (tested against a report fixture).

**Assumed, pending recon on the Mac Mini:** everything about the real `aiops`
schema — table names, whether per-unit mileage history exists, whether
QuickManage repair-order *cost* reaches `aiops` or only Samsara fault codes.
The `finance` schema migration depends on these. Do not write the ops views
until the real schema is inspected. State which is which in every report.
