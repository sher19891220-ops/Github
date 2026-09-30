# Fleet Financial Forensic Pipeline — working context

Multi-entity OTR dry van operation, Columbus OH. This pipeline reconstructs real
P&L per entity and real cost per unit, and finds where money is leaking.

Read `PROMPT.md` for the full brief and `README.md` for the operator workflow.
This file is the set of conventions that must not be re-derived or guessed.

**`docs/FINDINGS.md` holds the detailed, dated narrative** -- every topic's
deep dive, bug found, and number derived, with the reasoning behind it. It is
NOT auto-loaded every session (this file is); read it when a number needs
justifying, a parsing trap needs recalling in full, or before re-deriving
something that may already be found. `analysis/facts.py --find <term>` is
still the fastest path to a settled NUMBER; `docs/FINDINGS.md` is where the
WHY behind it lives.

---

## Current state -- handoff, updated 2026-09-30 (read first)

What was in flight when the last working session crashed, so the operator
never has to re-explain it. Update this block at the end of any session
that changes it; move settled items into their topic sections below.

- **weekly_pnl backfill: DONE.** ZONE (+08-24, 08-31, 09-07, 09-14) and
  XTRACK (+08-31, 09-07, 09-14) now run through 2026-09-14, matching AFG.
  Built with `analysis/build_weekly_pnl_rollup.py`, which reproduced an
  existing doc byte-for-byte before it was used on the new weeks. AFG and
  prior weeks untouched.
- **Known drift, not fixed on purpose:** the ZONE/XTRACK 2026-08-24 docs no
  longer exactly match the live Google Sheet for at least one truck (small
  dollar difference). Most likely the sheet was edited after sync. Re-pull
  only if the operator says the sheet is now the truth.
- **Next week to land: 2026-09-21.** No tab in either workbook as of
  2026-09-29. AFG's real Motive IFTA/permit for that week is already in
  `state_tax_by_unit/AFG_2026-09-21` (1365 $0.05/$0, 1596 $148.71/$39.05,
  3773 $253.08/$18.71, 495804 $168.02/$7.32; gross-only, no Relay fuel
  credit for AFG). It posts to the P&L once `weekly_pnl/AFG_2026-09-21`
  exists. 13 ZONE/XTRACK units from that Motive pull are still unresolved
  for that exact week.
- **Hourly routine** "Process weekly P&L uploads" (trigger
  `trig_011nrATEDddiMMCyJC5AeXVZ`, :45 every hour): healthy, last run
  succeeded 2026-09-30 02:46Z. Its DispatchHQ substitute-truck fallback
  has never run because `DISPATCHHQ_BOARD_KEY` was unset. Operator added it
  to the environment 2026-09-30; it only reaches sessions started after
  that. **First thing to verify in a new session:**
  `python3 ingest/pull_dispatchhq.py --board --tables`, then
  `--board --pull sub_truck_periods`.
- **DispatchHQ access paths:** `--board` is the only one that works.
  `--rest` (Supabase PostgREST) and the direct Postgres pooler path are
  unused; the proxy can't carry raw Postgres, so the pooler path never
  works from this cloud environment. Candidates for removal.
- **Separate issue, not yet looked at:** the "Founder Hub Daily Logistics
  Post" routine failed 2026-09-29 15:18Z after 7 seconds.

---

## Google Sheets API key -- overridden by operator, 2026-09-28

**Superseded below.** The 2026-09-21 "OFF LIMITS" directive was explicitly
overridden by the operator on 2026-09-28, in-session, after Drive's connector
proved unable to refresh ZONE's stale P&L source: the full `.xlsx` export
still fails ("File too large for export") at 11.6 MB, and the CSV/text export
that does succeed drops the tab name entirely -- confirmed live by decoding
one such export, which came back as an empty template block with no date or
week identifiable anywhere in it. `ingest/pull_sheets.py` and
`GSHEETS_SERVICE_ACCOUNT` are therefore back in play for this pipeline.

