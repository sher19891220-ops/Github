# Data Contract v1 — Accounting / CEO Ops Dashboard

**Status:** fixed for Phase 2 fan-out. Revised after reading the live Google
Sheets; aiops is out of scope. Three open items in §7 gate Phase 3.
**Authority:** this document + `db/migrations/001_accounting_core.sql`. Where they
disagree, the migration wins — it is the artifact that has actually been executed.
**Verified:** migrations apply clean on PostgreSQL 16; all 45 assertions in
`db/verify/002_contract_assertions.sql` pass. Run `npm run db:verify`.

---

## 1. Where this lives

**The aiops Postgres is out of scope.** It is not read, not written, not joined
to. This build owns a standalone PostgreSQL database, and every table lives in
an `accounting` schema inside it.

Inputs are exactly two:

| Input | Path | Provenance kind |
| --- | --- | --- |
| Google Sheets | read via the Drive connector | `connector` |
| Dropped documents | PDF / XLSX / CSV upload | `document` |

Sheets are read-only sources. Nothing this build does writes back to a sheet:
the operator's spreadsheet stays theirs, and the ledger is derived from it.

Sheet identity (Drive file id and tab) is configured at runtime in
`accounting.sheet_source`, never committed. This repository is public, and a
file id alongside a business name is a targeting aid.

## 2. The provenance model — the load-bearing idea

§8's first criterion ("every P&L figure traces to a source document or connector
pull") is enforced by a database constraint, not by convention. Every
`ledger_entry` declares a `source_kind` and the `provenance_matches_kind` CHECK
requires the matching pointer:

| `source_kind` | Required pointer | Means |
| --- | --- | --- |
| `document` | `source_document_id` | came off a dropped PDF/XLSX/CSV |
| `connector` | `connector_pull_id` | read from a `public.*` table |
| `derived` | `calc_run_id` | computed by the IFTA or permit engine |
| `adjustment` | `reverses_entry_id` | a human correction |

An entry that cannot name its origin **cannot be inserted**. Verified by assertion 1.

Two consequences the Phase 2/3/4 agents must design around:

- **`connector_pull` stores a `jsonb` snapshot of the upstream row, not a foreign
  key to it.** n8n keeps rewriting `public.*`; a pointer would silently change
  meaning after the fact. "Traced to a connector pull" is only true if we can show
  what the pull returned *at posting time*.
- **The ledger is append-only** (trigger-enforced; assertions 3a/3b). A correction
  posts a reversing entry. Nothing is ever `UPDATE`d or `DELETE`d, so a filed
  quarter cannot retroactively change under an auditor.

## 3. Money and identity rules

- Money is `numeric(14,2)`, quantities `numeric(14,4)`, tax rates `numeric(10,5)`.
  **No floating point anywhere in the money path.** Verified by assertion 6.
- `amount` is signed: **positive = inflow, negative = outflow**. `category.sign`
  states the expected direction per category; the P&L engine must not re-derive
  sign from the category name.
- Dimensions are **snapshotted onto the ledger row at post time**
  (`entity_id`, `truck_id`, `driver_id`, `driver_class`). A truck moving from Zone
  to Xtrack, or a driver converting from company to lease-to-own, must not silently
  restate a closed period. `truck_entity_history` and `driver_class_history` are
  what the posting code reads to resolve the correct value for the accrual date.
  **`truck_entity_history` is wired up as of migration 015.** Until then the
  truck → carrier map lived in `source_key_map`, which permits one carrier per
  unit for all time, so a transferred truck's whole year landed on one side of
  the move. `resolveEntityFromTruck(unit, onDate)` now reads the history table
  and refuses a date no period covers, rather than borrowing the neighbouring
  one. `driver_class_history` is still unwired.
- Upstream systems disagree on identity. `source_key_map` is the single crosswalk
  from any `(source_system, source_key)` to a canonical `entity`/`truck`/`driver`.
  Nothing else may join on truck numbers by string match.

---

## 4. Table map

| Group | Tables |
| --- | --- |
| Dimensions | `entity`, `truck`, `driver`, `truck_entity_history`, `driver_class_history`, `source_key_map` |
| Taxonomy | `category` |
| Ingestion (§4.1) | `source_document`, `staging_row` |
| Connector provenance | `connector_pull`, `sheet_source` |
| Ledger | `ledger_entry` (incl. `charged_to`, `unit_type`) |
| Engines (§4.3–4.4) | `calc_run`, `ifta_rate`, `ifta_liability`, `permit_rate`, `permit_cost` |
| P&L (§4.5) | `pnl_period` *(cache — see below)* |
| Prediction (§4.6) | `forecast_run` |
| Reconciliation (§8) | `fuel_reconciliation` |
| Audit | `audit_event` |

