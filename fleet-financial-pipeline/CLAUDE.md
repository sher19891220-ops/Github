# Fleet Financial Forensic Pipeline — working context

Multi-entity OTR dry van operation, Columbus OH. This pipeline reconstructs real
P&L per entity and real cost per unit, and finds where money is leaking.

Read `PROMPT.md` for the full brief and `README.md` for the operator workflow.
This file is the set of conventions that must not be re-derived or guessed.

---

## Start here: find the file before opening any file

**`docs/CATALOG.md` is the index of every source file** -- 400 of them -- with
its entity, the period it covers, how many weeks of it this pipeline can
actually read, and which module reads it. Consult it instead of listing
directories or reopening workbooks to find out what they are. It is generated:

    python3 ingest/catalog.py            # rebuild after any upload
    python3 ingest/catalog.py --check    # what is missing / new vs the committed catalog

Three things it is there to prevent, each of which has already happened:

- **A tab count is not a week count.** The XTRACK workbook with 145 tabs and the
  ZONE one with 139 reach back to 2023, but the weekly panel was laid out
  differently in the earlier years and those tabs parse to nothing. The catalog
  records `weeks readable` per workbook; pick on that, never on tab count.
- **AFG was being read from a ONE-WEEK export** while a twenty-week export sat
  in the same directory. `WORKBOOKS` in `ingest/ingest_weekly_pnl.py` now points
  at the long one, and `tests/test_catalog.py` fails if it drifts back.
- **The same document is filed under two paths.** The catalog keys on content
  hash, so it is counted once and both paths are shown.

**The container is ephemeral and has been reclaimed mid-analysis before**, taking
`data/raw` with it. `data/raw` is gitignored (statements, payroll), so the
catalog is committed and the files are not. After a reclaim, `docs/CATALOG.md`
is the list of what has to be re-uploaded, and `--check` proves when the corpus
is whole again. `.claude/hooks/session-start.sh` runs that check at session
start, so a missing corpus shows up in the first seconds rather than an hour in.

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

### The full recovery chain (confirmed by the owner)

    Truck Max buys parts/labor  ->  invoices ZONE / XTRACK / AFG
      ->  that company deducts the bill from the DRIVER'S SETTLEMENT

So a repair passes through two hands before landing on the driver:

| Leg | Treatment |
|---|---|
| Truck Max's external parts + labor purchase | **the only real group cost** |
| Truck Max invoices the operating company | intercompany — internal transfer |
| Operating company deducts from driver settlement | **recovery** — reduces net driver pay, not a cost |

At group level the repair nets to Truck Max's outside spend. The operating
company is roughly whole (paid the invoice, recovered it from settlement);
Truck Max keeps the margin; the driver bears the invoice.

**The finding is the GAP, not the total.** Every invoice billed but never
recovered from a settlement is unrecovered cost sitting in nobody's P&L.
Reconcile the Truck Max invoice log against `Drivers Pay list (Zone LLC)`
deductions per driver per period; the unmatched remainder is the real leak.
Rows marked `no need to pay` are explicit write-offs and belong in that
remainder.

**Watch the pay type.** Recovery through settlement deduction is normal for
OO and LO operators (47 of 130 drivers). It is not generally available against
company drivers on CPM/%/Flat. Repairs on a CPM driver's truck that were
routed to the driver column may therefore be unrecoverable in practice —
check pay_type before assuming any deduction happened.

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
| BofA statement PDF | **mixed** — older statements print a withdrawal bare (`16,107.20`), newer ones print it signed (`-16,107.20`) | trust the printed sign when there is one; apply the section sign only when there is not. **Never multiply the two** |
| BofA / QuickBooks bank-feed CSV | `Spent` / `Received` columns, unsigned | the column is the sign; `abs()` first |
| Bank checking export | debit negative | pass through |
| **Credit card export (AmEx etc.)** | **charge POSITIVE** | **negate** |
| QuickBooks GL report | debit positive / credit negative | pass through bank + credit-card lines, **flip income/expense lines** (`normalize_amount()`) |

Card sign handling is per-account and belongs in `accounts.account_type`, not
hardcoded per file. A card statement ingested without negation books spend as
revenue.