**This override removes the POLICY block only, not the technical one.**
`GSHEETS_SERVICE_ACCOUNT` is still unset in this container and
`config/gsheets_service_account.json` still does not exist here
(`python3 ingest/pull_sheets.py --whoami` confirmed both, 2026-09-28) -- so
nothing has actually been pulled via the Sheets API yet. The six-step setup in
`pull_sheets.py`'s docstring (create a GCP service account, enable Drive +
Sheets APIs, download the JSON key, base64 it into the remote environment's
`GSHEETS_SERVICE_ACCOUNT` variable, share each P&L sheet with the service
account's email as Viewer) still needs the operator -- a Claude session cannot
create Google Cloud credentials or share a Sheet on the operator's behalf.

The original directive text is kept below for context; treat it as historical
until the operator says otherwise again.

**`ingest/pull_sheets.py` and `GSHEETS_SERVICE_ACCOUNT` were OFF LIMITS.** The
operator did not want this pipeline (or any Claude session working in it)
pulling data from Google Sheets via that service-account key, in any
circumstance, until they said otherwise. This was independent of whether the
key still worked or the corpus was stale -- it was a standing instruction, not
a technical constraint, and was not to be re-derived or second-guessed session
to session.

**Chosen refresh path: Claude's own Google Drive connector.** When a workbook
needs refreshing, use the `mcp__Google_Drive__*` tools available in the
session (part of the operator's Claude subscription -- no separate API key,
no service-account credential to manage) to locate and read the current
export, rather than `ingest/pull_sheets.py`. This still exports/reads the
same `.xlsx` files this pipeline already parses; only the credential path
changes. If that connector is not available in a given session (not every
environment has it wired up), fall back to asking the operator to upload the
file directly -- never fall back to the service-account key.
The section below is kept for history/context only -- it describes a path
that exists in the code but must not be used.

## Connect to Google Sheets directly instead of exporting by hand

`ingest/pull_sheets.py`. **IT EXPORTS .xlsx, IT DOES NOT READ CELLS** -- the
week is only in the tab name, so this fetches each sheet as a real .xlsx via
Drive's export endpoint and writes it to the path the pipeline already reads.
Nothing downstream changes; the parser cache invalidates itself because the
file's mtime moved. Full sheet-ID table and onboarding history: `docs/FINDINGS.md`.

**THE KEY LIVES IN AN ENVIRONMENT VARIABLE, NOT ON DISK.** This container is
ephemeral and has been reclaimed mid-analysis before, taking everything untracked
with it. `GSHEETS_SERVICE_ACCOUNT`, set on the remote environment, survives every
restart and is never written to disk here. A file at
`config/gsheets_service_account.json` still works as a local fallback, and the
environment variable wins over it -- a stale file from an older setup must not
silently take precedence. Base64 and JSON-escaped forms are both accepted;
**no error message may ever contain key material** -- the only thing ever
printed is `client_email`, which is not a secret.

Setup is six steps in `pull_sheets.py`'s docstring and only the owner can do it.
Then `python3 ingest/pull_sheets.py --whoami` proves the key loads and says
which sheets it can actually see, before anything is downloaded.

## Start here: ASK before analysing

**`python3 analysis/facts.py --find <term>` answers a settled question in 40
milliseconds.** 154 established numbers -- every company's fixed and variable
cost, overhead, break-even at five rates, insurance by policy, the Oregon
exposure, the factoring risk -- each with its unit and the module that produced
it. Rebuild with `--build` (20 seconds warm, about a minute cold).

**WHERE THE TIME ACTUALLY WENT, MEASURED.** Answering from a module that already
exists takes 23 seconds. But eight questions in one session produced 3,605 lines
of Python, 20 test modules and a 4m40 suite run after nearly every change. The
cost of a question was never the reading — it was that each one BUILT something.

So the default is now: **look it up; build only when the answer needs a control**
— a figure that must reconcile to something, a parse that can silently return
nothing, a comparison that will be rerun as documents arrive. Those earn their
code. "What is XTRACK's fixed cost per truck" does not; it is already computed.

