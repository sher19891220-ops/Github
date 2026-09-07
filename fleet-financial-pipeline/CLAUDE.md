# Fleet Financial Forensic Pipeline — working context

Multi-entity OTR dry van operation, Columbus OH. This pipeline reconstructs real
P&L per entity and real cost per unit, and finds where money is leaking.

Read `PROMPT.md` for the full brief and `README.md` for the operator workflow.
This file is the set of conventions that must not be re-derived or guessed.

---

## Reading an answer aloud

`tools/say.py`, and `.claude/skills/voice` so it can be asked for by name. Piper,
a neural TTS, entirely offline: the text being read is the group's margins,
break-even and what the sheets get wrong, and that does not belong on a cloud
voice API for the sake of a nicer accent.

    python3 tools/say.py --in notes.md --out brief.mp3
    python3 tools/say.py --in notes.md --dry-run       # words only, no audio

**THE SYNTHESISER IS THE EASY HALF.** A listener cannot re-read a sentence, so a
spoken figure has one chance to be right — and this project's text is nothing but
figures. Always `--dry-run` first.

**A RATE IS NOT A PRICE.** `$2.80` is "two dollars eighty"; `$2.928` is "two
point nine two eight dollars". An early version truncated to two decimals and
read `$2.928` a mile as "two dollars ninety-two" — a different rate, spoken with
total confidence. On a 3,000-mile truck `$1.0725` and `$1.07` are eighteen
dollars a week apart.

**SUB-DOLLAR FIGURES BECOME CENTS, KEEPING EVERY PLACE.** `$0.0003` read as "zero
point three cents" is TEN TIMES the truth. Shifting the decimal by stripping
leading zeros destroys exactly the positional information the shift depends on;
it uses `Decimal`.

**A NORMALISER THAT RAISES IS WORSE THAN ONE THAT READS A SYMBOL ALOUD.** The
percent rule fed the digit reader a trailing `%` and it crashed on `int('%')`.

Markdown furniture is stripped — a table border read aloud is a minute of "pipe
dash pipe dash". Tables do not work as audio at all: say the three numbers that
matter and leave the grid on screen. About 150 words a minute, so a full cost
structure is 4–6 minutes.

**The 63 MB voice model lives in `/opt/piper-voices`, outside the repo, and a
container reclaim takes it.** `say.py` then names the install command rather than
failing obscurely.

## Connect to Google Sheets directly instead of exporting by hand

`ingest/pull_sheets.py`. Proven reachable from this container: an unauthenticated
call to `sheets.googleapis.com` returns **HTTP 403** — it reached Google and was
refused for auth, not blocked by the network — and `google-api-python-client`
installs cleanly. All that is missing is a key.

**IT EXPORTS .xlsx, IT DOES NOT READ CELLS.** The whole pipeline depends on one
thing the Sheets API makes awkward: **the week is only in the tab name**. So this
uses Drive's export endpoint to fetch each sheet as a real .xlsx, writes it to
**the path the pipeline already reads**, and stops. Nothing downstream changes,
every parser control still applies, and the parser cache invalidates itself
because the file's mtime moved.

    ZONE_3YR   16kM262ojCO15Oxq0lHES2McFF4E-57L-U3M_6DXUp7I  11.4 MB
    XTRACK     1tntDRbgEEGQi_43MnxcK2SpOrO7nB5qYaMjIKm7cIjs   5.9 MB
    AFG        1ZLkSoZnuWa9ZAqIISvTRt02OOuvo1Dppap4IrRa6Vg4   0.8 MB
    ZONE_OLD   1HI8HQbNQf5caLmd8oKa6yAxHCzl2UyorP7XLho7k52k   6.2 MB  never read

**`OLD Zone LLC Profit and Loss Weekly` has never been in this corpus** — 6.2 MB,
created 2020, last touched 2026-08-31. It is the only candidate for the pre-2026
ZONE history the current workbook's panel layout will not parse.

**READ-ONLY SCOPE, `drive.readonly`.** A service account that can only read
cannot damage the book the business runs on, however wrong the code turns out to
be. `config/gsheets_service_account.json` is gitignored and a test asserts it —
a key committed to history is a real leak, and the file is created by hand later,
so the ignore rule has to already be right.

**ONLY REWRITE WHEN THE SOURCE MOVED.** Drive reports `modifiedTime`; if it is
not newer than the local copy, nothing is downloaded. A pointless rewrite bumps
the mtime, invalidates every cached parse, and costs twenty minutes of OCR and
workbook reading to arrive at the same numbers.

**WRITE THE WORKBOOK ATOMICALLY.** A half-written .xlsx is not a corrupt file
openpyxl rejects loudly — it is a workbook with FEWER TABS, which parses cleanly
and silently drops weeks.

**The Google Drive MCP connector is a different tool for a different job.** It
already sees these sheets with no setup and is the right way to FIND a document
or read a small one; it is the wrong way to move a workbook, because the file
would come back base64-encoded through the conversation.

**THE KEY LIVES IN AN ENVIRONMENT VARIABLE, NOT ON DISK.** This container is
ephemeral and has been reclaimed mid-analysis before, taking everything untracked
with it. `GSHEETS_SERVICE_ACCOUNT`, set on the remote environment, survives every
restart and is never written to disk here. A file at
`config/gsheets_service_account.json` still works as a local fallback, and the
environment variable wins over it — a stale file from an older setup must not
silently take precedence.

**BASE64 IS THE SAFER FORM; BOTH ARE ACCEPTED.** A service account's private key
is one long line containing literal `\n` sequences, and settings boxes variously
strip them, turn them into real newlines, or double-escape them. Each produces an
unreadable-key error from the crypto layer that says nothing about what went
wrong. `read_credentials()` repairs the JSON-escaped form, names the
spaces-for-newlines form as unrecoverable, and catches a truncated or
wrong-file paste by FIELD NAME rather than letting it surface four calls later as
`invalid_grant` from inside an OAuth exchange. Verified against a real RSA key
across six paste manglings.

**NO ERROR MESSAGE MAY CONTAIN KEY MATERIAL** — a stack trace carrying the
private key leaks it into logs, transcripts and terminal scrollback. Tested.
The only thing ever printed is `client_email`, which is the address you share the
sheets with and is not a secret.

Setup is six steps in `pull_sheets.py`'s docstring and only the owner can do it.
Then `python3 ingest/pull_sheets.py --whoami` proves the key loads and says which
sheets it can actually see, before anything is downloaded.

**`$GSHEETS_SERVICE_ACCOUNT` WAS UNSET AGAIN ON 2026-09-07**, in the same
session that added the two entries below, despite a prior session setting it
"on the remote environment" specifically so it would survive a restart. Either
that environment configuration did not carry into this session/container, or
it did not persist as intended. **Re-check with `--whoami` before trusting
that TRUCKMAX or ZONE_MAINT_MASTER will actually refresh** — if the key is
still missing, `pull_sheets.py` exits with setup instructions rather than
failing silently, but nothing downloads until the owner repastes it.