The BofA row is not a hypothetical. Applying the section sign to an
already-signed amount gives `-1 x -804.38 = +804.38`: a withdrawal recorded as
income, internally consistent, and invisible without the balance control. It
failed 127 of 147 statements until `signed()` in `parse_boa_statement.py`
replaced the multiplication. Any new statement parser must follow the same
rule.

For QuickBooks: run `--sync-accounts` before the first GL pull. Without account
types the sign is a guess, and the ingest warns when it had to guess.

---

## Verified corpus — what the controls have actually proved

| Source | Rows | Control | Status |
|---|---|---|---|
| BofA statement PDFs (147, 7 accounts) | 8,709 | statement total | **147/147 pass, $0.00 unexplained** |
| AmEx card (`AMEX-2006`, 20 exports) | 10,271 unique | card payments vs. bank | **26 of 27 payments matched** |
| QuickBooks bank-feed CSVs (19) | 2,292 | none available | 5 files truncated at the page cap |

Known gaps, named rather than papered over:
- A **second AmEx account** (statements addressed to Cheryl Carter) is drafted
  from Xtrack 5745 and its card export is not in the corpus.
- One `AUTOPAY PAYMENT` of $39,624.31 (2026-08-11) was funded from an account
  whose statements are not in the corpus.
- Repeated `RETRY PYMT` drafts of identical amounts (e.g. $409.98 three times
  in June 2025) are returned-payment cycles, not three separate payments.

---

## Google Sheets P&L — how to read it, and how to get it out

One workbook per operating company, ONE TAB PER WEEK. Each tab holds per-unit
blocks in columns A-O and a weekly summary panel in P-V. The panel is the only
place in the entire corpus where the owner-operator split exists.

**The week is only in the tab name.** No cell carries a date. So the text
rendering of these workbooks — which drops tab names — loses the time axis
completely. Always export `.xlsx` (`ingest_gsheet_pnl.py`); fall back to
`ingest_gsheet_pnl_text.py` only for totals, and never date its output.

**Superseded 2026-09-04: the full `.xlsx` exports DO exist.**
`5f79f0b0-ZONE_Profit__Loss_2024_and_2025_and_2026.xlsx` (139 tabs, 15.6 MB) and
`1efc7de0-Xtrack_LLC_Profit_and_Loss_Weekly.xlsx` (145 tabs) are in the corpus.
The remaining limit is this reader, not Drive: the pre-2026 tabs use a different
panel layout, so of those 139 and 145 tabs only 72 and 26 currently parse. The
text path is still not a substitute. Historical note follows.

**Drive refuses to export a sheet above its size limit.** ZONE (3 years of
weeks, 11.3 MB) and Xtrack (5.8 MB) both exceed it, so only their text
rendering is reachable — and that rendering is INCOMPLETE: for ZONE the panel
`Total gross` sums to $34.1M against $5.8M of unit rows, and the weekly anchor
stops firing partway so the tail collapses into one bucket. **Do not quote
ZONE or Xtrack P&L figures from the text path.** They need a per-year or
per-quarter `.xlsx` export.

**Internal control for this source:** the panel's `Total gross` must equal the
sum of that week's unit rows. AFG passes 20/20 weeks to the penny. Run it on
every new P&L export before using the numbers.

**~82 empty template blocks per tab** are scaffolding for a larger fleet. Drop
them — but an idle truck with zero gross and a negative total is NOT empty; it
is rent and insurance accruing on a truck that did not run.

**Revenue arrives through a factor, not from customers.** Triumph Finance
advances against invoices and keeps a fee, so bank deposits are structurally
below P&L gross. The gap is a real cost line that appears nowhere in the
per-unit P&L — every unit is credited with gross it never fully received.

**P&L driver pay is the GROSS settlement; the bank shows the NET.** The
difference is the deduction pool, and it is the only place the Truck Max
recovery chain becomes measurable.

---

## The dispatch export is the only DAY in the corpus

`data/raw/ops/` is the dispatch system's own database: one row per driver per
day, 7,360 of them across the 13 complete weeks 2026-06-01 .. 2026-08-24, plus
`drivers.csv` (130 drivers with company, truck, pay type and inactive reason),
`weeks.csv`, `hidden_week_periods.csv` and `sub_truck_periods.csv`. Everything
else in the corpus is weekly or monthly, so this is the ONLY source that can say
why miles per truck moved. Read it with `analysis/load_days.py`.