**RUN ONLY THE TEST FILE THAT CHANGED, NOT THE FULL SUITE, WHILE ITERATING.**
The full suite is ~278 tests and ~4 minutes; run it once, right before a
commit, as the final check. While actively editing one module, run only its
own test file (`pytest tests/test_whatever.py`) — seconds, not minutes — and
save the full run for the end. Confirmed 2026-09-07: three full-suite runs in
one session cost almost 12 minutes of wall-clock time that a handful of
targeted runs would have covered in a fraction of it. This mirrors the facts.py
lesson above exactly: most of what felt slow was never the thinking.

**A DERIVED OUTPUT THAT CARRIES A TIMESTAMP IS NOT CORPUS DRIFT.** `facts.json`
changes content hash on every rebuild, so catalogued as a source it reported one
MISSING plus one NEW every session. A control that always fires is a control
nobody reads — and the drift report exists precisely so a genuinely missing
document is noticed after a container reclaim. It is indexed, and excluded from
`--check` (`SELF_REGENERATING` in `ingest/catalog.py`).

**STALENESS IS THE ONLY THING THAT MAKES A FACTS FILE DANGEROUS.** It caches
CONCLUSIONS, and a conclusion outliving its evidence is exactly what this
pipeline exists to catch. Every build records the fingerprint of the documents
behind it; `--stale` compares that against the corpus now; the session-start hook
reports it in the first seconds. A stale fact is reported, never served quietly.

**Three layers, and only the third touches a document:**

| | what it is | cost |
|---|---|---|
| `CLAUDE.md` | this file — every established finding, loaded automatically each session | free |
| `docs/CATALOG.md` + `facts.json` | the index of 659 documents, and 154 answers | ~0.04s |
| the parsers | run only for a number not yet established, or one being re-checked | 23s warm |

**RE-CHECK A CHALLENGED NUMBER AT THE SOURCE ANYWAY.** Several times in this
project that has found a real error — the `Insur/Admin/Trl` rename, the
double-counted overhead, `$359.47` read as `$0.35`. A number served from a cache
of conclusions is only as good as the day it was computed.

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

## Why runs were slow, and the cache that fixed it

`ingest/cache.py`. Every parser here re-read its source documents on every call,
and the sources are slow:

    load_ifta()                177 PDFs, text layer          126.0s
    parse_oregon.load()        23 scans, OCR at 200 dpi       94.5s
    fleet_registry.registry()  a 1,413-row workbook           22.5s
    one P&L workbook            27 tabs of openpyxl            9.3s

`cost_structure.py` touches all of them; the test suite touches them from a dozen
modules. **A cold run was ~5 minutes and the suite 14; they are now 38 seconds
and 4m40.** None of that work was different the second time.

    python3 ingest/cache.py            # what is cached, and how big
    python3 ingest/cache.py --clear    # throw it away
    FLEET_NO_CACHE=1 python3 ...       # bypass without deleting anything

**INVALIDATION IS THE WHOLE DESIGN.** A cache that answers with stale numbers is
worse than none — this pipeline exists to be right, not fast. The key is built
from the INPUT FILES: path, size, mtime. Re-upload after a container reclaim and
all three change; add a return to a directory and the file list changes. **There
is no "remember to clear the cache" step**, because a step like that is forgotten
exactly once and then believed for a week. `VERSION` in the module is the one
invalidation a fingerprint cannot infer — bump it when a parser's output SHAPE
changes, since that is invisible in the input files.

**JSON, never pickle.** The payloads are dicts of numbers and strings, and a
cache directory that cannot execute code on load is one less thing to reason
about in a repo full of financial records. `data/cache/` is gitignored: it is
derived data and rebuilds itself.

**Where the remaining time goes:** the OCR and the PDF text extraction, on a cold
corpus. That is unavoidable the first time a document is seen and free every time
after.

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

**Solved 2026-09-28: `ingest/pull_sheets_tabs.py` reads individual tabs and
never hits the export limit at all.** The whole-file export ceiling below is a
Google-side limit on `files.export` -- it fires identically whether the
caller is the Drive connector or this project's own Sheets service account
(confirmed live: both returned `exportSizeLimitExceeded` on the same ZONE/
XTRACK files the same day the service account was set up). No credential
fixes that. What does: `spreadsheets.values.get`, scoped to ONE tab at a
time, never renders the rest of the spreadsheet, so the ceiling never
applies. `pull_sheets_tabs.py` lists a sheet's tabs, keeps the ones after the
latest week already in the local workbook (plus that latest week itself, in
case it was still being edited), and fetches each one directly --
`valueRenderOption=UNFORMATTED_VALUE`, the same computed numbers
`data_only=True` already reads out of a full export, never a formula string.