`pnl_period` is a **cache, never the source of truth**. It must be fully
rebuildable from `ledger_entry` alone, and Phase 4 must ship that rebuild path.
Materializing every grain × entity × truck × driver × class combination is a
combinatorial trap; the atomic fact table is `ledger_entry` and the cache holds
only what the dashboard actually renders.

`staging_row` keeps `parsed_payload` (immutable, what the parser read) alongside
`reviewed_payload` (the operator's edits). An edited number therefore still traces
to both the document and to what the machine originally extracted — which is the
difference between a correction and a silent estimate.

---

## 5. Where the numbers come from

Established by reading the live sheets, not by assumption. Structures, and the
defects each parser must survive, are in `docs/SOURCE-DISCOVERY.md`.

| Need | Source | Written into |
| --- | --- | --- |
| Revenue | Dispatch Sheet, weekly per truck | `ledger_entry` via `connector` |
| Driver class | Dispatch Sheet `Payment` (CPM/LO/OO) | `driver_class_history` |
| Entity | free text in driver name; entity blocks in the fuel summary | `entity`, `source_key_map` |
| Fuel cost | Fuel sheet | `ledger_entry` via `connector` |
| Fuel gallons by state | **EFS/Relay statements only** | `ledger_entry` via `document` |
| Maintenance cost | Truck and trailer expenses sheet | `ledger_entry` via `connector` |
| Toll | partly the expenses sheet, partly documents | `ledger_entry` |
| Chargeback | expenses sheet `Expense side` | `ledger_entry.charged_to` |
| Truck / trailer | expenses sheet `Unit Type` | `ledger_entry.unit_type` |
| Miles by state | **Samsara IFTA export, dropped per quarter** | `ifta_mileage` document |

Three rules that fall out of the real data:

- **Never resolve identity by string match.** `Issued To` writes the same person
  as `"900101 NAME"`, `"Name # 9002"` and `"Name #900102"`. Everything goes
  through `source_key_map`.
- **A no-load day is decided by the amount cell, never by the lane text.** A day
  with no parseable amount posts no entry — not a zero one, or average revenue
  per truck is silently wrong. But do **not** filter on words like `transit`,
  `OFF` or `TOWING`: measured against the real sheet, 28 day-cells carry one of
  those words *and* a real amount that is part of the truck's Gross total. A
  keyword filter deletes about $49.5k of genuine revenue and breaks
  reconciliation. Presence of an amount is the only reliable signal.
- **Parse sheets by header, never by column index.** Column order is not stable
  across sections of the same tab. `sheet_source.header_checksum` exists so a
  layout change fails loudly instead of reading the wrong column as an amount.

Open loads remain forecast input only, never ledger entries.

## 6. API shapes — what the Phase 2 agents build against

Fixed now so the parser agent and the UI agent can work in parallel (§3).
All money as decimal **strings**, never JSON numbers, to survive the float round-trip.

```
POST   /api/documents                 multipart; -> { documentId, sha256, duplicateOf? }
GET    /api/documents/:id             -> { documentId, docType, parseStatus, parseError, rowCount }
GET    /api/documents/:id/rows        -> { rows: StagingRow[] }
PATCH  /api/staging/:rowId            body: Partial<StagingRowEdit> -> { row: StagingRow }
POST   /api/documents/:id/commit      -> { committed: n, rejected: n, entryIds: string[] }
GET    /api/ledger                    ?entity&truck&driver&from&to&category -> { entries: LedgerEntry[] }
GET    /api/documents                 -> { documents: DocumentSummary[] }
GET    /api/reference                 -> ReferenceData   (picker option lists)
GET    /api/registration/overhead     -> { rates: TruckOverheadRate[] }
GET    /api/reconciliation/:documentId            -> { set, summary }
POST   /api/reconciliation/:documentId/matches/:matchId  -> { set, summary }
GET    /api/chargeback                ?status&entityId&from&to -> { rows: ChargebackRow[] }
POST   /api/chargeback                body { costRowIds, decision } -> { rows: ChargebackRow[] }
GET    /api/pnl                       ?from&to&grain&scope&entityId&truckId -> PnlResponse
GET    /api/ifta                      ?from&to&entityId&mpgDecimalPlaces -> IftaReturnView
POST   /api/ifta                      body { from, to, entityId, savedBy } -> { calcRunId, lineCount, view }
GET    /api/ifta/rates                ?year&quarter -> { year, quarter, rates }
POST   /api/ifta/rates                body { jurisdiction, year, quarter, ratePerGallon,
                                             surchargePerGallon?, sourceNote, enteredBy } -> { rates }
```

```ts
type StagingRow = {
  stagingRowId: string
  documentId: string
  rowIndex: number
  sourcePage: number | null
  parsedPayload: Record<string, unknown>   // immutable
  reviewedPayload: Record<string, unknown> | null
  entityId: string | null
  truckId: string | null
  driverId: string | null
  accrualDate: string | null               // YYYY-MM-DD
  categoryId: string | null
  amount: string | null                    // decimal string, signed
  quantity: string | null
  jurisdiction: string | null              // 2-letter
  status: 'parsed' | 'under_review' | 'committed' | 'rejected'
  reviewNotes: string | null
}

type PnlLine = {
  grain: 'day' | 'week' | 'month' | 'quarter' | 'year'
  periodStart: string; periodEnd: string
  entityId: string | null; truckId: string | null
  driverId: string | null; driverClass: string | null
  categoryGroup: string
  amount: string                           // decimal string
  entryCount: number
}
```

The last three were added after the review screens were built. The first pass
specified what the ingestion *flow* needed and missed what a usable *screen*
needs around it: listing documents, the option lists every picker requires, and
a route serving the overhead rates the engine already computes. The UI
workstream flagged them rather than inventing local shapes, which is the
behaviour the contract-first rule exists to produce.

### §6 amendment — `GET /api/ifta` answers 200 when an input is missing

A period with no mileage report, no fuel, or no rates returns **200** with
`result: null`, a `blocked` sentence saying which input is absent, and
`sourceProblems` naming what to upload or type. It is not a 4xx: the system
is working correctly and waiting on data, and rendering that as "something
went wrong" teaches an accountant to distrust a screen that is being honest.

`400` is reserved for a request with no answer at all — a malformed date, or
a period spanning two calendar quarters, which have different rate tables
and therefore no single return. `POST /api/ifta` uses **422** for its
refusals (an accrual, a group-wide figure, a return short a rate): the
request is well-formed and the state of the data is what forbids it.

`IftaReturnView.problems` arrive in two lists on purpose. `sourceProblems`
are about the *inputs* and every one is fixable by a person. The engine's
`result.problems` are about the *return*. Merging them would hide which
half is actionable.

### §6 amendment — the P&L response is not a flat line list

`GET /api/pnl` was specified above as `{ lines: PnlLine[] }`: one row per
period × dimension × category group. Building it showed that shape cannot
carry three things CLAUDE.md §2 requires to stay visible:

- the **driver-borne receivable** kept apart from company cost, rather than
  netted into it;
- an **allocated** figure marked as allocated rather than measured;
- the **balance-sheet rows stripped out** of the total, with their amount
  still reported somewhere.

Flattened away, a margin looks like a complete answer when it is a lower
bound. So the route returns the rollup engine's own result shapes —
`GroupPnlResult` / `EntityPnlResult` / `TruckPnlResult`, all extending
`PnlBucket` — plus a `workQueue` summary computed over **the same rows in
the same period**, so the totals and the caveats can never describe
different data. `PnlLine` stays in `src/contract/types.ts` for a caller that
genuinely wants a flat table, and no endpoint emits it today.

`from` and `to` are required, and `grain` is optional: omitted gives one
bucket covering the whole range, given it gives a series with every bucket
clamped to the range. A weekly series for a calendar year therefore cannot
reach into the neighbouring years — which it did, and which is why the
clamp exists (see §9.4c).

`StagingRowEdit`, `DocumentSummary`, `ParseStatus`, `NamedOption`,
`CategoryOption` and `ReferenceData` are defined in `src/contract/types.ts`.
`CategoryOption` carries `categoryGroup` and `sign` because a picker needs
both — without them the UI infers direction from a category's name, which is
how a cost eventually renders as revenue.

`POST /commit` is all-or-nothing per document and idempotent: the
`ux_ledger_staging_once` index means a repeated commit cannot double-post
(verified by assertion 4 for the connector path, same mechanism).

---

## 7. Open items

1. ~~**Miles by state has no source.**~~ **Resolved.** The operator's
   telematics produces a per-period IFTA mileage report — carrier, period,
   one block per vehicle with unit number and VIN, `Seq State Miles` rows,
   and the report's own totals by state. `src/ingest/ifta/parseMileage.ts`
   reads it, verified against a real export before its tests were written.

   The document checks itself twice, which is why that parser can be
   strict: each vehicle block states its own total, and the report states a
   grand total by state. The second check is the one that matters — it
   catches a *dropped vehicle block*, which the per-vehicle check cannot
   see, because every surviving block is still internally consistent and
   only the grand total knows somebody is missing.

   **One caveat that belongs with the data.** Every real export seen so far
   carries a **single jurisdiction** — one report all OR, another all NY.
   The format plainly supports more (rows are numbered under a `Seq State
   Miles` heading) but a quarter reporting one state is not a complete IFTA
   return. The parser handles any number of states and reports
   `jurisdictions`, so a caller can tell a single-state extract from a full
   quarter rather than filing the first as if it were the second.
2. **IFTA gallons by state depend on Phase 2.** The Fuel sheet has the purchase
   state (inside a postal address) but records `"full tank"` instead of a
   quantity often enough to be unusable; the fuel summary has real gallons but
   no state. EFS/Relay statements are therefore the authoritative source, which
   makes Phase 3 dependent on Phase 2 rather than parallel to it.

   The engine and its screen do not wait on this. `getIftaReturn` reads
   gallons from posted fuel ledger entries (`quantity` + `jurisdiction`, the
   two columns migration 001 put there for exactly this) and **counts the
   rows that carry neither**, reporting them as a named source problem with
   their dollar value. A purchase with no state earns no credit, so the
   amount owed comes out *too high* — an error in the safe direction, and
   one the screen states rather than absorbing.
4. **A daily or weekly IFTA figure is limited by the mileage source, not the
   engine.** The engine computes any period and labels a non-quarter an
   `accrual`. The mileage report states a period and a total and **no miles
   per day**, so a report is used whole or not at all: one that overlaps the
   requested period only partly is excluded and named. Apportioning a
   quarter's miles across a week would be an invented number wearing a
   measured one's clothes. A genuinely weekly figure needs daily mileage —
   a Samsara/Motive pull or a daily export.
6. ~~**IFTA gallons have no parser.**~~ **Resolved for the document path.**
   `doc_type = 'fuel_card'` parses EFS/Relay/WEX/Comdata statements into
   staging rows carrying gallons and a purchase state, and
   `tests/integration/fuelCard.test.ts` proves the whole path closes:
   dropped, staged, committed, and read back by `getIftaReturn` as tax-paid
   gallons. What remains open is narrower and worth stating exactly: **no
   real statement from the operator's own vendors has been parsed yet** —
   none exists on disk or in their Drive. The parser matches columns by
   meaning rather than position precisely so an unseen layout is a
   diagnosis rather than a failure, but the first real statement may still
   name a column this build does not recognise, and the fix for that is one
   entry in `src/ingest/fuelcard/columns.ts`.
5. **IFTA rates are entered by hand, and that is the design.** Rates are
   published quarterly and no document this build ingests carries them.
   `accounting.ifta_rate` requires `source_note` and `entered_by`, so a
   rate's provenance is a named person naming where they read it — the same
   standard the manual-ledger path holds. A jurisdiction with no rate is
   **withheld from the total and named**, never taxed at zero.
3. **Entity coverage.** Whether `xtrack` and `afg` have their own dispatch and
   expense sheets, or live inside Zone's with entity in free text.

## 8. Application stack

New app at `opsdash/`, not an extension of `driverqual/` — different domain,
different database, and §4's layering requires the calc engine to stay independent
of the qualification app. Stack mirrors the patterns already proven in this repo:
Next.js 15 + TypeScript + zod + vitest + Playwright, with `pg` in place of libSQL.

---

## 9. The domain model the numbers have to obey

Added after the operator supplied a Fleet Accounting Domain Reference — a
synthesis of the group's real bank statements, factoring records, insurance
policies, IRP/HVUT filings and equipment-loan schedules. That document is the
operator's, is not committed here (this repository is public and its benchmark
figures are the group's cost structure), and is authoritative over this file on
questions of how the business works. What follows is only the part the schema
had to change to express. Migration `007_arrangement_factoring_and_rates.sql`.

### 9.1 There are four arrangements, not three

`driver_class` gains **`ltwa`** — lease-to-walk-away: a fixed weekly rate plus
a per-mile charge, and the driver never acquires the truck. It is neither
lease-to-own (no equity accrues) nor owner-operator (the group still holds
title and carries the equipment), and folding it into either misstates both.

Two rules follow, and they bind the P&L engine rather than the schema:

- **The arrangement in effect for the period being priced is what counts.** A
  driver moves from lease-to-purchase to owner-operator; a truck is
  repossessed and re-leased. `driver_class_history` already exists for this;
  nothing may read a truck's *current* class to price a past week.
- **On an owner-operator truck the company's margin is the company charge
  (~11–13% of gross) plus the fuel-discount margin, and nothing else.** Fuel
  and rent sit in the driver's deductions, not the company's cost side. A
  negative driver-pay figure on an owner-operator block is the driver's own
  deductions netting below zero — it is **not** a company loss, and inverting
  that sign is the specific modelling error the reference singles out.

Populations under different arrangements are not comparable on any cost line
the arrangement itself determines. A blended fuel cost-per-mile across mixed
classes is not a number; it is an average of two different things.

### 9.2 Booked gross is not collected cash

Revenue is booked in the week the load ran. Whether the money arrived is a
separate, later, *changing* fact — and the ledger is append-only, so it cannot
be a column. `accounting.collection_event` is an append-only event stream and
`v_collection_current` is the latest event per entry.

The states are `unsubmitted`, `submitted`, `funded`, `paid`, `short_paid`,
`denied`, `recoursed`, `rejected`. **`funded` and `paid` must never be summed.**
Funded means the factor advanced and the debtor has not paid — a different
party carries that risk today. Assertion 27 proves the current-status view
returns the latest state rather than an aggregate.

An entry with no collection event is **unknown**, not paid and not zero. The
view omits it rather than defaulting it.

### 9.3 Every cost has a shape, and the shape drives break-even

`category` gains `cost_shape` (`fixed` / `variable_per_mile` /
`variable_pct_of_gross`) and `cost_basis` (`per_unit`, `per_value`,
`per_gross_dollar`, `per_mile`, `per_enrollee`, `per_period`).

Both are nullable, on the same reasoning that made `unit_type` default to
`unknown`: a category whose shape nobody has established is unknown, and
defaulting it to `fixed` would assert a fact we do not have. Two constraints
stop the pair from becoming decoration — a revenue category cannot carry a cost
shape at all, and a shape and basis that contradict each other (a `fixed` cost
measured `per_mile`) are rejected.

`cost_basis` exists mainly because insurance is priced five different ways
inside one policy set — per scheduled unit, as a percentage of insured value,
as a percentage of gross, per 100 miles, and per enrolled owner-operator per
month. A single blended insurance-per-truck figure gets this backwards for
exactly the trucks it matters most for: the idle ones, which still cost their
liability and physical damage in full.

### 9.4 A stated rate and a measured rate are two facts

`accounting.rate_fact` keeps both, dated and scoped, and neither overwrites the
other. A `stated` rate must name the document stating it; a `measured` rate
must name the calc run that measured it — the same provenance rule as the
ledger, for the same reason. `v_rate_gap` puts the pair side by side and names
the distance.

This is where the registration engine's stated per-unit charge and its actual
per-unit cost both belong, and it is how the flat per-driver admin fee gets
checked against the itemised cost of the services it claims to cover instead of
being assumed to break even.

### 9.4b What kind of account a category is

Migration 009 adds `category.account_nature` — `pnl`, `balance_sheet` or
`intercompany`.

This closes a gap the P&L engine had been papering over. `category` carried a
group and a sign, and neither answers whether a row is an expense or money
moving between an asset and a liability. Two categories that already existed
are not expenses at all: `prepaid.registration` (the IRP/HVUT invoice is
booked once, in full, as a prepaid asset precisely so the real cost reaches
the P&L through twelve monthly recognitions — counting the payment too makes
a truck catastrophically unprofitable for one day and free for the rest of
the year) and loan principal (only interest is a cost; whole payments
overstate by roughly $29.50 per truck per day on this fleet).

Lacking a column, the engine keyed on the category *name* — a regex for the
word "principal". That works until somebody names a genuine expense category
with that word in it, at which point a real cost vanishes from every P&L at
every grain and nothing says why.

**The name rule did not disappear; it moved.** It is now a CHECK on
`category`, applied once when a category is defined rather than to every
ledger row forever: a category id naming a principal repayment, a prepaid
asset, a receivable or a payable cannot declare itself `pnl`. A second CHECK
stops revenue being reclassified off the P&L at all. The engine reads the
flag and nothing else.

`src/db/repo/summaryEntries.ts` is the query that feeds the engine, and it
exists because the general ledger reader does not select what a P&L needs:
`charged_to` (whether a cost is the company's or the driver's),
`allocation_basis`, `unit_type` (whether a trailer repair corrupts a truck's
profitability), the intercompany columns, and the `category` join carrying
`category_group` and `account_nature`. Each omission changes a number rather
than leaving a field blank. It also resolves the split ratio from the
chargeback decision currently standing, because `ledger_entry.charged_to`
records *that* a cost was split and never in what proportion.

### 9.4c A period series covers exactly the days it was asked for

A P&L series was built from whole periods containing the range's ends, so
the first and last bucket could reach outside the range. On clean calendar
months that is invisible. On a ragged range it silently added the days
either side, and an ISO week belongs to whichever year its Monday falls in
— so a weekly series for calendar 2026 actually covered 2025-12-29 through
2027-01-03.

Measured on that bug, for a truck with $5,000 booked 30 Dec 2025, $1,000 in
June 2026 and $7,000 on 2 Jan 2027: **the weekly series summed to $13,000
while the year period reported $1,000.** Both render as "2026 revenue".

`periodsCovering` now clamps every bucket to the requested range. A whole
month stays whole when the range aligns; a partial first or last bucket
reports the days it actually covers, so a screen can see it is partial. The
per-day rate divides by those clamped days. The invariant — the parts sum to
the whole — is a property test across all five grains, not one worked
example at one grain.

### 9.5 Rules with no schema change, recorded so they are not re-derived

- **Negative is money out, positive is money in, everywhere.** A source's
  native convention almost never matches: a card export prints a charge as
  positive and must be negated on ingest; a bank feed's Spent/Received columns
  are unsigned and the column itself is the sign. Wrong once, and every
  downstream total is wrong in a way that looks plausible.
- **Intercompany is neither revenue nor cost.** A transfer between two group
  entities proves a relationship, never a reason. Classify it and stop; only a
  settlement-level record can say whether one side was funding or paying the
  other.
- **A missing filing is not a zero.** The least-documented cost is not the
  cheapest one. An unmeasured cost is null.
- **A repeated debit is not automatically two payments.** An ACH debit can
  bounce, post a same-day return credit for the identical amount, and be
  re-collected days later. The reconciliation matcher must look for the
  intervening reversal before pairing two same-amount debits as two charges.
- **Iron Lease invoices marked paid are frequently settled by netting against
  an intercompany balance, not by a bank deposit.** Reading a lease-rent line
  as a cash outflow overstates the paying company's real cash cost. The
  billing, cash and financing layers are independent.
- **Unpaid loan principal is a real future obligation that appears in no
  operating company's cost model.** It is debt service: it does not pause when
  a truck sits idle and it is in no per-truck or per-mile rate anywhere.
- **Telematics mileage outranks a hand-kept sheet, which outranks derived
  mileage.** Cost-per-mile is linear in miles, so a mileage error moves every
  per-mile figure by the same proportion. Validate the feed before trusting
  anything computed from it.

### 9.6 The largest open gap

**Maintenance is not a line in most of the operating P&Ls at all.** The
reference names it as the single biggest unknown in per-truck economics. The
expenses sheet parser already produces maintenance rows; what is missing is
whether they are complete, and against what. Until that is established, a
per-truck margin figure is a figure with a known hole in it and must say so
rather than rendering as though it were whole.

### 9.7 Registration: two figures, two bases

The reference shows registration at roughly $11 per truck-week on a
**company-responsibility** basis — owner-operator, investor, lease-to-purchase
and sold units are excluded first, because those parties pay their own. The
registration engine in this build produces roughly $46.60 per truck-week on a
**full-allocation** basis: the whole IRP/HVUT invoice divided across the 42
units actually on it.

Neither is wrong. They answer different questions, and they must never be
presented as the same number or reconciled into one. Any screen showing a
registration per-truck figure states its basis on the same line.