**`entry_type` does not answer "did this truck earn?".** 740 of 4,684 rows typed
`loadday` carry ZERO gross -- 316 of them also carry an idle reason (`home`,
`shop`, `stuck`), the other 424 carry nothing. Trusting the label counts idle
days as revenue days and understates the idle rate by a fifth. Classify on the
money: revenue = `loadday` AND gross > 0; idle = `nonrevenue` OR a zero-gross
`loadday` with a reason; the rest is unexplained and is reported, never assigned.

**Vacation is deleted, not marked.** A driver inside a `hidden_week_periods` span
has no rows at all, so the denominator is days a driver was expected to work and
the idle rate is not inflated by holidays. It also means a truck standing idle
through a 7-week vacation is invisible here while still accruing rent and
insurance -- about 217 driver-days over the period.

**A breakdown often costs no days.** `sub_truck_periods` moves the driver to
another truck and they keep working: driver 107 ran 49 days on a substitute after
a 26 June breakdown and booked two `oos` days. `shop` + `oos` is a FLOOR on
mechanical disruption, not a measure of it.

**Coverage grew while the fleet did not.** In June the export held 37 XTRACK
drivers against 45-51 trucks on the P&L and ran 7.5% below it on gross; by late
August, 45 against 48 and within 0.1%. So the two sources only agree in dollars
from about 2026-07-13, and any trend in a raw weekly count is partly the export
filling up. Use `stable_cohort()` -- drivers present in every week -- for trend.

**Company attribution is a snapshot.** `drivers.csv` has one `mc` per driver and
no history, so a driver who changed authority is attributed to the current one
for every past week.

## Intercompany says the money moved, NOT why it moved

Classifying a transfer `intercompany` is a statement about the counterparty and
nothing else. The bank proves Zone sent Truck Max $625,728; it cannot say
whether that was Zone PAYING repair invoices or Zone FUNDING a shop that does
not cover itself. Those two have opposite meanings and identical bank rows.

Do not let the classification imply the reason. Truck Max was briefly written up
as "net funded, not a drain, +$384,038" on exactly that slip. The memos do not
support it: of 96 inbound transfers, 46 are bare `Online transfer from CHK 0271`,
14 come from account 7024 (no statements), 10 are `ZONE LLC DES:PAYROLL INDN:
TRUCK MAX` — Zone running the shop's payroll — and none reference an invoice.

The rule: an intercompany inflow is evidence of a RELATIONSHIP, never of
revenue earned. Only the settlement deduction lines can close it.

Unverified accounts, no statements behind them: 0007, 0023, 1308, 2835, 3877,
5215, 5557, 6222, 7024, 8344, and the 1008/2006 card.

---

## Iron Lease bills on paper and is funded in cash — they are different events

82 weekly invoices (`data/raw/iron/invoices/`, 2025-08-22 .. 2026-08-21) are the
billing side the bank cannot show. Read with `analysis/iron_lease.py`; parsed by
`ingest/parse_iron_lease_invoices.py`, all 82 reconciling to their printed total
and to Total + Payment = Balance due.

    charged  $808,824  = Truck rental $626,446 + Truck Mileage $182,377
    credited -$271,594 = EFS money codes $97,457 + repairs $174,138
    net      $537,230

**A third of what Iron Lease bills goes straight back as maintenance credits.**
So an invoice Total understates BOTH the lease charge and the repair flow
running the other way, and neither can be read off the bank.

**"Paid in Full" does not mean paid.** Every invoice carries that stamp. Of the
70 dated inside the account-5151 statement window, only 4 have a deposit
matching their total within a dollar and a month — about what coincidence yields
against 58 deposits — while 42 of those 58 deposits are exact multiples of
$1,000 and no invoice total is round. These are settled by NETTING. Iron Lease
rent in an operating company's P&L is a BOOK charge; treating it as cash out
overstates that company's cash cost and hides how much the group funds Iron
Lease by transfer.

**Iron Lease's only real outgoings are trucks.** Of $1,245,155 leaving account
5151: $906,539 of purchases (Fleet Advantage, EquipLinc) and $332,431 of TBK
equipment finance. No payroll (Zone runs it), no insurance, no maintenance.

**Two mileage rates run at once**, $0.10 and $0.12, sometimes as two lines on
one invoice — they are different truck groups, not a rate change. A single
blended rate is wrong for every company.