**TWO MORE SHEETS FOUND AND ADDED 2026-09-07, `TRUCKMAX` and
`ZONE_MAINT_MASTER` — BUT THIS TIME VIA THE DRIVE MCP CONNECTOR, NOT
`pull_sheets.py`.** With the key missing, both were fetched once by hand
through the Drive MCP tool (`download_file_content`, base64-decoded to disk)
to stage them and let the pipeline read them today. This is the "wrong way to
move a workbook" the paragraph above already warned about — it works, but it
is a one-time manual bootstrap, not the automatic refresh `pull_sheets.py`
exists to provide. Both entries are wired into `SHEETS` so that the *next*
`pull_sheets.py` run — once the key is restored, and once each sheet's owner
(they are NOT the operator's own account) shares it with the service
account's email — takes over refreshing them for real.

  - **`TRUCKMAX`** (`1EDzqeROS8HQGadKeix3pfdkNk9HgnbOQX7MQDyb_ekM`, owned by
    `joshuafleet.zone@gmail.com`) → `data/raw/truckmax/invoices/gsheet-TruckMax-master.xlsx`.
    Confirmed: its four payer tabs (Company 423 rows, Driver 25, Iron Lease 77,
    Sher Imam 5) are exact row-for-row matches of the four files uploaded
    2026-09-07 — this sheet is where those came from.
    `ingest/parse_truckmax_invoices.py` now reads this single master file when
    it exists (`MASTER`), falling back to the four uploaded files only on a
    machine that has never pulled it.
    **Three tabs in this sheet are still unparsed**: `Sheet1` (551 rows, with
    `Labor` and `Paid date` columns none of the four payer tabs have) and two
    "Copy of" variants (540, 532 rows — smaller, plausibly older snapshots,
    not yet confirmed). `Sheet1` has **73 rows with a date, truck and
    description but no dollar amount at all** — real repair events as recent
    as 2026-07-30 that are not costed anywhere in this pipeline.

  - **`ZONE_MAINT_MASTER`** (`1SCL2Kp_5h2BlMEnItwhBFVapjEyxnnuJKW3q_Z4RDQU`,
    owned by `zonellcacc@gmail.com`) → `data/raw/pnl/gs-ZONE_master_truck_trailer_expenses.xlsx`.
    Confirmed: its `ZONE Truck and Trailer Expenses`, `XTRACK Truck and
    Trailer Expens` and `AFG Truck and trailer exp` tabs are the SAME data as
    the three static `*_Truck_and_Trailer_Expenses_2026.xlsx` files
    `analysis/maintenance_ledger.py` already read — same columns, and running
    $8-13k ahead of the static exports (ZONE $391,706 vs $383,532; XTRACK
    $321,152 vs $308,444). `maintenance_ledger.py`'s `load()` now reads
    `MASTER`'s matching tab first, falling back to the static per-company file
    only if `MASTER` is absent.
    **Switching to the live tab surfaced a real $92.62 bookkeeping error**:
    ZONE unit 15909's Iron Lease reversal on 2026-08-27 was entered as
    `+46.31` instead of `-46.31` (twice 46.31 is 92.62 exactly), so the
    "Iron lease exp' rows net to zero, in pairs" control — a real,
    already-documented check that had simply never fired against the older,
    already-reconciled static snapshot — now does. Reported, not silently
    corrected; `tests/test_truck_maintenance.py`'s control test recognizes
    this failure string by name.
    **This same sheet also has ten tabs nothing here has parsed yet**: `PSZ`
    and `LOVES` (2025-dated, `Invoice number,Amount` and the same
    Work-Order/Unit/Expense-side shape as the known ledgers, respectively),
    `Truck Max USA` and four bare year tabs `Truck and Trailer Expenses
    2022`-`2025` (the 2025 one is already sitting unused at
    `data/raw/pnl/b5ae7b00-Zone_and_Xtrack_Truck_and_Trailer_Expenses_2025.xlsx`
    — 1,717 rows, confirmed identical to the sheet's own 2025 tab, and never
    referenced by any module), `STL exp` (844 rows — STL is not otherwise
    identified in this corpus), and `Penske` (`Inv#,Inv date,Amount,Total` —
    a truck-leasing/rental vendor, not yet cross-checked against
    `truck_breakeven.py`'s outside-lease rate). None of this is invented or
    assumed here — it is catalogued as present and unparsed, pending a
    decision on which of it is worth building a reader for.

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

## Factoring: the only outside record of REVENUE

`ingest/parse_factoring.py` reads Triumph's invoice lists; `analysis/factoring.py`
sets them against the sheets. Three files, **3,190 invoices, $7.7M**, XTRACK in
full for 2026-04-01 .. 2026-08-31 plus credit-denial lists for all three
companies. Until these were read, every gross figure in this pipeline came from
the group's own spreadsheets and nothing outside tested revenue at all.

**$746,917 — 9.7% of factored invoices — is AT RISK**, and every dollar of it
was booked as gross in the week the load ran and the driver was paid on it:

    Paid        2,201   $5,440,361   70.4%
    Funded        660   $1,537,443   19.9%   advanced, NOT settled by the debtor
    Denied        185     $372,303    4.8%   the company collects these itself
    Short Paid    128     $325,819    4.2%
    Recoursed      13      $31,395    0.4%
    Rejected/Held   3      $17,400    0.2%

**`Funded` IS NOT `Paid`.** Funded means Triumph advanced against the invoice;
Paid means the debtor settled it. On a recourse facility that is a different
party carrying the risk today, so they are never added together.

**ONE CUSTOMER IS 92.3% OF ALL CREDIT DENIALS: STL.** 172 invoices at $340,353
to STL GLOBAL LOGISTICS plus 2 at $3,150 to STL TRUCKERS, credit-denied by the
factor across **all three operating companies** and spanning **2025-07-11 to
2026-09-01**. That is a standing credit decision, not a run of late invoices, so
every load hauled for them since is a receivable the group finances itself. The
P&L ALSO carries `STL charges` as an overhead COST ($73,648 ZONE, $32,613
XTRACK, $1,045 AFG in 2026), and the bank shows **$4,759,864 wired to
`BNF:STL TRUCKERS LLC` in 77 payments across 2024-25** and none in 2026. Money
moves both ways with the same name on it; neither side alone gives the position.

**7.2% OF XTRACK'S BOOKED GROSS NEVER WENT THROUGH TRIUMPH** — $7,733,902 in the
sheet against $7,177,629 given to the factor over 21 weeks, a $556,273 gap. Not
automatically an error: freight billed direct never enters this list. It is the
size of the question.

**Read the total, not the week.** The P&L books a load in the week it RAN; the
invoice carries the date it was SUBMITTED. Weekly gaps swing ±34% on timing
alone, so only the period total is a verdict.

**THE LIST HAS NO AMOUNT-RECEIVED COLUMN.** A `Short Paid` row still carries the
FULL invoice value. Read it for STATUS, never as a cash figure.

Three parse traps, each already producing a wrong number:

- **THE TOTAL ROW DOUBLES EVERY FIGURE.** Each sheet ends with a row labelled
  `Totals` carrying the grand total in the amount column. Summing the sheet as
  read gives exactly TWICE the real number and looks right, because it is the
  number the file itself prints. Dropped, then used as a control: the detail must
  sum to it. **4 of 5 sheets tie; the STL file's Xtrack tab is $11,350 SHORT of
  its own printed total**, so rows are missing from it and anything drawn from
  that sheet is a floor.
- **A PLACEHOLDER INVOICE NUMBER IS NOT AN IDENTITY.** Two different invoices are
  both numbered `TBD` — one Rejected at $5,200, one Held at $1,700 — and
  de-duplicating on the number merged them and lost the Held one.
- **THE EXCEPTION LISTS OVERLAP THE FULL LIST**, so a naive concatenation counts
  a short-paid invoice twice. Key on invoice number within the entity.

## Cost structure: overhead, fixed and variable, per company and group

`analysis/cost_structure.py`. Two halves, and the second is the point.

**WHAT THE SHEET CARRIES**, measured line by line. **WHAT THE SHEET DOES NOT
CARRY** — registration, fuel tax and state road taxes have **no column anywhere**
in any of the three P&Ls, and cannot be hiding in overhead either: overhead here
is a residual of the sheet's own gross and net, so a cost the sheet never
recorded is not inside it. Every one is measured from a document filed with a
government, not estimated.

    per company-driver truck            ZONE   XTRACK      AFG
    truck rent, base                   1,166    1,165    1,167
    admin / insurance / trailer          522      459      451
    fixed company overhead               672      505      398
    subtotal, in the sheet             2,360    2,130    2,015
      + IRP plates + HVUT                 31       31       27   <- no column exists
    TRUE FIXED PER TRUCK-WEEK          2,391    2,160    2,043
      per truck-DAY                      342      309      292

    fuel                              0.8163   0.8657   0.8168
    driver pay                        0.8071   0.7922   0.8628
    tolls                             0.0834   0.0793   0.0739
    Iron Lease mileage                0.0225   0.0115   0.0330
    subtotal, in the sheet            1.7169   1.7566   1.7927
      + IFTA fuel tax                 0.0083   0.0070   0.0020   <- no column exists
      + Oregon weight-mile            0.0003       --       --
    TRUE VARIABLE PER LOADED MILE     1.7254   1.7636   1.7948
    variable overhead, % of gross       3.29     4.69     3.60

    overhead per week                 32,914   42,049    7,838
      per truck-week                     938      887      766
      fixed / variable               672/266  505/382  398/368

**HOW EACH FIXED LINE IS DERIVED** (`--explain` prints the arithmetic):

| line | what it is | sample |
|---|---|---|
| truck rent, base | **a weighted average of TWO rents**, not one: Iron Lease units at their RATE CARD base × their share of running truck-weeks, plus everything else at the P&L's measured rent. ZONE 0.20×$823 + 0.80×$1,252. XTRACK 0.108×$778 + 0.892×$1,212. AFG 0.279×$874 + 0.721×$1,280. | 300 / 287 / 68 running CD truck-weeks |
| admin / insurance / trailer | the mean of ONE block column — `Insur/Admin/Trl` / `Pys/Cargo/Admin`. **A ROLLING PER-BLOCK RENAME, NOT A DATE CUT**: the 08-24 tab carries BOTH labels at once, block by block, as each truck's header was edited. It is also barely a measured cost — ZONE has **10 distinct values across 300 truck-weeks** ($394.38 ×118, $534.28 ×114), so it is a standard weekly charge with tiers. Against the policies it is **90–96% insurance at cost**: ZONE $470.75 measured of $521.54 charged, XTRACK $440.17 of $459.33, AFG $374.74 of $450.60. | same |
| fixed company overhead | the residual `gross − net − CD block − OO cost`, split fixed/variable on its own named components, over ALL trucks. ZONE $32,914×71.7%÷35.1. XTRACK $42,049×57.0%÷47.4. AFG $7,838×51.9%÷10.2. | 13 weeks |
| IRP plates + HVUT | the only line not from the P&L. Annual registration attributed by last-carrying company, over the trucks the file covers: $23,995/15/52, $25,494/16/52, $12,820/9/52. | 48 trucks |

The three companies land within **$2** of each other on rent through completely
different mixes — 20%, 11% and 28% Iron Lease — which is a fact about the lease
market, not a rounding.

**GROUP, PER WEEK:** $774,300 gross, 92.7 trucks (62.7 company-driver), overhead
$82,801 = **10.7% of gross**, $893/truck-week. Fixed cost of the company-driver
fleet $141,612/wk; variable $300,692/wk on 171,978 loaded miles.
**$3,143/week — $163,411 a year — is cost the sheets do not carry at all.**

**A MISSING FILING MUST READ AS MISSING, NEVER AS ZERO.** AFG has no Oregon
account; if that became $0.00 it would look like the cheapest company to run
rather than the least documented.

**THE REGISTRATION RATE IS THE COST OF A TRUCK THE FILE COVERS.** It names 48
trucks against a group fleet of 93 (ZONE 15 of 29.8 running, XTRACK 16 of 27.1,
AFG 9 of 5.8), and the bank shows $9,648 of registration debits on no line of it.
**Operator, 2026-09-06: the file is still being completed, and the trucks bought
most recently HAVE NOT BEEN REGISTERED YET.** So the gap is partly a document in
progress and partly a real operational state — not a reconciliation failure. The
rate is a floor and the coverage is printed beside it rather than assumed away.

## Oregon returns that are missing, priced from the IFTA returns that are not

`analysis/oregon_gap.py`. **An IFTA return counts Oregon miles at a 0.00 rate** —
it records the distance and charges nothing, because Oregon taxes it separately.
That makes every IFTA return an independent, operator-filed statement of exactly
how many Oregon miles a fleet owes an Oregon return on. It is the only way to
price an Oregon return that is not in the corpus.

    ZONE   files IFTA in OHIO       -> its Ohio returns carry ZONE's Oregon miles
    XTRACK files IFTA in ILLINOIS   -> Naperville IL; its returns carry XTRACK's
    AFG    files IFTA in Illinois   -> and it ran Oregon too

| | quarter | OR miles per IFTA | OR returns held | miles on them | **gap** | tax |
|---|---|--:|--:|--:|--:|--:|
| XTRACK | 2026Q2 | 4,688 | 0 | 0 | **4,688** | $1,177.63 |
| ZONE | 2025Q4 | 4,062 | 2 | 1,758 | **2,304** | $578.76 |
| AFG | 2026Q2 | 1,364 | 0 | 0 | **1,364** | $342.64 |
| ZONE | 2026Q2 | 436 | 2 | 0 | **436** | $109.52 |
| XTRACK | 2026Q1 | 314 | 0 | 0 | **314** | $78.88 |
| ZONE | 2026Q1 | 2,968 | 3 | 2,970 | −2 | — |

**9,106 Oregon miles across 5 quarters with no return in this corpus, $2,287 of
tax at the measured $0.2512/mile rate.**

**"NO RETURN IN THE CORPUS" IS NOT "NO RETURN FILED."** These are uploads, not a
filing system. What the gap is: miles the group's own IFTA filings say were run
in Oregon, for which no Oregon return has been sent here. Each is worth checking
against the real filings; the dollar figure is what it costs if any turn out to
be genuinely unfiled.

**THE TAX IS A FLOOR.** ZONE's own Ohio Q2 2026 return, filed five days late, was
charged **$957.64 penalty and $151.17 interest on $9,576.44** — better than 11%
on top. Nothing here estimates an Oregon penalty.

**AFG RAN OREGON AND HAS NO OREGON ACCOUNT ON RECORD.** Its own IFTA return
reports 1,364 Oregon miles in 2026 Q2. Registering is the first step, not filing;
a carrier operating Oregon unregistered is a different and larger problem than a
late return. ZONE is account 281618, XTRACK 068825, AFG none found.

**A QUARTER WITH NO OREGON OPERATION IS NOT A GAP.** XTRACK's 2025 returns carry
no OR row at all. Pricing zero miles as a missing return invents an exposure.

**THE QUARTER IS AS FINE AS THIS GETS.** IFTA reports quarterly, Oregon files
monthly, so a missing quarter cannot be split into months from this evidence.
Months are named (ZONE 2025Q4 = December; XTRACK 2026Q2 = April, May, June), never
apportioned.

**THE CONTROL ON THE WHOLE METHOD** is that each return's jurisdiction rows sum
back to its own total miles. ZONE's Ohio returns hit 100.0%; the Illinois Step-3
returns run 86–98%, so rows exist that this reader does not match — which is why
the OR row being *found* is checked explicitly rather than assumed. Two layouts
are matched: Ohio's `OR Diesel 0.00 436 436 …` and Step-3's `OR D 4688 4688 …`.

## Oregon: the one filing that is a SCANNED IMAGE

`ingest/parse_oregon.py`. Oregon does **not** tax diesel through IFTA — it taxes
by **weight-mile** on its own monthly return, which is exactly why ZONE's Ohio
IFTA returns list Oregon miles at a **0.00 rate**. 13 returns read, ZONE-OH
(account 281618) Jul 2025 – Jul 2026 and XTRACK (account 068825) Jul–Aug 2026:
**7,541 Oregon miles, $2,254 of weight-mile tax.** Small, and now measured.

**THESE PDFs HAVE NO TEXT LAYER AT ALL** — one full-page image per page, zero
extractable characters. Every text reader in this pipeline returns nothing on
them and raises nothing. There was no OCR in the container; **tesseract +
poppler are now required** for `data/raw/ifta/oregon/`.

**THE FORM STATES ITS TAX THREE TIMES AND THEY MUST AGREE** — the machine stamp
across the header (`068825 XTRACOS042666067 312.74`), the per-vehicle
`miles x rate` (1,245 × 0.2512 = 312.74), and the box total `TOTAL FROM COLUMN
L`. An OCR error hits one and not the others, so agreement is the control.
11 of 13 tie exactly; the two that do not are continuation sheets that OCR'd
badly, where the row sum UNDERSTATES and the printed box does not — so the box
wins and the reader records which source it used.

**THE INDEPENDENT PROOF:** Oregon miles on these three OCR'd scans total **2,970
for 2026 Q1 against 2,968** on ZONE's Ohio IFTA return — a text PDF filed with a
different state that cannot have been mis-read. Two miles apart.

Three OCR traps, each of which produced a wrong number:

- **OCR MANGLES ZERO WORST OF ALL.** A blank cell comes back as `Lt)`, `is)`,
  `it)`, `ft)` or a bare `)` at least as often as `0`. Since most rows on most of
  these returns ARE zero, a reader that treats an unparseable cell as *missing*
  drops nearly every row and then "ties" against a zero total by accident. Empty
  is zero, and the row count is carried so a return that parsed nothing cannot
  masquerade as a nil return.
- **READ THE COLUMN, NOT THE POSITION.** The column rule survives as a bare `)`
  token: `0.2512) 359 47`. Positional reading took `)` as the tax dollars and
  `359` as the cents and reported **$359.47 as $0.35** — a hundredfold
  understatement that still looked like a plausible small number. Keep only
  tokens containing digits.
- **ANY BRACKET SHAPE ON THE WEIGHT CELL.** `(80000`, `{80000`, `|80000`.
  Requiring one shape dropped XTRACK's only taxable row of July 2026.

**Months not in the corpus:** Dec 2025 and Apr 2026 for ZONE; all of Q1 and Q2
2026 for XTRACK; everything for AFG. Priced in `analysis/oregon_gap.py` above.

## Is the P&L accurate? `analysis/pnl_accuracy.py` — two tiers, one that counts

The sheets are HAND-MAINTAINED, so they are an assertion to be tested. This
module is the test, and it separates two very different kinds of evidence.

**TIER 1, the sheet against itself.** Free, runs on every week, catches typing
and formula damage — and cannot catch a number that is wrong the same way twice,
which is the failure mode of a hand-kept sheet. Passing it proves almost nothing.

| | ZONE | XTRACK | AFG |
|---|---|---|---|
| panel gross == sum of unit rows | PASS 26/26 | **FAIL 10 of 27** | PASS 20/20 |
| net == CD + OO − overhead | $262,151 (3.83%) | $236,149 (2.55%) | $35,830 (2.17%) |
| Other-charges itemisation | PASS | FAIL 1 week | PASS |
| block headers recognised | PASS | PASS | PASS |
| week coverage, truck count | PASS | PASS | PASS |

**XTRACK's panel headline and its truck rows are different numbers in 10 weeks**
between 2026-03-02 and 2026-06-15, netting **−$48,100** (−0.52% of gross), and
the individual gaps are round: −10,099, −9,400, −9,300, −8,025, −8,000, −6,426,
+5,950, +4,000, −4,000, −2,800. ZONE and AFG tie to the dollar every week. The
`Total gross` cell in those XTRACK weeks is not derived from the blocks below it.

**TIER 2, the sheet against a record it did not write.** The strength of each
check is exactly how independent the other record is:

    IFTA returns      FILED WITH A STATE under penalty, by a different person,
                      out of the fuel and mileage systems. The strongest check
                      in the corpus.
    Iron Lease bills  a counterparty's invoice
    insurance         signed with a carrier: the premium is a fact
    bank statements   cannot be miscoded like a manual entry, but NOT
                      line-comparable — factoring, netting and timing sit
                      between the sheet and the statement

**THE MILEAGE TIES, AND THAT IS THE BIG RESULT.** Every cost-per-mile figure in
this pipeline rests on it. 2026 Q2, sheet against the filed return:

| | filed | sheet | gap |
|---|--:|--:|--:|
| ZONE | 1,118,149 | 1,096,973 | −1.9% |
| XTRACK | 1,727,001 | 1,673,084 | −3.1% |
| AFG | 215,151 | 216,486 | **+0.6%** |

**MILES ARE NOT ALL THE SAME MILES.** The sheet keeps odometer miles (all miles,
company drivers only) and loaded miles (every truck, revenue miles only); IFTA
counts EVERY mile of EVERY truck under the authority, owner-operators included.
Compare the return to loaded miles alone and the sheet looks short by the empty
ratio plus the whole owner-operator fleet — 43% of XTRACK's trucks. Scale the
owner-operators' loaded miles by the company drivers' own odometer-to-loaded
ratio (1.047 on XTRACK, 1.049 ZONE, 1.012 AFG) and say so.

**THE FUEL DOES NOT TIE, AND THE TWO RETURNS MISS IN OPPOSITE DIRECTIONS:**

    ZONE     filed 180,944 gal, the sheet's own mpg needs 160,855   +20,089  +11.1%
    XTRACK   filed 197,081 gal, needs 251,334                       -54,253  -27.5%
    AFG      filed  28,083 gal, needs  28,750                          -667   -2.4%  TIES

Two unrelated errors would not point opposite ways in the same quarter. This is
one fuel allocation split the wrong way between two IFTA accounts: it roughly
nets out at group level and leaves each return wrong on its own. **Direction
decides the risk — understating gallons understates the tax owed**, which is the
side an audit collects on, and that is XTRACK.

**JUDGE THE FUEL ON GALLONS, NOT ON THE DERIVED OWNER-OPERATOR MPG.** The
residual (filed gallons less the company drivers' measured burn) divides by a
small number and swings: it called AFG "not a truck" at 10.8 mpg on a return
whose miles tie to 0.6%. Below ~15% owner-operator share the residual is noise.

**A QUARTER THE SHEET ONLY PARTLY COVERS IS SKIPPED, NEVER COMPARED.** ZONE's
and XTRACK's sheets start 2026-02-23 and hold 6 of Q1's 13 weeks; comparing that
to a full-quarter return measures the missing weeks and reads as a 55% error.

**OHIO IS A SECOND FORM, NOT A VARIANT.** ZONE files through OH|TAX eServices,
which prints a summary line (`Diesel 1,509,945 207,885 0 7.26`) and no Step 2
division line at all. `parse_ifta()` returned an EMPTY DICT on those, and an
empty dict is falsy, so they dropped out of `load_ifta()` in silence — the
largest company had no external mileage check for that reason alone. A parser
that returns nothing is worse than one that raises. `load_ifta()` now tries both
forms and prints the files that look like returns and read as nothing.

**THE SAME RETURN IS FILED UNDER SEVERAL PATHS.** ZONE's Ohio returns sit both in
`data/raw/ifta/ohio/` and inside the CT Reports archive, so the list held each
quarter three times and any total built by summing it tripled ZONE's miles. Key
on the facts of the return, the way the catalog keys on content hash.

**IRON LEASE RENT IS UNDER-CHARGED IN ALL THREE SHEETS**, most where trucks sit:
ZONE $119,621 charged against $143,595 due (−16.7%), XTRACK $85,704 / $99,205
(−13.6%), AFG $36,438 / $37,672 (−3.3%).

**THE ORDER OF WHAT EVIDENCE PROVES:** a filing (IFTA, 2290) > a counterparty's
invoice or policy > cash > a measuring device (Samsara, fuel-card gallons) > the
sheet against itself. Still missing to finish the audit: factoring statements,
the ADP register split by employee, and Samsara odometer history.

## Insurance and IFTA — the first documents filed with someone outside

Both arrived 2026-09-05 (`data/raw/insurance`, `data/raw/ifta`). Everything
before them was the group's own sheets; these were signed with a carrier or
filed with a state, so they are the first outside check on figures the sheets
were asserting alone. Register: `config/insurance.json`. Reader:
`ingest/parse_tax_and_insurance.py`.

**XTRACK's own policy covers THREE power units.** $63,722 for 2025-08-07 to
2026-08-07 (auto liability $36,054, cargo $7,513, physical damage $19,430,
GL $500) against 45+ trucks in its own P&L. Everything else runs under
**ZONE-OH's master policy**: $1,087,431.92 a year, 68 scheduled tractors,
$15,992 per unit-year = **$307.53 per unit-week**. That is why 98% of the
group's insurance spend leaves ZONE's account — it is not an allocation
artefact, it is the actual policy.

**Cargo insurance is VARIABLE.** ZONE-OH's motor truck cargo is rated at
**$0.70 per $100 of gross revenue** — $120,750 a year. Spreading it per truck
makes a revenue-linked cost look fixed and moves break-even the wrong way.

**A financed premium is not its face value.** XTRACK's $63,722 is financed at
**14.85% APR** through First Insurance Funding: $9,685.80 down plus 9 x
$6,381.61 = **$67,120.29** of cash, and the $3,398.29 finance charge reaches the
bank as a loan payment, not as insurance — which is part of why the bank's
insurance total runs below the policies.

**THE UNIT-TO-VIN GAP IS CLOSED** (2026-09-05, group unit workbook). Read it
with `ingest/fleet_registry.py`; 67 of the 68 VINs on the master schedule now
resolve to a fleet number and to the company last running that truck. Three
things about that workbook:

  - It is an ASSIGNMENT HISTORY, not a fleet list -- 1,413 rows carrying a VIN,
    358 distinct trucks, one appearing 15 times. Counting rows multiplies the
    fleet fourfold.
  - **244 of the 358 appear in no P&L at all.** They are history. Treating the
    workbook as current triples the fleet.
  - 71 VINs sit on more than one company's sheet, because a truck that moved
    authority stays in both histories. The sheet cannot say who runs it now;
    the P&L can, and dates the answer.
  - The Value column is free text -- numbers, `110K$`, `$60,000/OO`, bare `OO`.
    `OO` marks an owner-operator truck, which carries its own physical damage.

**AUTO LIABILITY, ALLOCATED** (68 units at $307.53/unit-week): ZONE 24 units
$7,381/wk, XTRACK 19 $5,843/wk, AFG 7 $2,153/wk, and **18 on no P&L at all**
$5,536/wk. **21 of the 68 have not run since 2026-07-06 -- $335,825 a year of
premium on trucks that are not moving.**

## Insurance costs what, per company — priced, not allocated

`analysis/insurance_cost.py`. Every line is priced on a DIFFERENT basis, and
using one basis for all of them is the mistake this module exists to prevent:

    per scheduled unit   auto liability $15,992/unit-yr, excess cargo $300/unit-yr,
                         non-trucking liability $35/unit-month
    per dollar of value  physical damage -- 4.50% of Total Insured Value a year
    per dollar of gross  ZONE motor truck cargo -- $0.70 per $100 of revenue
    PER MILE             XTRACK second cargo layer -- $1.43 per 100 miles
    per owner-operator   occupational accident -- $107 a month

So **a truck that stops running still costs its auto liability, its excess cargo
and its physical damage in full**, and stops costing the mileage-rated and
revenue-rated cargo entirely. A single "insurance per truck" number gets the
idle-truck question exactly backwards.

**A BILL BEATS A RATE, AND BOTH REPORTING POLICIES MOVED.** The register now
carries the ACTUAL billing where it exists, and it disagrees with the rate in
BOTH directions, so a rate-only model is wrong either way:

| line | rated | billed | why |
|---|---|---|---|
| auto liability URG-02817 | $1,087,432 | **$644,761** | $442,670.66 came back as six RETURN PREMIUMS as units left the schedule. The ledger closes: $873,587.70 activated − $422,026.34 paid − $442,670.66 returned = $8,890.70. |
| physical damage + NTL | $576,778 | **$598,056** | five invoices Mar-Jul, the schedule GREW |
| occupational accident | — | **$94,840** | five invoices; $7,903/mo at $107 each = **74 enrolled owner-operators**, the count that was missing |

**The face premium is not the cost, and allocating it overstates auto liability
by 69%.** Every figure below is the effective premium.

    ZONE     $685,412/yr   $13,181/wk   $471 per truck-week   28 units
    XTRACK   $549,338/yr   $10,564/wk   $440 per truck-week   24 units
    AFG      $155,891/yr    $2,998/wk   $375 per truck-week    8 units
    carried by nobody      $176,773/yr   $3,399/wk

That last line is the 18 insured units on no company's P&L plus the two the
registry cannot resolve. It is reported, never spread over the companies that do
run, because spreading it hides the cleanup.

**The return premium settles the idle-truck question.** Taking a unit off a
reporting policy DOES return money -- six credits prove it -- so the 21 units
that stopped running are worth removing, not merely worth noting.

XTRACK's $440 per truck-week lands within $32 of the $472 its P&L charges in
`Insur/Admin/Trl`, so that column is very nearly insurance at cost -- closer
than the earlier estimate of $366, which was missing physical damage. That $440
includes XTRACK's OWN $63,722 Benchmark package, which was priced in the register
and missing from the table until 2026-09-05; leaving it out understated XTRACK by
$51 per truck-week.

**AFG's figure is a FLOOR.** Its Progressive premium is not in the table because
it cannot be totalled: the bills show the remaining balance rising $5,113 ->
$42,630 while payments left fall 5 -> 1, which is units being added all term at
a premium far above the $9,383 quote. Recorded as `null`, never as zero.

**Physical damage is a REPORTING policy** (4.50% of TIV, monthly, "subject to
change based upon vehicles covered"), so adding or removing a unit changes the
bill. That is exactly why the 21 units that stopped running keep costing money
until they come off the schedule.

**Three TIV figures are in play** and the policy can only be written on one:
the operator's $12,238,612 at submission, the schedule files' $12,927,748, and
the March questionnaire's $12,260,612.05. A 5.3% spread at a 4.50% rate is about
$31,000 a year.

**OHIO IS WHERE ZONE FILES IFTA**, and its returns are the richest tax source in
the corpus -- full state-by-state miles, gallons and rate. Q1 2026: 1,509,945
miles, 207,885 gallons, **7.26 mpg**, 63 vehicles, $12,145.28. Q2 2026:
1,118,149 miles, 180,944 gallons, **6.18 mpg**, 46 vehicles, $9,576.44 plus
$151.17 interest and **$957.64 penalty** -- filed 5 August against a 31 July due
date. Set beside XTRACK's own returns the two move in OPPOSITE directions in the
same quarter (ZONE 7.26 -> 6.18 while XTRACK 6.89 -> 8.76), which is what a
mileage or gallon split between the two authorities would look like, not what a
fleet does. Ohio itself is a large credit (fuel bought there exceeds fuel burnt
there); Pennsylvania is the largest cost.

**OREGON IS UNFILED, OR ITS RETURNS ARE MISSING.** ZONE's Ohio return reports
2,968 Oregon miles in Q1 2026 and 436 in Q2 at a 0.00 IFTA rate -- Oregon taxes
by weight-mile on a separate return, and no Oregon return is in the corpus.

**PHYSICAL DAMAGE: the exposure is known, the premium is NOT.** The only
physical-damage document is an Intact questionnaire (eff. 2026-03-06) stating
56 power units at $7,889,308 and 104 trailers at $4,371,304, $5,000 deductible,
with the **rate column blank**. The $1,500 + $75 in that file is the
occupational-accident line, not VPD. Until the binder arrives, record
`annual_total: null` and never coerce it to zero.

The schedule actually submitted at renewal is now known (`data/raw/insurance/
pd_renewal/`) and supersedes the questionnaire: **62 power units at $8,578,444
and 104 trailers at $4,349,304**, $12,927,748 total, 94 of the trailers leased.
Split on the submitted units: **ZONE 47.7%, XTRACK 37.9%, AFG 12.9%**, with two
units (1.5%) not resolving to a company.

**AFG IS ON THIS POLICY.** Operator, 2026-09-05: AFG's tractors and dry vans
carry physical damage TWICE -- this group Intact policy and Progressive, AFG's
own insurer. An earlier note here said the group policy covered every unit
except AFG; that was wrong, and 8 AFG units appear on the submitted schedule.

**XTRACK carries TWO cargo coverages**: the cargo inside the Incline package
bound 2026-08-07, and a separate SiriusPoint layer signed 2026-02-24. The second
is a **mileage reporter -- $1.43 per 100 miles, $40,540 estimated on 2,800,000
miles, adjusted annually against actual miles**. It is the only insurance line
in the group priced per mile, so it belongs in cost per mile ($0.0143) and not
in cost per truck.

**The 21 insured units that have not run since 2026-07-06 are a cleanup, not a
misstatement.** Operator: they should not be on the policy, but may have been on
it legitimately for part of the term and simply never removed -- so the question
is a return premium, not an error.

**IFTA IS AN INDEPENDENT MILEAGE AND FUEL RECORD**, and one return does not
survive contact with the equipment. XTRACK's Q2 2026 return divides 1,727,001
miles by 197,081 gallons and states **8.76 mpg**, against 6.89 on its own Q1
return and 6.68 in its own P&L for the same quarter. At 6.68 those miles need
258,574 gallons — **61,493 more than the return shows**. IFTA tax is
`(taxable miles / fleet mpg) - tax-paid gallons`, so an overstated mpg shrinks
the taxable gallons and therefore the tax: that return computed 255 net taxable
gallons. `check_ifta_plausibility()` flags any return outside 5.0-7.6 mpg.

**Fuel and road taxes are about $0.011 a loaded mile** and appear nowhere in the
weekly P&L. XTRACK H1 2026: IFTA $19,163.85, NY HUT $7,632.93, KY $1,923.09,
NM $1,418.14 = $30,138.01 over 2,748,057 miles.

**Do not identify these forms by keyword.** They extract with characters dropped
into the headings ("Accounti ID", "gallotn"), so a literal "IFTA" is present in
some returns and absent in others that are plainly the same form. Match on the
Step 2 division line instead; keyword matching silently threw away four of
seven valid returns.

## Owner-operators: the other half of the fleet, and a different machine

`analysis/owner_operator.py`. The two kinds of truck sit in DIFFERENT BLOCK
LAYOUTS in the same weekly tab, because they are different businesses:

    company driver   Unit | Driver | Gross | Mileage | Driver Salary |
                     Insur/Admin/Trl | DEF/Fuel/Fee | Truck Rental | Toll/Scale |
                     Additional | Subtotal | Other | Total | Per mile | Fuel avr
    owner operator   Unit | Driver | Gross | COMPANY CHARGE | Driver Salary |
                     DEDUCTIONS | Mileage | Truck Rental | Fuel | Toll/Scale |
                     FUEL DISCOUNT | Other | DRIVER PAY | PROFIT | RPM

**THE COMPANY'S PROFIT ON AN OWNER-OPERATOR IS THE COMPANY CHARGE PLUS THE FUEL
DISCOUNT, AND NOTHING ELSE.** Read the sheet's own arithmetic on one block:
gross 4,400 − charge 660 = salary 3,740; less deductions 785 + rent 1,146.60 +
fuel 1,713.96 + toll 350.62 − fuel discount 66.28 + other 65 = **Driver Pay
−254.90**; and **Profit 726.28 = charge 660 + fuel discount 66.28** exactly.

**RENT AND FUEL ARE RECOVERED, NOT BORNE.** They sit in the driver's deductions.
Counting them as company costs — or the negative Driver Pay as a company loss —
inverts the sign of the whole business.

    per OO truck-week                   ZONE   XTRACK      AFG
    gross                              9,835   10,316   10,383
    miles / rate                    3,052@3.22 3,017@3.42 2,915@3.56
    company charge                     1,282    1,238    1,181
      as % of gross                    13.04%   12.00%   11.37%
    fuel discount margin                  63       61       10
    = P&L PROFIT                       1,346    1,299    1,191   (13.7/12.6/11.5%)
    recovered from the driver: rent      825      785    1,110
                              fuel     2,453    2,538    2,492

**WHAT THE BLOCK NEVER CHARGES AN OO TRUCK:** insurance $349/$378/$345 (it is on
the group schedule like any other unit), IRP+HVUT $31/$31/$27, and a share of
company overhead $938/$887/$766. Take those off and the **net is $28 / $3 / $52 a
truck-week.**

**THAT CONCLUSION TURNS ENTIRELY ON ONE ASSUMPTION** — charging an OO truck a
FULL share of overhead. The sheets hold no evidence either way, so it is a range:

    overhead share charged      ZONE   XTRACK      AFG
    100%                          28        3       52
     75%                         262      224      243
     50%                         497      446      435
      0%                         966      890      818

An OO truck uses dispatch and the fuel card but no payroll run, no recruiting
spend, no company insurance on the driver and no idle-truck carry. Splitting the
overhead components by what an OO actually consumes is the measurement that would
settle it; the components are already named in `truck_breakeven.model()['named']`.

**BREAK-EVEN IS ON GROSS, NOT MILES.** The company cannot lose money on a mile it
does not pay for. Gross needed: $9,631 / $10,296 / $9,932 against actual $9,835 /
$10,316 / $10,383 — headroom of **$204 / $20 / $451** a week at a full overhead
charge.

**THE TWO CANNOT BE AVERAGED INTO ONE "COST PER TRUCK."** An OO truck earns the
company less per week and risks it far less: no fuel to fund, no wage to pay, no
idle truck to carry. It is a RISK trade, not a margin one.

## Registration: IRP plates and HVUT — the cost line nothing else carries

`ingest/parse_irp.py` reads the payments, `analysis/registration.py` puts them on
the fleet and tests them against the bank. Source: `data/raw/permits/` (uploaded
2026-09-05), 24 payments over 48 trucks, $82,876.79.

**It appears in no other source.** The weekly P&L has no registration column and
`analysis/truck_breakeven.py` has no registration line, so every per-truck cost
figure in this pipeline was missing **$1,727 a truck a year = $33 a truck-week =
$4.73 a truck-day**. Small next to insurance and the SAME SHAPE: fixed, annual,
prepaid, charged in full on a truck that never turns a wheel.

    ZONE     $23,995/yr   $461/wk   15 trucks   $1,600 per truck-year
    XTRACK   $25,494/yr   $490/wk   16 trucks   $1,593
    AFG      $12,820/yr   $247/wk    9 trucks   $1,424
    on no P&L $6,854 + not in the unit workbook $6,563

**HVUT is flat, IRP is not.** The federal heavy vehicle use tax is $550 a truck
and every one of the six group payments divides by it exactly — which is what
makes the unit lists checkable against the money. IRP is apportioned on miles per
jurisdiction and on weight and runs **$438 to $1,430 a truck (3.3x)**. Never
average an IRP rate across trucks; the spread is real.

**HVUT prorates from the month of first use.** Unit 7584's $458.33 is exactly
10/12 of $550, so that truck went into service in September. A control that tests
only for whole trucks calls a correct proration a bad parse.

**REGISTRATION HAS A NAMED COUNTERPARTY ON BOTH LEGS**, so unlike most of this
corpus the sheet can be tested against cash: `8308OHIODPSIRP DES:IRP FEE` for the
plates, `IRS DES:USATAXPYMT` for the HVUT. It fails the test in BOTH directions:

- **The duplicate the sheet flags is NOT one.** Two $2,493.34 IRP rows for units
  1365/1564/1596; **one** debit in the bank. The row is duplicated, no money was
  lost, and the sheet's $82,968.46 bottom line is overstated. A correction to the
  sheet, not a refund claim.
- **A duplicate the sheet does NOT flag IS one.** Unit 7584's $458.33 prorated
  HVUT was debited by the IRS on **2025-09-05 and again 2025-09-18**. That is
  cash out and a Form 2290 credit can recover it.
- **$9,648 of registration debits are on no line of the sheet** (12 of them,
  including $6,285.45 on 2025-05-02), and **$27,451 of sheet lines have no
  matching debit**. Neither side is the complete record.

**MATCH INSIDE THE VENDOR, NEVER ON AMOUNT ALONE.** $1,100 matches eleven bank
rows and $5,500 five — Zelle payments, wires, mobile deposits. The sheet's $51.31
plate transfer matches a Speedway fuel-card charge to the cent. Amount-only
matching "confirms" payments that never happened, so the reconciler only looks
inside rows already identified as that vendor's.

**A repeated amount is not a duplicate.** Three $550 IRS debits are three trucks
at the flat rate, and a $30.25 IRP fee eight months apart is two transactions.
Only a repeat of an amount that could belong to one truck alone — a *prorated*
HVUT — inside a 45-day window is a suspected double payment.

**Registration does not come back.** Unlike the insurance, there is no return
premium on a plate: the $2,607 on unit 2703, last seen in a P&L 2026-02-23, is
spent. Three registered trucks (4851, 5417, 5852, $6,563) are on no unit list at
all.

## Cost of a truck-day, and break-even for one truck

`analysis/truck_breakeven.py`. Three measured pieces, no chart of accounts:

1. **What a parked truck is charged** — the mean of 65 company-driver truck-weeks
   that earned nothing. XTRACK, last 13 weeks: $1,183/week (rent 673, admin and
   insurance 373, standing DEF and fees 97, tolls 21, downtime pay 21).
2. **The fixed/variable split of a running truck** — least squares of block cost
   on loaded miles: $1,690/truck-week fixed + **$1.6947/loaded mile** (R² 0.87).
   The two fixed figures differ ON PURPOSE: an idle truck is charged less rent
   than a running one, so the parked figure prices a lost day and the fitted
   figure prices break-even. Using one for both is wrong in both directions.
3. **Company overhead as a residual**, from an identity that cannot drift:
   `overhead = gross − net − CD block cost − OO cost`. **Never add up the panel's
   overhead lines** — they sum to 126% of the residual because some of what the
   panel calls overhead is already inside the unit blocks. Use the components
   only for the fixed/variable RATIO, which keeps their information without
   importing their overlap.

XTRACK, 2026-06-01 .. 2026-08-24: overhead $42,049/wk over 47 trucks = **$887 per
truck-week**, of which **$505 fixed** ($72/truck-day) and the rest 4.69% of gross
(Tashkent commission, factoring, maintenance).

**BREAK-EVEN, ALL THREE COMPANIES** (`--company all`, 13 weeks to 2026-08-24):

| per company-driver truck | ZONE | XTRACK | AFG |
|---|--:|--:|--:|
| truck rent, base | 1,166 | 1,165 | 1,167 |
| admin / insurance / trailer | 522 | 459 | 451 |
| **fixed cost, running truck** | **1,688** | **1,624** | **1,617** |
| fixed overhead per truck | 672 | 505 | 398 |
| **must be covered every week** | **2,360** | **2,130** | **2,015** |
| variable cost per loaded mile | 1.7169 | 1.7566 | 1.7927 |
| variable overhead, % of gross | 3.29 | 4.69 | 3.60 |
| miles per truck now | 2,818 | 2,546 | 3,280 |
| rate per mile now | 2.928 | 2.968 | 3.122 |
| **break-even miles at that rate** | **2,117** | **1,986** | **1,657** |
| headroom, miles a week | 701 | 560 | 1,623 |
| **break-even rate at those miles** | **2.641** | **2.721** | **2.497** |
| a lost truck-week costs | 1,879 | 1,532 | 1,549 |
| a lost truck-DAY costs | 268 | 219 | 221 |

Break-even miles a week by rate — below the figure, that truck loses money:

|  | $2.40 | $2.60 | $2.80 | $3.00 | $3.20 |
|---|--:|--:|--:|--:|--:|
| ZONE | 3,906 | 2,959 | 2,381 | 1,993 | 1,713 |
| XTRACK | 4,011 | 2,951 | 2,335 | 1,931 | 1,646 |
| AFG | 3,870 | 2,824 | 2,224 | 1,834 | 1,560 |

**The three are not the same business and the model must not flatten them.**
ZONE carries the highest fixed base ($2,360) because its overhead per truck is
$672 against XTRACK's $505 and AFG's $398, and 20% of its company-driver
truck-weeks earn nothing against AFG's 4%. AFG has the LOWEST break-even and the
MOST headroom — 1,623 miles a week — because it runs 3,280 miles at $3.12.
XTRACK has the thinnest margin per mile: $1.0725 kept at its own rate against
ZONE's $1.1149 and AFG's $1.2165, because 4.69% comes off the top before the
truck sees a cent.

**A ZERO-GROSS WEEK IS NOT A PARKED TRUCK.** Some of them burned $450 of diesel
and paid a driver — trucks that MOVED whose revenue landed in another week or
another block. The proof the filter is right is that fuel and driver pay come out
at *exactly* zero once they are excluded. Including them overstated a parked
truck by 15% for ZONE and XTRACK and 69% for AFG, and it is where the earlier
"standing DEF and fees $97" line came from.

**Price running and parked trucks SEPARATELY when checking the model against the
fleet.** Charging every company-driver truck a running truck's rent missed the
actual result by 12.5% on ZONE, 9.6% on XTRACK and 0.2% on AFG — exactly their
share of parked truck-weeks, in order. That was the control mis-stated, not the
model wrong.

**Charging an idle truck only what the P&L billed it understates it by 41%.**
The 105 idle XTRACK truck-weeks were billed $125,197; they also absorbed $51,401
of fixed overhead that did not pause. True cost **$176,599**, $6,541 a week.

This prices a COMPANY-DRIVER truck. Owner-operators carry their own equipment and
fuel and break even on different numbers. And a parked Iron Lease truck is
charged below its rate card, so the group's true cost of an idle truck is higher
than the operating company's books show.

## Per-truck economics: the rate card, the policy, and the maintenance ledger

`analysis/truck_weeks.py` joins three things on the truck number, which is the
same identifier in all of them (51 of XTRACK's 52 rostered trucks match its P&L
units): 27 weeks of P&L money, 13 weeks of dispatch days, and the Iron Lease
rate card. `analysis/truck_report.py` writes the operator workbook;
`analysis/maintenance_ledger.py` reads the per-unit repair ledger.

**The Iron Lease rate card** (operator-supplied 2026-09-04) is two tiers:
$735/week + $0.10/mile on 15739, 4772, 6867, 15909, 15852, 15862, 9859, 6799;
$900/week + $0.12/mile on 4716, 1489, 7605, 1431, 1645, 1568, 1542, 5007, 5269,
6379, 1500, 3773, 4549, 1722. **A truck moves between operating companies** —
1500 and 1722 appear in XTRACK and AFG, 15909 and 7605 in XTRACK and ZONE — so
"XTRACK's trucks" is a per-week fact, not a list. 5007 and 6379 appear in no P&L.

**The $735 tier is the expensive tier.** Over the invoice year its 8 trucks drew
$21,125 each in Iron Lease maintenance credits against $5,735 each on the $900
tier — 3.7x. The cheaper tier saves $165/week of rent and costs roughly twice
that in repairs.

**Rent charged falls below the rate card when a truck sits.** Across XTRACK's
five Iron-leased company-driver units the P&L charged $85,704 against $99,205 of
contract, and the whole $13,501 gap sits on 7605 and 6799 — the two that sat
most. So the P&L understates the carrying cost of an idle Iron truck; the
difference is absorbed inside Iron Lease.

**The home-time policy is 4 days home per 32-day cycle**, and the fleet average
meets it exactly while almost nobody does: 464 home days taken against 462 due,
but only 4 of 59 XTRACK drivers within a day of policy. OO drivers take 1.7x
their entitlement, `%` drivers 0.5x. Scale entitlement to the days a driver
actually appears — a flat denominator scores mid-period joiners as compliant.

**The maintenance ledger's `Iron lease exp` rows net to exactly zero, in pairs.**
68 positive and 68 negative, $53,367 each way: the repair booked when the
operating company pays it and reversed when Iron Lease credits it back. Summing
them double-counts; reading one reversal alone books a refund as a cost. Also:
only 712 of its 1,639 rows carry an amount, and **trailers are the bigger half**
of the spend (108 units, $162,533 vs 65 trucks, $130,352 in 2026) — folding them
into trucks overstates cost per tractor by about half.

## Maintenance cost per truck, matched to that truck's own miles and weeks

`analysis/truck_maintenance.py`. Joins `maintenance_ledger.py` (what broke, on
which unit) to `truck_weeks.py` (that unit's own miles and P&L weeks) BY UNIT,
across all three companies at once -- not per company, because a truck's repairs
are not filed under one company any more than its P&L rows are.

**A TRUCK'S MAINTENANCE IS NOT FILED UNDER ONE COMPANY.** 40 of 118 matched
trucks show charges or P&L weeks under more than one company -- unit 8131
(XTRACK/ZONE, $12,633, the single largest cost in the fleet), 15862, 1596. Every
per-truck figure here is the WHOLE truck, joined across every ledger and every
company's P&L that ever carried it.

**"WHAT WE SPEND" IS ONE OF THREE BUCKETS, AND ONLY ONE IS A COST:**

    company     the operating company paid it and does not get it back
    driver      billed to the settlement -- a RECOVERY, and whether it was
                actually deducted is a still-open question this does not close
    iron lease  booked when the company pays Truck Max, REVERSED when Iron
                Lease credits it back -- nets to zero and is excluded

**THE WINDOW IS CUT TO EACH TRUCK'S OWN P&L SPAN**, not the ledger's full
2026-01-01..09-01. The P&L only reaches back to 2026-02-23 (XTRACK/ZONE) or
2026-04-13 (AFG); dividing YTD dollars by a week count the P&L cannot
corroborate would overstate cost per week.

    fleet total (company-borne, each truck's own window):  $113,377
    over 2,195 truck-weeks and 6,133,979 miles
    fleet average    $51.65/truck-week    $0.0185/mile
    median            $15.88/truck-week    $0.0064/mile      <- the average is
                                                                 pulled up hard
                                                                 by a few units

    worst by $/mile   8131 (XTRACK/ZONE)  $0.1951/mi  $467.89/wk  27 wks
                      8132 (XTRACK)       $0.1408/mi  $348.77/wk  27 wks
                      1596 (AFG/XTRACK)   $0.1150/mi  $307.21/wk  13 wks

**A SECOND SOURCE, ADDED 2026-09-07: Truck Max's own invoice log**
(`ingest/parse_truckmax_invoices.py`), split into four payer workbooks --
Company_exp ($349,624, 426 rows), Iron_Lease_exp ($159,188, 80 rows), Driver_exp
($40,361, 27 rows), Sher_Imam ($10,139, 7 rows), 2025-08 .. 2026-09. Checked
against the original ledger's own invoice IDs before combining: **zero overlap**,
so the two are concatenated, never merged or deduplicated against each other.

**INVOICE NUMBERS ARE NOT UNIQUE, EVEN WITHIN ONE FILE.** `INV0015` appears
twice in Company_exp alone -- truck 8133 on 2025-08-28, trailer 536050 on
2025-08-27. Numbers also repeat ACROSS files: `INV0001` is $3,920.69 on truck
289909 in Company_exp and an unrelated $1,196.57 on truck 6169 in Driver_exp.
The shop reuses its own numbering, so identity is never the invoice number
alone, and nothing here deduplicates on it.

**THE SECOND SOURCE'S "IRON LEASE" BUCKET IS EXCLUDED FROM COST, ON PURPOSE.**
$159,187.96 of Truck Max invoices where Iron Lease is the payer of record is
close enough to the **$174,138** of "repair" CREDIT lines
`parse_iron_lease_invoices.py` already reads off Iron Lease's own WEEKLY
invoices that the two could be the same repairs counted from two different
documents. Neither source proves it either way -- reported, excluded from every
cost total, flagged as open rather than risked as a double count.

**A REAL BUG THIS SESSION FOUND IN ITS OWN NEW CODE, caught before it shipped:**
`str(15862.0)` is `'15862.0'`; stripping non-digits from that string keeps the
`0` after the decimal point, turning truck 15862 into `158620`. Every
whole-number-float truck in three of the four files gained a spurious trailing
digit this way -- 6867 became 68670, 15909 became 159090 -- until a whole-number
float is now cast through `int()` before any digit-stripping runs.

**COMBINED, BOTH SOURCES STILL COVER LESS THAN HALF THE P&L'S OWN LINE**, and
the ratio is now consistent across all three companies rather than the scattered
21-43% one source alone gave:

    XTRACK   ledger #1 $67,936 + #2 $38,122 = $106,058   panel $254,488   42%
    ZONE     ledger #1 $54,411 + #2 $28,572 = $ 82,983   panel $192,366   43%
    AFG      ledger #1  $9,534 + #2 $14,018 = $ 23,552   panel  $46,202   44%

(Figures above are windowed to each COMPANY's own panel span; a truck's
PER-TRUCK cost table below is windowed to that TRUCK's own P&L span instead --
the two windows serve different questions and are computed separately.)

**FLEET TOTAL WITH BOTH SOURCES COMBINED:**

    fleet total (company-borne, each truck's own window):  $190,264
    over 2,195 truck-weeks and 6,133,979 miles
    fleet average    $86.68/truck-week    $0.0310/mile

    worst by $/mile   8131 (XTRACK/ZONE)  $0.2612/mi  $626.48/wk  27 wks
                      8132 (XTRACK)       $0.2299/mi  $569.62/wk  27 wks
                     15852 (ZONE)         $0.2275/mi  $505.01/wk  26 wks
                      1596 (AFG/XTRACK)   $0.1881/mi  $502.34/wk  13 wks

**50 TRUCKS CHARGED IN EITHER LEDGER APPEAR IN NO COMPANY'S P&L** ($~52k) --
checked against the fleet registry: they either do not exist there at all, or
are exactly the units `fleet_registry.py` already found with no resolvable
company (`last_week: None`). Not a join bug; the same fleet-history gap this
pipeline has documented since the registry was first read.

**A PANDAS-VERSION BUG ALSO FOUND**, in code this session did not touch, now
fixed and regression-tested: pandas 3.x changed `.astype(str)` to leave a
genuine `NaN` as `NaN` instead of stringifying it to `'nan'`.
`maintenance_ledger.controls()`'s own check, `charged.unit.eq("nan")`, stopped
catching a real no-unit charge the moment the pandas version changed underneath
it -- silently, no error, no warning. Fixed to `.isna() | .eq("nan")`.

**QUICKMANAGE ("QM") WAS NOT IN THE CORPUS UNTIL 2026-09-07** -- the operator
asked to check "QM trucks and drivers expenses statements" and no QuickManage
export existed anywhere in `data/raw`. That day the operator supplied working
`client_credentials` OAuth pairs for all three companies and
`ingest/pull_quickmanage.py` was built and tested end to end against the real
API (`https://api.quickmanage.com`). **What it actually turned out to expose
corrects an assumption this file had carried since before its first commit**:
see "QuickManage has trips and trucks, NOT odometer or repair orders" below.

## QuickManage has trips and trucks, NOT odometer or repair orders

Confirmed 2026-09-07 by calling the real API with working credentials for all
three companies, not assumed. `POST /auth/token` with `{client_id,
client_secret}` returns `data.access_token`; that Bearer token was then tried
against every endpoint name a TMS API plausibly has:

    200  /x/trucks/search    /x/trailers/search   /x/drivers/search   /x/trips/search
    404  /x/repairs/search   /x/maintenance/search   /x/work-orders/search
    404  /x/odometer/search  /x/odometers/search  /x/inspections/search
    404  /x/fuel/search      /x/fuel-purchases/search   /x/service-records/search
    404  /x/expenses/search  /x/vendors/search    /x/invoices/search

**`/x/trucks/search` is a roster, not a mileage log**: `unit, vin,
plate_number, plate_state, make, year, owner_id, status, in_service_date,
drivers[]`. No odometer field anywhere on the record.

**`/x/trips/search` is dispatch/load data — real mileage, but per TRIP, not
per truck-week, and not an odometer reading**: each trip has `stops[]`, and
each stop carries `distance` and `deadhead` (miles), `rate` and
`accessorials_total` (revenue), `assigned_truck`/`assigned_trailer`/
`assigned_drivers`, and dates. Summed across a truck's stops in a week this
would be genuine measured mileage and revenue -- CLAUDE.md's "Mileage before
money" section's case for it still holds -- but it is not what "odometer" or
"repair-order" meant in the sourcing table below, and this API surface has NO
maintenance-cost data at all, confirmed by the 404s above, not merely absent
from what was queried.

**The sourcing table's "QuickManage / Samsara → odometer, repair orders,
revenue → measured" row is corrected**: QuickManage's `/x` API gives trips
(mileage + revenue) and a truck/trailer/driver roster. It gives neither
odometer readings nor repair-order cost. Whether Samsara or some other
QuickManage surface not tried here carries those is still open -- this only
rules out the four endpoint families above.

ZONE_OH alone returned **221 trucks** and **23,510 trips** (paginated 100 at a
time via `page`/`page_size` in the request body, not yet driven past page 0
here). `ingest/pull_quickmanage.py` authenticates and saves raw
trucks/trips JSON per company under `data/raw/quickmanage/<company>/`; nothing
downstream reads it yet, and pulling the full 23,510-trip history for all
three companies, then deciding whether it duplicates `data/raw/ops/`'s own
per-driver-per-day dispatch rows below, is unbuilt and worth a decision before
building it, not an assumption either way.

**Credentials arrived pasted directly into a chat message**, not through the
setup flow `pull_sheets.py` uses. They were tested via a session-only
`export QUICKMANAGE_CREDENTIALS=...`, never written to any file in this repo
-- `config/quickmanage_credentials.example.json` holds only placeholders, per
the existing `config/*_credentials.json` gitignore rule. For this to survive
a container reclaim the same way `GSHEETS_SERVICE_ACCOUNT` was meant to, the
real JSON needs to be pasted into the remote environment's persistent
variables as `QUICKMANAGE_CREDENTIALS` -- the one step only the operator can
do, same as every other credential in this pipeline.

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