**It never re-opens the existing `.xlsx` in write mode.** That file holds
real Excel formulas with cached values, and openpyxl drops a formula's cached
value on a load/save round trip (it does not recompute) -- re-saving the
existing file in place would silently zero every OLD week's numbers the next
time anything reads it with `data_only=True`, which is how every consumer in
this pipeline reads it. Instead it reads every existing tab as already-computed
values and rebuilds a fresh workbook from those values plus the newly-fetched
tabs, all as plain values, no formulas anywhere, written atomically. Verified
by round-tripping ZONE's real file this way with zero fetches at all and
confirming `read_workbook()` parsed it identically before and after (0 diffs,
26 weeks) before ever pointing it at the real spreadsheet.

    python3 ingest/pull_sheets_tabs.py ZONE_3YR    # or XTRACK
    python3 ingest/pull_sheets_tabs.py XTRACK --check   # report only

**Run its own control before trusting a fetch.** It reports `check_weekly_pnl()`
on exactly the weeks it just touched -- not "everything new since last time",
the CUTOFF week specifically, since that is the one most likely to have been
mid-edit at the last fetch. A current-week tab that is on the sheet but not
yet filled in by the office reads as `panel=0 units=0`, which is not a
mismatch, just an empty tab -- expect it on the newest tab and do not treat it
as a parse failure.

**Superseded 2026-09-04 (see above): the full `.xlsx` exports DO exist.**
`5f79f0b0-ZONE_Profit__Loss_2024_and_2025_and_2026.xlsx` (139 tabs, 15.6 MB) and
`1efc7de0-Xtrack_LLC_Profit_and_Loss_Weekly.xlsx` (145 tabs) are in the corpus,
but both stall at 2026-08-24 -- a full re-export was never going to reach the
current week even when it worked; only the per-tab reader above does. The
remaining limit on THESE two static files is this reader, not Drive: their
pre-2026 tabs use a different panel layout, so of those 139 and 145 tabs only
72 and 26 currently parse. Historical note on the export ceiling itself follows.

**Drive refuses to export a sheet above its size limit.** ZONE (3 years of
weeks, 11.3 MB) and Xtrack (5.8 MB) both exceed it, so only their text
rendering is reachable — and that rendering is INCOMPLETE: for ZONE the panel
`Total gross` sums to $34.1M against $5.8M of unit rows, and the weekly anchor
stops firing partway so the tail collapses into one bucket. **Do not quote
ZONE or Xtrack P&L figures from the text path.** Use `pull_sheets_tabs.py`
above instead of a per-year/per-quarter manual export.

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

## Sources — four, all permanent

| Source | Role | Nature |
|---|---|---|
| Google Sheets | the P&L the business has been deciding on | hand-maintained — an assertion to test, never truth |
| QuickBooks | categorized GL | stated |
| Bank/card | independent cash movement | derived — cannot be miscoded like a manual entry |
| QuickManage / Samsara | trip mileage + revenue (QuickManage, confirmed 2026-09-07); odometer and repair orders NOT found on QuickManage's `/x` API -- see "QuickManage has trips and trucks, NOT odometer or repair orders" | measured |

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
Samsara (telematics) > QuickManage > Google Sheets (hand-keyed). QuickManage's
contribution here is trip-level `distance`/`deadhead` summed per truck-week,
not an odometer reading -- confirmed no odometer field exists on either its
truck or trip records.

A bad odometer reading corrupts **two** deltas — the one into it and the one out
of it. A transposed digit shows as a negative delta, then the correction back to
reality shows as a large positive one that can sit under any plausibility ceiling
and pass silently. Both are excluded (`is_tainted`).

---