**Parse traps** (each already produced a wrong number, each tested):
the minus sign is U+2212 not a hyphen; ten invoices sign the CREDIT on the rate
(`1 −$77.73 −$77.73`) rather than the qty, and a rate pattern with no sign drops
the whole line silently; one invoice prints its item number alone on a line;
`AFG 07.31.26` has qty and rate swapped at source (the Amount is right, so the
total still ties and only a per-mile figure goes wrong).

**Credits lag the work.** EFS credits come back in a median 9 days, repair
credits 11 with a 75th percentile of 31 and a maximum of 177. 22 credits worth
$20,449 were taken more than 60 days after the repair.

## Fuel runs on TWO rails, and they changed hands mid-2026

EFS/WEX carried all diesel through March 2026. Relay Payments took over in
April: EFS fell from 136,954 gallons to 20,768 in one month while Relay went
from 444 to 118,093 -- an 85% switch in four weeks. Any fuel figure that reads
only one rail is wrong for 2026. Both reconcile to the bank (Relay's rail
itemization lands within $7,400 of the bank drafts across five months).

Operator-confirmed facts that the sheets alone would misread:
- Truck **8091 was sold to Judeler, broke down, and was replaced free of charge
  with 8132**. The truck-number change mid-series in the lease-to-own register
  is that swap, not a data-entry error -- and Iron Lease absorbed the cost of
  the failed unit.
- The **Ritchie Bros purchase was a lifter for the shop, not a tractor.** An
  auction house sells whatever is on the block, so its invoices are not
  automatically fleet capex; this one is `capex_shop_equipment` and must not be
  amortised across trucks.

---

## Lease-to-own: read the register's flags correctly

In the Iron Lease "Overall" register the **Start date** and **PU mileage**
columns sometimes hold `rented` or `sold` instead of a date. Those describe the
DRIVER's standing on that truck, not Iron Lease's:

    sold    = the driver finished paying and took title
              (Alphonse Jefferson, unit 4851, $65,000 of $65,000)
    rented  = the lease-to-own contract is still running

They do NOT mean Iron Lease rents the truck in. Reading them that way produced
the false claim that the group sells drivers trucks it does not own. **The bank
refutes it outright**: account 5151 pays no rent at all -- $900,415 of truck
purchases and $332,431 of TBK equipment finance, and zero `lease_rent`. Iron
Lease owns its fleet. The group's $6.77M of external rent is paid from Zone's
operating account for the OPERATING fleet, which is a different set of trucks.

Iron Lease is funded by the group rather than by its own billing: of $1,264,229
in, $698,660 is intercompany and $514,295 internal transfer. Third-party revenue
is $8,100. Its lease-to-own collections never appear as deposits because they
are settlement deductions -- invisible in its bank account by design.

## ADP is ONE payroll rail for at least five companies

580 drafts, $24,842,566, debited against Zone (447), Xtrack (87), Truck Max (29)
and AFG (15). So "what left the bank for drivers" cannot be separated from
office staff, mechanics or another entity's payroll, and any settlement-deduction
test run against the ADP total is confounded. Both Zone and Xtrack show MORE
leaving via ADP than their P&L books as gross settlement, which looks like
negative deductions and is really just other people's wages.

Only the ADP payroll register split by employee, or the settlement detail with
its deduction lines, can close the recovery question.

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
Run `python analysis/check_statement_totals.py` after every ingest batch, or
`check-csv --txns ... --meta ...` to gate a parse before it reaches a database.
This is the control that catches double-inserted rows and dropped pages.
**Status: 147/147 BofA statements reconcile to the penny across 7 accounts.**

**Statement identity is the full path, never the basename.** BofA names every
statement `eStmt_<period-end>.pdf`, so seven accounts share ~60 filenames. A
basename join silently pools every account's transactions into one and assigns
one account's period and last-4 to another's statement.

**Sources with no balance pair are stamped `control: none`, never mixed in
silently.** The QuickBooks bank-feed CSVs and the AmEx exports carry no
beginning/ending balance and cannot be self-verified. Where a cross-source
control exists, use it: card payments appear on both the card and the verified
bank statements (`analysis/reconcile_card_payments.py`).

**A QuickBooks CSV export of exactly 300 rows hit the UI page cap.** It is a
truncated view of the account, not the account. Summing it produces a number
that looks like a total and is not one. Five files in the corpus are truncated;
they must be re-exported before any total that includes them is quoted.

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
