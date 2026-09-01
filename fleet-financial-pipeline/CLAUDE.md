# Fleet Financial Forensic Pipeline — working context

Multi-entity OTR dry van operation, Columbus OH. This pipeline reconstructs real
P&L per entity and real cost per unit, and finds where money is leaking.

Read `PROMPT.md` for the full brief and `README.md` for the operator workflow.
This file is the set of conventions that must not be re-derived or guessed.

---

## Entities

| entity_id | Legal name | DOT | Notes |
|---|---|---|---|
| `ZONE` | Zone LLC | 3456354 | ~34 trucks. Also appears as **"ZONE OH LLC"** / "Zone-OH" — same entity, not a separate company. `Zone_statements` and `ZONE_OH_statements` are two ACCOUNTS of this one entity. |
| `XTRACK` | Xtrack LLC | 4086204 | ~45 trucks |
| `AFG` | AFG Transportco LLC | — | ~18 trucks |
| `IRON_LEASE` | Iron Lease LLC | — | leasing entity — leases units to the operating companies |
| `TRUCKMAX` | Truck Max USA LLC | — | the parts/repair **Shop**; files arrive named `Shop_*` |
| `SHAEFFER` | Shaeffer Technologies LLC | — | brokerage |
| `RUNSTAR` | RunStar LLC | — | |

`IRON_LEASE` leasing to `ZONE`/`XTRACK`/`AFG` is **intercompany**. Those lease
payments are not a group-level expense and must not be counted as one.

`TRUCKMAX` (the Shop) **is confirmed to bill out.** Its repair log
(Drive: "Truck Max", owner joshuafleet.zone@) carries one column per payer:

    Date | Truck | Trailer | Invoice number | Issue | Labor | Zone | Iron Lease | Driver | Inv amount | Paid date

Every invoice lands in exactly one of three payer columns, and they are NOT
equivalent:

| Payer column | Treatment |
|---|---|
| **Zone** | intercompany — Zone's real cost, but internal at group level |
| **Iron Lease** | intercompany — same |
| **Driver** | **NOT intercompany.** Billed to an owner/lease operator, i.e. a third party. Revenue to Truck Max, and not a group cost at all if the driver actually pays. |

So group-level maintenance cost is Truck Max's **parts and labor input**, plus
driver-billed work only to the extent it was never recovered. Summing the
operating companies' payments to Truck Max on top of Truck Max's own spend
double-counts every repair.

Some rows carry `no need to pay` in the Zone column — work performed and
written off. Those are real absorbed costs with no offsetting receipt.

The sheet also tracks a **running intercompany receivable** (a block of
`debt … paid $5000` lines, e.g. `$24,721.24 debt 12.04.2025` →
`$721.24 debt 12.12.2025`). That is exactly the undocumented inter-entity
balance PROMPT.md asks to surface — reconcile it against the matched
intercompany transfers rather than trusting either side alone.

**Data quality in this sheet:** `Paid date` is unreliable. Several December 2025
invoices show paid dates of `01/15/2025` (a year behind the invoice — should be
2026), and a run of rows shows `12.12.18`, `12.12.19`, `12.12.20` … which is
spreadsheet auto-fill, not real dates. Do not use `Paid date` for cash timing
without cleaning it; use the bank/card side for when money actually moved.

### Payment rails are itemization, not extra spend
Relay Payments, Comdata and EFS are payment *rails*, not vendors. Their reports
itemize fuel, lumper, detention and roadside charges that later hit the bank as
ONE consolidated draft. The itemization and the draft are the same money:
reconcile them against each other, never sum them. Summing double-counts every
charge that flows through a rail.

The rail is never the category — `RELAY PAYMENTS FUEL PURCHASE` is `fuel`,
`LUMPER FEE CHICAGO` is `lumper_fees`. Categorize the charge, not the pipe.

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

`taxonomy/categorize.py` was rewritten to satisfy these. **Run
`python tests/test_categorize.py` after any edit to it** — rule order is
first-match-wins, so a new rule near the top silently steals matches from every
rule below it. The suite is 59 cases covering exactly the failures observed.

1. **`intercompany` is evaluated FIRST.** Entity names collide with generic
   keywords and lose otherwise: `TRANSFER TO IRON LEASE LLC` went to
   `lease_rent` (the entity name literally contains "lease"), `ACH XTRACK LLC
   LOAN REPAYMENT` to `loan_finance`, `WIRE TO ZONE LLC INSURANCE REIMB` to
   `insurance_premium`. A transfer miscategorized this way never reaches the
   intercompany matcher and stays in the P&L as a real expense forever.
   An entity name **with** a transfer verb is high confidence; an entity name
   alone is medium and lands in `review_flag` rather than being trusted.
2. A QuickBooks GL account beats a memo keyword. `categorize()` fills gaps only.
3. **Patterns must match plurals.** `\btoll\b` does not match "Tolls" — the
   word boundary needs a non-word character after "toll", and "s" is one.
   Accounting labels are almost always plural.
4. **Sign disambiguates revenue from expense.** Money arriving from Triumph is a
   factoring advance; money leaving is a fee. Always pass `amount` to
   `categorize()` — without it a trucking company's whole revenue line books as
   factoring fees. Wording that can only mean income (`Revenue`, `Linehaul`)
   classifies without an amount, because sheet rows and GL names have none.
5. **Specific beats general in rule order.** `ifta` sits above `fuel` so
   "FUEL TAX PAYMENT" is not diesel; `capex_truck_trailer` sits above
   `maintenance` so "TRUCK PURCHASE - PETERBILT 579" is not a repair. Dealer
   brand names alone stay `maintenance` — most dealer charges are service, not
   a truck.
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

**Fixed:** the taxonomy defects (plurals, missing `maintenance` keyword, no
revenue category, `LOVE'S` apostrophe, `\bts?a\b` matching TSA airport charges
as fuel, intercompany ordering, dealer names booking as capex). `ingest_excel.py`
and `ingest_pdf.py` now pass `amount` into the classifier and write
medium-confidence matches to `review_flag`.

**Still open** in `ingest_pdf.py`, `match_intercompany.py`, `build_pnl.py`:

- `ingest_pdf.py` appends from **both** `extract_tables()` and `extract_text()`
  on the same page with no dedup → every transaction inserted twice. The
  statement-total control now catches this as `double_counted`, but the parser
  is still wrong.
- `match_intercompany.py` defines `DATE_TOLERANCE_DAYS = 3` and never uses it.
  Verified: it pairs a $25,000 transfer across **199 days**. Also restarts
  `pair_id` at 1 every run, colliding with existing pairs. (The Postgres schema
  fixes the id collision with a sequence; the date bug is still live.)
- `build_pnl.py` `bleeding_flag = (txn_net < 0) | (breakdown_count >= 4)` fires
  for nearly every unit. Superseded by `finance.v_bleeding_units`, but the
  SQLite path still uses the old rule.
- `uncategorized_summary()` sums a **signed** amount, so a −$9,500 unknown debit
  and a +$9,500 unknown credit report as $0.00 uncategorized. Needs `abs()`.
  (`finance.v_uncategorized_by_entity` does this correctly.)
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