## DispatchHQ — LIVE via its board API, 2026-09-28, NOT a Samsara replacement

**Operator instruction: this must never replace the Samsara CSV-upload path**
for non-Motive trucks. Whatever DispatchHQ holds, mileage-by-state for IFTA
still comes from Motive (live) or a real Samsara export (uploaded) -- never
from this source.

**Working access, confirmed live 2026-09-28: `--board` mode.**
`https://dispatchhq-opal.vercel.app/api/board-data`, a DispatchHQ-authored
HTTPS proxy in front of Supabase, auth'd with a single `X-API-Key` header
(`DISPATCHHQ_BOARD_KEY`, env var first then `board_api_key` in the gitignored
credentials file -- see `ingest/pull_dispatchhq.py`'s BOARD API MODE
docstring). Real schema, from sampling live data (row counts as of
2026-09-28; expect them to grow):

| table | rows | columns |
|---|--:|---|
| `weeks` | 18 | `id` (=`monday`, e.g. `"2026-06-15"`), `monday`, `month`, `quarter`, `year`, `range_label`, `created_at` |
| `drivers` | 145 | `id`, `name`, `dispatcher`, `truck` (unit #), `mc` (e.g. `"ZONE OH LLC"`, `"Xtrack LLC"` -- matches this file's entity names), `pay_type` (`CPM`/`LO`/`%`/...), `config` (Solo/Team), `driver_status` (active/inactive), `note`, `created_at`, `inactive_reason`, `inactive_date`, `inactive_note`, `comeback_date` |
| `load_entries` | 10,469 | `id`, `week_id` (FK `weeks.id`), `driver_id` (FK `drivers.id`), `day_index`, `entry_type` (`"loadday"`), `pickup_city`, `pickup_gross`, `pickup_miles`, `delivery_city`, `nr_reason`, `updated_at`, `note`, `nr_location`, `dispatcher`, `pay_type`, `created_at` |
| `dispatcher_history` | 194 | `id`, `driver_id` (FK), `dispatcher`, `effective_date`, `created_at` |
| `sub_truck_periods` | 17 | `id`, `driver_id` (FK), `original_truck`, `sub_truck`, `reason` (e.g. `"Shop / Repair"`, `"Breakdown"`), `note`, `start_date`, `end_date`, `created_at` |
| `hidden_week_periods` | 15 | `id`, `driver_id` (FK), `start_date`, `end_date`, `reason` (e.g. `"Vacation"`, `"FIRED"`), `created_at` |
| `driver_row_order` | 143 | `id`, `week_id` (FK), `driver_id` (FK), `sort_order`, `created_at` -- a 7th table, UI sort order only, not named by the operator up front, no financial content |

**Not yet used for anything** -- this is real, live dispatch/roster data, not
yet wired into any analysis. Plausible value once it is: `sub_truck_periods`
and `hidden_week_periods` could explain gaps `fleet_registry.py` currently
can't (a truck substituted for repair, a driver on vacation/terminated);
`drivers.truck`/`mc` is a live truck-to-company-to-driver mapping; none of it
touches mileage-by-state or IFTA, per the operator instruction above.

    python3 ingest/pull_dispatchhq.py --board --tables
    python3 ingest/pull_dispatchhq.py --board --describe TABLE
    python3 ingest/pull_dispatchhq.py --board --pull TABLE --out FILE.json

**History below, kept for context -- two other paths were tried first and
neither panned out from this environment:**

**Two separate blockers, so far:**
1. **Network.** This is a raw Postgres connection (port 6543 or 5432), not
   HTTPS -- a different allowlist than what already lets Relay/Sheets/Drive
   calls through. `python3 ingest/pull_dispatchhq.py --check-network` proved
   both ports timed out from this environment, 2026-09-28. Only the operator
   can widen network access, in this environment's own settings.
2. **Credential.** `DISPATCHHQ_DATABASE_URL` (a `board_viewer`-scoped pooler
   string) is not set anywhere in this container. Same handling as every
   other credential here: environment variable first, `config/
   dispatchhq_credentials.json` (gitignored) as a local fallback, **never
   pasted into a chat session** -- a service-account key already went through
   this exact mistake once, 2026-09-28, and should not repeat.

**Re-check, 2026-09-28 (later):** `DISPATCHHQ_DATABASE_URL` is now set as an
env var and parses as a `board_viewer` user on
`aws-0-us-east-1.pooler.supabase.com:6543` -- blocker 2 is cleared.
`psycopg2` was not installed in the container (it is in `requirements.txt`
but the setup path doesn't install it); `pip install psycopg2-binary` fixed
that. Blocker 1 still stands: `--check-network` timed out on 6543 and 5432,
and `--whoami` / `--tables` both failed with `timeout expired` against both
pooler IPs. **Still zero rows or schema seen.** The next step is still the
operator's: open network access in the environment settings (raw TCP 6543
to the pooler host, not only an HTTPS domain allowlist).

**Re-check #2, 2026-09-28, after the operator widened network access:**
still `timeout expired` on 6543/5432 across all three pooler IPs. Root
cause is structural, not a setting: this cloud environment's egress proxy
does not carry raw-TCP database connections at all (`/root/.ccr/README.md`,
"Not supported through the proxy: ... raw-TCP databases"). No network
access level fixes it from here. Second, independent defect: the DSN's
username is bare `board_viewer` -- Supabase's pooler needs
`board_viewer.<project-ref>`, so even with a working network it would fail
("Tenant or user not found"). Realistic paths: run `--whoami`/`--tables`
from a machine with direct Postgres egress and commit the output, or
expose the tables read-only over Supabase's HTTPS REST API, which does go
through the proxy.

**HTTPS REST mode added, 2026-09-28 -- built, NOT yet run live.**
`--rest` runs `--check-network` / `--whoami` / `--tables` / `--describe`
through Supabase's PostgREST API on 443, which this environment's proxy
does carry. Needs `DISPATCHHQ_SUPABASE_URL` + `DISPATCHHQ_SUPABASE_KEY`
(neither set yet). It sends only GET/HEAD and refuses service_role /
`sb_secret_` keys before any request. Operator decision still open: issue
a `board_viewer`-role JWT (safer), or grant `anon` SELECT, which exposes
driver PII if DispatchHQ's app ships its anon key to browsers. Also still
unconfirmed: whether the proxy allows `<ref>.supabase.co` (a made-up ref
got 502 at the CONNECT, which can't tell policy apart from a non-existent host).

**A THIRD path, first tried 2026-09-28 -- the Vercel proxy that turned out to
work, but 500'd on its first try.** `https://dispatchhq-opal.vercel.app/api/board-data`
first returned HTTP 500 identically on every table:
`{"error":"Request failed","detail":"TypeError: Failed to parse URL from
undefined/rest/v1/<table>?select=*"}` -- the deployment's own backend
concatenating an unset environment variable (its Supabase project URL) into
a template string. Real connectivity and the API key both worked even then
(proof plain HTTPS is unblocked here; the raw-Postgres failure above really
was protocol-specific). The operator fixed the Vercel deployment's own env
var; a retry the same day returned real rows -- this is now the section's
`--board` mode above. The API key was pasted into a chat session (like the
Sheets key once was) -- worth rotating if that matters for this key.

**`ingest/pull_dispatchhq.py` enforces read-only independently of whatever
access it's granted, in all three modes.** Raw Postgres: `run_query()`
refuses anything that isn't a bare `SELECT`/`WITH`. REST mode:
`rest_request()` refuses every verb but GET/HEAD, and a `service_role` /
`sb_secret_` key is refused before any request. `--board` (the one that
actually works): the API itself exposes no write verb at all, and
`board_request()` never builds anything but a GET. `--whoami` proves a
credential without printing it, in every mode.

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
**Partially resolved 2026-09-07, from outside `aiops` entirely**: QuickManage's
own public `/x` API has no repair-order or odometer endpoint at all (see
"QuickManage has trips and trucks, NOT odometer or repair orders"), so if
`aiops` carries QuickManage repair-order cost, it did not come from this API
surface -- either a different QuickManage surface, or the assumption that
QuickManage is the source at all needs revisiting before the migration is
written.
