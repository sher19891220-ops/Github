# Fleet Financial Forensic Pipeline — findings archive

This is the detailed, dated narrative CLAUDE.md used to carry in full: every
topic's deep dive, bug found, and number derived, with the reasoning and the
date it was established. `CLAUDE.md` itself now holds only conventions that
must not be re-derived or guessed on every session -- entities, sign
convention, controls, sources, and where to look things up
(`analysis/facts.py --find`, `docs/CATALOG.md`). This file is where the WHY
behind a number lives, and where to check before re-deriving something that
was already found. Read it when a number needs justifying, a parsing trap
needs recalling in full, or an old decision needs revisiting -- not by
default on every session, which is the whole point of splitting it out
(2026-09-14, in response to the account's own API/credit spend accelerating
in the invoice history -- CLAUDE.md was reloaded into every turn of every
session on this repo, and had grown to 2,369 lines).

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


## Connect to Google Sheets directly instead of exporting by hand — full detail

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

**2026-09-15 — dug into this further, at the request "dig into the ZONE and
XTRACK fuel gaps." Two things found, one corroborating, one only partial:**

**1. The mpg each return implies, not just the gallon gap, points the same
direction.** ZONE's return works out to 6.18 mpg; its own company drivers
measure 6.82 on the same trucks — the return has *more* fuel than its real
fleet burns. XTRACK's return works out to 8.76 mpg — implausibly efficient for
a loaded Class 8 truck, against 6.66 measured on its own company drivers — the
return has *less* fuel than its real fleet burns. A truck this pipeline already
knows is not that efficient is exactly the signature of gallons filed under the
wrong account, not a sheet error (Tier 1 passes cleanly on both companies' own
company-driver blocks).

**2. Checked whether the group's own known company-movers explain it, and
found one live example inside the exact window.** `analysis/truck_weeks.py`
already names 15909 and 7605 as trucks that move between XTRACK and ZONE.
Unit 15909's own weekly rows: ran as a ZONE company-driver truck with real
miles and gallons through the week of 2026-04-20, then goes to 0 miles/0
gallons on ZONE for five straight weeks, then reappears on XTRACK's roster as
an **owner-operator** truck starting the week of **2026-06-01** — inside Q2 —
running real miles (2,155–4,378/week) through August. An owner-operator block
carries no gallons column in this pipeline (by design — `truck_weeks.py`), so
15909's June mileage feeds XTRACK's *implied* fuel need (via `sheet_miles`)
without any matching gallons ever landing in XTRACK's own measured burn. If
its IFTA/fuel-account reassignment did not move on the same date as this P&L
handoff, this is a live instance of the exact mechanism the hypothesis above
names.

**This does not close the gap by itself, and is reported as partial rather
than solved.** One truck's June-onward mileage (order of 15,000–20,000 mi/
quarter at ~6.7 mpg, roughly 2,500–3,000 gal) is far short of the 20,089-gal
ZONE excess or the 54,253-gal XTRACK shortfall, and the group NET is
**−34,831 gal, not zero** (406,108 filed against three companies) — "roughly
nets out" undersells a residual that is 8.6% of everything filed. 7605 moved
XTRACK→ZONE too, but cleanly at the Q2/Q3 boundary (last XTRACK week
2026-06-29, first ZONE week 2026-07-06), so it does not touch this quarter's
gap. Confirmed: this is a real, dated, in-window mechanism consistent with the
existing hypothesis, not a full account of the $34,831 net or the two
individual gaps. Not yet checked: whether other trucks changed rosters mid-Q2
the same way, and whether the actual IFTA-authority switch date for 15909 (as
opposed to its P&L roster date) is available anywhere in this corpus to
confirm the lag directly rather than infer it.

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

## Who BEARS the registration cost, not just who ran the truck

`analysis/registration.py`'s `attribute_by_responsibility()`, config
`config/registration_responsibility.json`, operator-supplied 2026-09-10 via
chat. A different question from `attribute()` above (whose P&L last carried
the truck): an owner-operator's own truck, a named investor's truck, and a
lease-to-purchase truck not yet paid off are none of them a cost the operating
company should carry, no matter which company's P&L the truck sits on. Neither
function replaces the other -- they sit side by side, answering different
questions from the same 48-truck payment list.

**TWO OF THE "ON NO UNIT LIST AT ALL" TRUCKS WERE MISTYPED, NOT MISSING.**
5852 and 5417 -- named above as 2 of the 3 registered trucks unresolvable to
any VIN -- are one or two digits off a real truck each: 5852 should read
15852 (ZONE, which already carries its own separate $33.00 replacement-plate
line, so 15852's true total is $2,639.53), and 5417 should read 5091 (VIN
3AKJHHDR1MSLX5417 -- the unit number and the VIN's own trailing digits are not
the same thing, the same kind of mismatch that produced truck 8091/8132
earlier in this corpus). Operator-confirmed by chat; 4851 remains genuinely
unresolved.

**OWNER-OPERATORS BEAR THEIR OWN IRP/HVUT.** General policy, not a per-unit
list -- any of the 48 registered units flagged `owner_operator=true` in
`ingest/fleet_registry.py`'s registry() is the owner's own truck. Resolves to
5091 ($1,350.19, ZONE-operated), 7584 ($2,826.40, company unresolved on the
P&L side -- the OO flag does not depend on that), and 8671 ($2,606.53,
XTRACK-operated).

**NAMED INVESTORS BEAR THEIR OWN, TOO.** Trucks 3898, 1365 and 1596 belong to
investor Sher Imam (also named elsewhere in this corpus: the Pedigree
trailer-tracking invoice, the Truck Max "Sher Imam" payer bucket, and a
nominal $120/month MANAGER payroll line) -- $5,431.37 combined, none of it
ZONE's or AFG's to carry even though both those companies' P&Ls show the
trucks. **A fourth unit the operator named, 4546, could not be resolved** --
it matches no VIN in the fleet registry and no unit in the registration
payment list at all, and unlike 5852/5417 it has no exact one-digit-off match
this corpus can confirm. Left out of the investor bucket rather than guessed
(a plausible candidate, 4553, AFG, $987.59, is already in the list under its
own name) -- flagged back to the operator instead.

**LEASE-TO-PURCHASE TRUCKS STAY WITH THE OPERATING COMPANY UNTIL PAID OFF,
PENDING CONFIRMATION.** Six VINs (3AKJHHDR0LSLR8671, 3AKJHHDR2NSMY4857,
3AKJHHDR5NSMY1564, 3AKJHHDRXNSMY4718, 3AKJHHDR0NSMY1682,
3AKJHHDR4NSMY5413 -- units 8671/4857/1564/4718/1682/5413) will belong to their
lease-to-purchase drivers once paid off. 8671 is ALSO an owner-operator truck
already (the more specific rule applies, so it is charged to the OO, not held
pending); the other five ($5,076.60 XTRACK, $1,382.07 AFG, $1,006.92
unresolved-company) are tagged pending-payoff but, absent a stated effective
date, still attributed to whichever company operates them today -- a judgment
call this file does not make silently, flagged back to the operator rather
than assumed either way.

**EVERYTHING ELSE SPLITS EQUALLY ACROSS THE THREE COMPANIES, NOT BY WHO RAN
IT.** Operator, 2026-09-10: every registered truck not covered by the three
rules above -- 35 of the 48 -- has its IRP/HVUT divided ONE-THIRD each to
ZONE, XTRACK and AFG ($17,813.39 apiece on $53,440.18), replacing
`attribute()`'s "whichever company's P&L last carried it" rule for this
specific cost. That rule still runs, unchanged, for the question it actually
answers.

**WHERE THIS BELONGS: FIXED COST, NOT OVERHEAD -- THE ATTRIBUTION CHANGED,
THE CLASSIFICATION DID NOT.** Registration was already `cost_structure.py`'s
own per-truck fixed-cost line (annual, prepaid, does not vary with miles --
the same shape as insurance) before any of this; nothing here moves it into
"overhead" (the shared staff/office roster spread across the whole fleet).
WHO pays a fixed cost and WHETHER a cost is fixed are two different
questions -- this file only answers the first.

**4851 resolved, and three more named**, 2026-09-10: 4851 is VIN
`3AKJHHDV6LSKY4851`, financed through Iron Lease LLC, driver Alphonse
Jefferson, status "sold" -- exactly the lease-to-own outcome the "Lease-to-
own" section above already established for this driver and unit ($65,000 of
$65,000 paid). He is no longer affiliated with the company. New bucket,
`sold_paid_off_owners` in the config: his $2,606.53 is excluded from company
cost AND from the running-fleet overhead spread (he is not an active
operator to spread it over). The five other lease-to-purchase VINs (all but
8671, which stays under the owner-operator rule) are now confirmed deducted
too -- $7,465.59 (1564, 4718, 1682 XTRACK; 4857 AFG; 5413 company-
unresolved). **Remaining company-borne pool: $53,440.18**, spread as
overhead across the 90-truck running fleet (17 AFG + 32 ZONE + 41 XTRACK,
the same denominator used throughout this corpus): **$593.78/truck/year =
$11.42/truck/week = $1.63/truck/day** -- this is the number to use in place
of the original $1,726.60/truck/year wherever the question is what the
GROUP's own running fleet costs, as distinct from what individual owners and
investors now pay themselves.

## The state's own IRP filing confirms the two corrections above, and finds three more open questions

`ingest/parse_irp_status.py`, `registration.py`'s `check_against_irp_status()`.
Ohio BMV's "IRP - Vehicle Status" report (`data/raw/permits/irp_status/`,
uploaded 2026-09-10) is a FILING -- account 98142, ZONE-OH LLC, 42 units
currently active, run on demand from the state, not a hand-kept sheet. Per
this corpus's own evidence hierarchy it outranks the internal group unit
workbook the way an IFTA return outranks the P&L sheet.

**EVERY ONE OF THE 42 FILED VINS RESOLVES IN THE GROUP WORKBOOK, AND ONLY
TWO ARE RENUMBERED** -- exactly the two `unit_number_corrections` already
made from the operator's own correction (5852/5417), now independently
confirmed rather than merely inferred from a one-digit-off match. No other
truck in this 42-unit fleet has a numbering mismatch, which is what makes
these two corrections and not evidence of a wider split.

**SIX PAID UNITS ARE NOT ON THIS CURRENT ACTIVE LIST**: 15852 (the internal-
workbook twin of 5852, already accounted for), 2703 (already known stopped
running, last seen in a P&L 2026-02-23), 4851 (sold to Alphonse Jefferson,
above), **7584** (resolved below -- its owner-operator quit long ago), and
two still open -- **6867** (ZONE, active in the P&L as recently as
2026-08-03, no reason yet why it is off ZONE-OH's account), and **9859**
(XTRACK-run -- plausibly registered on a separate XTRACK IRP account this
filing does not cover, not yet confirmed). Neither of the two is assumed to
be dropped from the fleet; they are reported as a filing gap to close, the
same way the Oregon-return gap is reported rather than priced at zero.

`tests/test_irp_status.py` locks in the parse's own control (matches the
filing's stated 42-unit total) and the cross-check result; skipped when the
filing is absent, the same pattern as every other raw-corpus-dependent test.

## Registration responsibility, round two: departed drivers, a stated lease-to-purchase rate, and a real duplicate-row bug

Operator, 2026-09-10, via chat, following up on the responsibility work above.

**7584 IS THE DEPARTED-DRIVER CASE, NOT AN ONGOING SELF-PAY ONE.** "it was
Owner operators truck and he quit the company long time ago do not count
him." New bucket, `departed_owner_operators` -- same treatment as
`sold_paid_off_owners` (4851): excluded from company cost AND from the
running-fleet overhead spread, since he is not an active operator to spread
it over. $2,826.40 moves out of `OWNER-OPERATOR (self-pay)` into its own
line. This also resolves one of the three open questions the IRP-filing
cross-check above raised (7584 was one of the six paid units missing from
ZONE-OH's active 42) -- he left, so of course his truck is not on it.

**5091 IS STILL PENDING.** "I will let you know about him tomorrow." Left
under `owner_operator_self_pay` unchanged until then.

**8671 CONFIRMED, UNCHANGED**: "he will be responsible for hvut and irp
charges and we will deduct it from him" -- already modeled under the
owner-operator rule, taking precedence over the lease-to-purchase rule for
this one truck.

**THE OTHER FIVE LEASE-TO-PURCHASE TRUCKS NOW CARRY A STATED FLAT RATE, NOT
THEIR ACTUAL COST.** "those driver will be responsible for hvut cost which
is 550$ each and irp amonut that is 1880$ each unit" -- $2,430/unit,
`stated_driver_rate` in the config. This is ABOVE the entire measured IRP
range this corpus has established ($438-$1,430/truck, 3.3x spread) for
every one of the five (1564, 1682, 4718, 4857, 5413): the company will
recover $945.83-$1,423.08 MORE per truck than it actually paid the state,
$5,515.53 combined. Not treated as an error -- it is what the operator says
will actually be charged -- but reported as a stated-vs-actual gap the same
way `driver_arrangement_rates.json`'s truck-2703 rent already is, not
silently assumed to equal cost.

**A REAL DUPLICATE-ROW BUG, FOUND ANSWERING WHY SHER IMAM'S TOTAL LOOKED
WRONG.** The operator questioned the $5,431.37 investor total against an
expected $5,639 -- chasing that down surfaced a genuine defect this corpus
had already documented but never corrected in the code: the $2,493.34 IRP
payment for units 1365/1564/1596 is printed TWICE in the source sheet ("the
row is duplicated, no money was lost," confirmed against the bank, which
shows one debit). `parse_irp.py`'s `per_unit()` sums every row as printed
and inherited the double-count -- harmless for a report that only ever says
the sheet's own total is overstated, but it would have silently overcharged
Sher Imam for money never actually spent. New function,
`registration.py`'s `deduplicated_per_truck()`, removes exactly the
duplicated row's share (one instance of $831.11) from each of the three
trucks before anything downstream reads it. **Corrected Sher Imam total:
$3,769.15** (was $5,431.37) -- LOWER than both the original figure and the
operator's expected $5,639, so this does not resolve the operator's
question; it replaces one unexplained number with a different, better-
evidenced one and leaves the $5,639 origin still open.

**NONE OF THIS MOVES THE RUNNING-FLEET OVERHEAD FIGURE.** The equal-split
pool was already $53,440.18 before this round (7584, the LTP trucks, and
the duplicate-affected trucks were already excluded from it) and is
unchanged after -- still **$593.78/truck/year = $11.42/truck/week =
$1.63/truck/day** across the 90-truck running fleet.

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

**A THIRD SOURCE, ADDED 2026-09-07: QuickManage's own "Spending by
Trucks/Trailers" report**, exported from its web UI (not its API -- the `/x`
endpoints probed the same day return 404 for anything spending-shaped; this
report clearly exists in the product regardless). Two files, Zone-OH LLC only,
top 10 units each by total spend, 2025-08-01..2026-09-07 (`data/raw/quickmanage/
reports/`). Cross-checked against every ledger and Truck Max source above, same
window, company-borne only:

    TRUCKS: QuickManage is higher for 9 of 10 units, often by a lot -- two
    units (6169 $11,124, 001 $6,404) have ZERO matching rows anywhere else in
    the corpus. The one exception is unit 8131, where the PIPELINE is higher
    ($22,691 vs QuickManage's $6,825) -- the opposite direction from every
    other truck, on the fleet's own worst-$/mile unit. Not yet explained.

    TRAILERS: much closer, and mixed-direction ($-2,431 to $+6,501 across the
    10) -- no zeros, no wild multiples. Whatever QuickManage is capturing that
    this pipeline is not, it affects TRUCKS far more than trailers.

This is a top-10 leaderboard, not the underlying detail -- it names which
units are worst, not what was charged or when, so it cannot be joined
row-by-row the way Truck Max's invoice log can. The real fix is the full
per-unit spending detail from QuickManage, not just its top 10; until that
exists, treat every truck total above as a FLOOR, not the true cost, and treat
unit 8131's reversal as a specific open question rather than assuming it
nets out with the rest.

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

## Maintenance/breakdown cost by company: trucks only, and only 30.6% of units

Added to `spend_picture.py` (`truck_company()`, `company_rollup()`) 2026-09-09.
Attributes each TRUCK to a company from two sources in preference order: the
IRP-plate registry (an ongoing legal registration, tends to cover a truck's
whole active life) then, if that misses, `truck_maintenance.py`'s P&L blocks
(only 2026-02-23..08-24). **TRAILERS ARE NEVER ATTRIBUTABLE THIS WAY** --
confirmed every trailer unit number returns `None` from the IRP registry;
no trailer registry or trailer P&L block exists anywhere in this corpus.

    $/truck/company        charges   total spend   cost/mile
    AFG                        320    $143,504      $0.0399
    XTRACK                     754    $347,464      $0.0383
    ZONE                       450    $217,077      $0.0276
    UNATTRIBUTED              1,564    $506,975         --

Only 92 of 301 trucks (30.6% of units) resolve to a company, but that 30.6%
carries 58.3% of the dollars ($708,045 of $1,215,019) -- the unresolved 209
are disproportionately older, pre-2025 trucks that predate both the IRP
registry and the current P&L's window, not the current active fleet.

**BUG FOUND AND FIXED THE SAME DAY**: the first version built the unit-to-
company map separately from the charges frame and the cost-per-mile frame.
`truck_cost_per_mile()`'s frame carries extra units with real P&L miles but
zero charges (never appear in the charges frame at all) -- computing the
map from charges alone left those units out of the dict, `.map()` turned
the missing key into the same NaN as a genuinely unresolved unit, and their
real miles landed in the UNATTRIBUTED bucket while contributing $0 cost,
producing a nonsense $0.00/mile instead of leaving it correctly uncomputable.
Fixed by building the map ONCE from the union of both frames' units, used
everywhere; regression-tested (`test_company_rollup_totals_match_the_
ungrouped_truck_total`, `test_unattributed_company_has_no_fabricated_cost_
per_mile`, `test_trailers_are_never_attributed_to_a_company`).

`Trucks by Company` and `Trucks Monthly by Company` sheets now in
`data/processed/spend_picture.xlsx`.

## Verizon is 60 lines, not one per truck -- corrected 2026-09-09

The operator caught this: the earlier `$7.07/truck/week` Verizon figure
spread the $636.42/week fleet-wide total over all 90 trucks, but the
Verizon account only covers **60 lines**. Some drivers supply their own
tablet and should not be charged for a line the company isn't providing.

    real per-line cost: $636.42/wk / 60 lines = $10.61/line/week ($46.13/month)
    coverage gap: 90 trucks - 60 company lines = 30 trucks presumptively
                  on a driver-owned tablet

$46.13/line/month sits in the normal range for an LTE data-only tablet
plan -- consistent with, though not proof of, the stated 60-line count.
**No per-line Verizon bill exists anywhere in this corpus** to confirm it
exactly or name which 30 trucks are on their own device -- the only
per-line wireless CSV on file is STL Truckers LLC's own account, a
different entity, not usable as a stand-in. `$10.61/truck/week` applies
only to a truck actually holding one of the 60 company lines; a driver on
the existing `own_tablet_rate` ($125/month) schedule should carry $0
Verizon cost here, since that higher flat fee already stands in for
supplying their own device -- charging both would be double-counting.
The company-level totals in `admin_fee_actual_cost_per_truck_week` keep
the old $7.07 fleet-average rather than guess which of each company's
trucks hold one of the 60 lines; `verizon_60_lines` in
`config/driver_arrangement_rates.json` has the corrected per-line figure
for a truck known to have a company tablet.

**What would resolve this for good**: a per-line Verizon export naming the
device/user on each of the 60 lines, the same shape as the PrePass
`CHARGESBYDEVICE` CSV that made the truck-level PrePass split possible.

### The line count wasn't actually steady at 60 -- it grew, recently

The operator gave a second data point the same day: "each tablet with line
costs about $40." Dividing each individual AMEX monthly invoice by $40
(rather than the 47-week average, which blends eras together) surfaces
something real:

    2025-10-31 .. 2026-05-31   $2,360-2,371/month -> 59.0-59.1 lines,
                               ROCK STEADY for 8 straight months --
                               matches the stated 60 almost exactly
    2026-07-01                 $2,784.73 -> 69.6 lines
    2026-07-31                 $2,868.73 -> 71.7 lines

**The account held ~59 lines for 8 months, then grew to ~70-72 by July
2026** -- 11-13 more lines, ~$440-480/month more than the steady-state
baseline. NOT YET EXPLAINED whether this is legitimate fleet growth or
unaccounted creep -- exactly the kind of thing the operator asked to catch
by raising the 60-line question in the first place. Using the CURRENT
figure instead of the historical one: 90 trucks - ~72 current lines leaves
~18 trucks on a driver-owned tablet, not 30. Both the historical and
current estimates are in `config/driver_arrangement_rates.json`'s
`verizon_60_lines` -- neither overwrites the other, since which one is
"right" depends on which period is being priced.

## Worst-to-best maintenance/breakdown ranking and trend: `analysis/breakdown_trend.py`

Built on `spend_picture.py`'s already-reconciled multi-source charge data
(2021-2026) -- ranks every truck and trailer by total spend, adds
cost-per-mile for trucks, and classifies each unit's monthly spend pattern
as `one-time` (one month is >=60% of the whole multi-year total, or there
is only ever one priced month), `worsening` (later half of its active
months costs >1.5x the earlier half), `improving` (<0.67x), or `steady`.
Two-halves-by-TOTAL was chosen over a regression slope on purpose: most
units have long $0 stretches between real repairs, and a trend line through
mostly-zero months is dominated by where the one spike sits, not by whether
cost is actually climbing -- comparing two totals survives that.

**BUG FOUND AND FIXED THE SAME DAY IT WAS BUILT**: the first version's
`monthly_series()` filtered by unit number only, not unit_type. Any unit
with even one row mistagged to the other type (truck 8093: 66 rows tagged
'truck' worth $33,539.06, one stray row tagged 'trailer' worth $237.50)
had its ENTIRE total appear in BOTH the truck and trailer tables --
`tests/test_breakdown_trend.py` guards this exact case as a regression
(caught by a value_counts() eyeball check before any test existed, then
formalized). Some unit numbers genuinely ARE reused across a truck and a
separate trailer (43 confirmed) -- that overlap is real and expected; what
is never allowed is the same dollar total under both.

**RESULT, worst 10 trucks by total spend** (of 300 with any charge,
$1,215,312 combined):

    7039    $45,375  one-time (1 month only -- a single large event)
    8130    $42,013  steady    ($0.1435/mi)
    8132    $38,146  worsening ($0.2357/mi)
    8093    $33,539  worsening ($0.0863/mi)
    8094    $32,541  worsening ($0.0838/mi)
    8131    $31,215  worsening ($0.2705/mi -- the fleet's worst $/mile truck)
    8083    $30,868  worsening ($0.0614/mi)
    8092    $28,203  worsening ($0.0758/mi)
    8133    $28,160  worsening ($0.0953/mi)
    6178    $27,899  one-time (7 months, one dominates)

**THE FLEET-WIDE ANSWER TO "IS THIS GETTING WORSE": YES, DOLLAR-WEIGHTED,
NOT JUST A FEW UNITS.** 48.6% of all truck dollars and 48.3% of all
trailer dollars sit in units classified `worsening` -- not a long tail of
isolated one-time breakdowns (`one-time` is only 23.6% of truck dollars,
25.5% of trailer dollars despite being the MOST COMMON label by unit count,
164 of 300 trucks -- most one-time hits are small; the big dollars are
concentrated in units getting worse). Fleet-wide monthly company-borne
spend (all units) climbed from ~$45k/month in late 2024 to ~$140k/month by
mid-2026 -- a real, sustained increase over 18+ months, not noise.

`python3 analysis/breakdown_trend.py` writes `data/processed/
breakdown_trend.xlsx` (Trucks worst to best, Trailers worst to best, Data
notes).

## What the $100 admin fee is actually meant to cover, priced for real

Operator, 2026-09-08: the admin fee covers ONLY six things -- IFTA, ELD,
transponders, Samsara, Verizon, Trippak -- not the wider staff overhead
above. That changes the comparison from the last section: it is not "admin
fee vs everything," it is "admin fee vs these six line items," priced in
`config/driver_arrangement_rates.json`'s new `admin_fee_actual_cost_per_truck_week`
key. ELD here is SOFTWARE ONLY, not the software+team figure two sections up
-- team payroll is a labor cost, and none of the other five items have one
either, so mixing it in here would compare unlike things.

    $/truck/week      XTRACK    ZONE     AFG
    IFTA               17.75   23.29     6.70
    ELD (software)       9.37    9.43    10.18
    Transponders         3.94    3.96     4.06
    Samsara (fleet-wide, not split by company)     7.88
    Verizon (fleet-wide, not split by company)     7.07
    Pedigree TPMS (fleet-wide, added later same day)  7.46
    Trippak                    NOT FOUND -- unmeasured, not assumed $0
    -----------------------------------------------
    TOTAL (6 of 7 measured)   53.47   59.09   43.35

**Verizon was already in the corpus** -- the operator believed this cost
was still to be uploaded separately (per the 2026-09-07 chat). Found by
searching for the "VZWRLSS" descriptor (Verizon Wireless's own billing
abbreviation) on both the AMEX card ($29,759.20 over 47.7 weeks) and the
bank feed ($559.85 over 44.0 weeks, "PREPAID" plans) -- $636.42/week
fleet-wide, no per-truck or per-company breakdown exists for it.
**Pedigree TPMS/trailer tracking was added as a seventh item** on the
operator's later instruction, not part of the original six -- same
invoice as the pedigree_trailer_tracking entry above ($2,781.00, Sep 2026),
but RE-BASED from per-trailer ($5.37/trailer/wk over 125 trailers) to
per-truck ($7.46/truck/wk over the same 90-truck denominator as everything
else here), since the admin fee is charged per truck, not per trailer.
**Trippak was searched for and not found anywhere** -- not on the card, not
on the bank feed, no invoice uploaded. Excluded from every total rather
than guessed, so every total above is a floor.

**Even missing Trippak entirely, real cost is now 1.9-2.6x the $23.09/week
fee** (XTRACK 2.3x, ZONE 2.6x, AFG 1.9x) on the six items that could be
priced. Samsara, Verizon and Pedigree are each billed as one account with
no per-truck split -- applied uniformly per truck across all 90 trucks, the
same unresolved risk PrePass already demonstrated (a single-account bill
can quietly cover all three fleets, or may not; only a device-level export
settles it).

## The same treatment applied to every department: `config/staff_overhead_costs.json`

Same method as ELD -- each department's payroll ÷ 90 trucks (no department
in this payroll file has a per-company column, so all seven are shared
cross-company teams, spread over the whole fleet):

    $/truck/week          July      Jan-Jul avg    headcount
    ACCOUNTING            14.05      12.27          5
    DISPATCH             260.17     173.36         19
    ELD                   14.82      13.58         12
    FLEET                 23.16      19.48         11
    HR                    18.73      14.79          6
    MANAGER                29.54      22.81          2
    UPDATE_TEAM           11.88       9.97          7

**DISPATCH IS NOT LIKE THE OTHER SIX.** It is 6-18x every other department
and swings hard month to month (one dispatcher: $7,114 -> $9,738 -> $11,627
May-June-July) because it is commission on gross freight booked, not a flat
wage. `config/dispatch_commission.json` already has the rate schedule
(supplied 2026-09-02) but confirmed 2026-09-08 by grep: **nothing in this
repo ever consumes that file** -- so this payroll figure is the first
actual measured dispatch cost, not a double-count of anything already in
`cost_structure.py`.

**Two totals, not one**, because Dispatch answers a different question than
the other six:

    all seven departments:     $372.35/truck/week (July), $266.27 (avg)
    excluding Dispatch:        $112.18/truck/week (July), $92.91 (avg)

**Compared to the stated $100/month ($23.09/week) driver admin fee**
(`config/driver_arrangement_rates.json`): real shared-staff overhead is
4-5x that even EXCLUDING Dispatch, 12-16x including it. This is a
factual gap, not a claim the fee was ever meant to cover it all -- freight
margin, not the fee, is presumably what closes the rest. Reported because
every stated rate in this project gets checked against a measured source,
not because the gap itself proves anything is wrong.

## The real ELD cost: software + team payroll, completed 2026-09-08

The operator's own payroll PDF (`data/raw/payroll_staff/`, transcribed to
`active_staff_payroll_jul2026.csv`, reconciled to the PDF's own printed
totals to the penny -- $145,728 July, $104,209 vs $104,210 Jan-Jul avg,
off by $1 from the PDF's own rounding) has a dedicated **ELD department, 12
people**. This is the piece the operator said was required before reporting
a "real" ELD cost -- software alone was never the full answer.

    combined ELD software (AFG+ZONE+XTRACK, this period): $858.76/week
    ELD team payroll: $5,799/mo (July, most recent) = $1,333.54/week
                       $5,316/mo (Jan-Jul average)   = $1,222.47/week

    REAL ELD COST PER TRUCK/WEEK, 90 trucks (17+32+41):
      using July payroll:        $24.36/truck/week
      using Jan-Jul avg payroll: $23.12/truck/week

The ELD team, like Accounting/Dispatch/HR/Manager in the same payroll
roster, has no per-company column -- it is ONE shared team serving all
three companies, so this is spread over the whole 90-truck fleet, not
billed per company. Full detail in `config/telematics_costs.json`.

**The payroll data itself already looks like it blends salary + commission**
(most of the 12 vary month to month; "Bahodir IT support" is a flat
$300/month every month, reading as pure base pay with no commission) --
consistent with what the operator asked for without a separate commission
figure being necessary.

**One entry is flagged, not used anywhere**: "Sher Imam" appears under
MANAGER at $104/month -- the same name attached to the Pedigree trailer-
tracking invoice and the "sher imam exp" bucket in Truck Max data. $104/mo
is obviously not real full compensation for whatever role this is; treat it
as a nominal/structural payroll line, not this person's actual economics,
until told otherwise.

**This payroll roster is bigger than the ELD answer** -- 62 people across
7 departments (Accounting, Dispatch, ELD, Fleet, HR, Manager, Update Team),
$145,728 for July alone. It is now available in the corpus for the
"fixed company overhead" / admin-fee reconciliation this project has
touched before, but that reconciliation has not been built -- only the ELD
piece was, because that is what was asked for.

## A vendor "billed to ZONE-OH" does not mean ZONE's fleet alone

Found 2026-09-08, checking the PrePass/BestPass CSV at the device level
(`ingest/registration.py`'s fleet registry, matched against every EQUIP ID):
the account is billed under ZONE-OH LLC, but its 107 devices are **XTRACK 41,
ZONE 36, AFG 17, 11 unresolved** -- all three companies' trucks on one
"ZONE-OH" invoice. Corrected per-company rates now in `config/
telematics_costs.json`: XTRACK $3.94/truck/wk, ZONE $3.96, AFG $4.06.

**Samsara and Pedigree trailer tracking are ALSO billed to ZONE-OH, and this
same check CANNOT be run on them** -- both invoices give aggregate quantities
only (13/65/65 for Samsara; 100+25 trailers for Pedigree), no per-device unit
list. Do not assume they split 41/36/17 like PrePass did; that split is
PrePass-specific evidence, not a fleet-wide constant. The real fix is asking
each vendor for the same device-level CSV PrePass already provides.

## SaaS/app charges pulled from the verified AMEX and bank sources

`config/saas_app_charges.json`. Searched `ingest/ingest_amex.py`'s deduped
10,271-transaction card export and `data/processed/boa_transactions.csv`
(147 statements, each verified to its own balance delta) for DAT, 8x8,
RingCentral, Samsara, Green Light ELD, Pedigree, PrePass/BestPass,
QuickBooks, GoDaddy, Google -- all fleet-wide, none split by company, since
neither source names a truck or company on a SaaS charge.

**Three things that would corrupt this if taken at face value:**

1. **DAT has two non-overlapping payment windows, never summed as one
   number**: bank ACH Jan-Aug 2024 ($206.78/wk), then AMEX Mar 2025 onward
   ($663.04/wk), with an unexplained gap between them.
2. **Green Light ELD's real channel is PayPal on the AMEX card**
   ($630.11/wk, 42 charges) -- the 10 bank-ACH "GREENLIGHT" hits ($320
   total, all inside one 2-week window) are almost certainly bank account
   micro-verification pings, not subscription payments, and are excluded.
3. **Samsara and Pedigree's AMEX totals ($643.36/wk and $696.40/wk across
   ~18 months) are the long-run recurring cost, separate from the single
   September 2026 ZONE-OH invoices** in the telematics section above ($2,309
   and $2,781 for one month) -- one is a trend, the other is a snapshot;
   neither replaces the other.

**Not found on either rail**: Microsoft/Outlook, Verizon, Motive (pending a
deal per the operator), Zoom, Slack, Adobe, DocuSign, Truckstop.com, ITS
Dispatch. Either paid through an account this corpus doesn't have yet, or not
actually subscribed.

## Telematics cost per truck/trailer/week (ELD, Samsara, transponders, trailer tracking)

Five invoices + two CSVs uploaded 2026-09-08 (`data/raw/eld_transponder_telematics/`,
facts in `config/telematics_costs.json`). **The operator was explicit: this is
SOFTWARE cost only** -- the real ELD cost also needs the ELD team's salary and
commissions added before dividing by truck count, and that payroll figure does
not exist anywhere in this corpus. Do not report a "real ELD cost" without it.

**Green Light ELD is a flat $40.00/truck/month base rate, confirmed exactly**
(ZONE: 32 trucks x $40 = $1280.00 on the invoice line itself) across all three
companies -- each invoice also carries a prior-period true-up for trucks
activated/deactivated mid-cycle, which is real invoiced money, not noise, but
is a one-time catch-up rather than the ongoing rate:

    AFG     $766.44 / 17 trucks  = $10.18/truck/week (period total, incl. true-up)
    ZONE    $1,292.90 / 32 trucks = $9.43/truck/week
    XTRACK  $1,700.63 / 41 trucks = $9.37/truck/week
    base rate alone: $40/month = $9.20/truck/week

**Everything else uploaded is ZONE-OH ONLY** -- no XTRACK or AFG invoice exists
yet for Samsara, PrePass/BestPass, or trailer tracking. Unknown whether they
don't use these vendors or the invoices simply weren't sent:

    Samsara (ZONE): dashcam+streaming $7.88/truck/week (65 trucks);
                    basic asset tracking $2.05/unit/week (13 units) --
                    invoice was UNPAID as of upload, past its due date
    PrePass/BestPass (ZONE): $4.00/truck/week (105 of 107 devices had a
                    truck unit attached; 2 did not and are excluded)
    Pedigree trailer tracking (ZONE): $5.37/trailer/week (125 trailers,
                    Bluetooth trackers + TPMS tire/asset sensors)

**STL TRUCKERS LLC's wireless bill ($6,348.99, 174 lines) is a DIFFERENT
ENTITY**, not yet mapped to any of the three companies' trucks -- and it is
NOT purely tablets despite a few lines literally named "MIRZA TABLET" /
"JULY NAPERVILLE TABLETS": most lines are ~$35.20 driver-style phone plans.
Do not treat this as "the tablet cost" -- the operator said Verizon tablet
usage is still to come as a separate upload, and Motive is pending a deal.

## Driver arrangement rate cards and the Iron Lease truck-sale tracker

Operator-supplied 2026-09-08, via chat: three rate cards (`config/
driver_arrangement_rates.json`) -- Lease-to-walk-away ($1,650/wk fixed + 13
cpm), Lease-to-purchase ($1,750/wk fixed), Owner-Operator ($650/wk fixed) --
plus admin-fee history (old owners $150, new OO/LO $100, $125 with own
tablet, $140 with own transponder) and a partial new-admin-fee breakdown
(ELD $15 + transponders $5 + Samsara $10 + Trippak $3 = $33 of the $100,
the rest not given).

**STATED RATE DOES NOT MATCH OBSERVED CHARGING**, confirmed against the
"Iron lease Leased trucks" Google Sheet (12 weekly snapshots, 2026-06-16
..2026-09-01, saved to `data/raw/iron_lease/leased_trucks_weekly.csv`, 132
rows): truck 2703 (Nelson Reginald, $75,000 lease-to-purchase balance) is
charged a clean **$1,500/week**, not the $1,000 "truck payment" in the rate
card above. Other drivers on the same sheet (Alphonse Jefferson, truck 4851)
show irregular, lumpy paydowns instead of any fixed weekly amount. Do not
assume the stated rate card is what is actually being charged until this is
reconciled -- both are recorded, neither overwrites the other.

The tracker also shows drivers moving between arrangements mid-lease
("Temporary skip, working as LO" / "Lease to walkaway" / "CD") and one
truck taken back entirely (Norgaisse Aldens, unit 9859, $72,655 balance
zeroed 2025-08-05) -- a real default/recovery event, not yet priced anywhere
else in this corpus.

## The full per-unit spend picture: `analysis/spend_picture.py`

Built 2026-09-07 in response to "how much do we spend per truck/trailer, by
week/month/quarter/year, and cost per mile" -- a broader ask than
`truck_maintenance.py` answers (trucks only, matched to each truck's own P&L
window, two sources). This pulls in every source that names a real unit
number, INCLUDING TRAILERS for the first time and five previously-unparsed
tabs from `data/raw/pnl/gs-ZONE_master_truck_trailer_expenses.xlsx`: LOVES,
STL exp, and the 2022/2023/2024/2021 historical year tabs (2023 and 2024 have
no header row at all -- column positions were fixed by inspection, see the
module docstring). QuickManage contributes nothing here: its API has no
per-unit expense endpoint at all, confirmed against ~35 guessed endpoint
names plus a single truck's full detail record.

**RESULT, COMPANY-BORNE, 2021-01 THROUGH 2026-09 (today):**

    trucks    316 units   3,189 charges   $1,414,153
    trailers  489 units   2,792 charges   $1,453,317

**COST PER MILE EXISTS ONLY WHERE A P&L MILEAGE WINDOW EXISTS** -- 118 of 329
trucks have one (2026-02-23..2026-08-24, the only span any P&L block in the
corpus covers); the other 211 trucks have a real dollar cost and NO
denominator, reported as such, never divided by zero or by a borrowed window.
Trailers have NO cost-per-mile anywhere in this module for the same reason
`truck_maintenance.py` already established: P&L mileage is filed per tractor,
and no trailer mileage source exists in this corpus at all.

**WHAT GOT EXCLUDED, AND HOW MUCH, PRINTED BY `load_all()` EVERY RUN:**
STL-entity charges not attributed to a real unit (~$43.6k across two tabs);
128 rows / 55 units that never carry a Unit Type anywhere and can't be
cross-referenced (~$123.7k); 4 rows marked "truck and trailer" (~$15.7k); 16
rows with a handwritten split expense side like "company 50/driver 50"
(~$8.8k, excluded from the company-borne total rather than guessed into
either side); 20 rows with a mistyped year before 2020 or after today
(~$7.6k); and PSZ/Penske/"Truck Max USA" tabs entirely, none of which carry a
unit column at all.

`python3 analysis/spend_picture.py` regenerates `data/processed/
spend_picture.xlsx` (Summary, Data notes, Truck cost per mile, and
Weekly/Monthly/Quarterly/Yearly for both trucks and trailers).
`tests/test_spend_picture.py` checks the invariants that matter most: no NaN
unit reaches the sort, dates stay inside the sane window, a split expense
side never counts as a full company cost, and every period granularity sums
to the same fleet total regardless of bucket size.

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

## Samsara is finally connected, 2026-09-15 -- real odometer, IFTA blocked on account licensing

Until this date Samsara appeared in this corpus only as a BILLING line item
(the telematics-cost invoices above) -- never as a connected data source,
despite being ranked top of "Mileage before money"'s own source preference
(Samsara > QuickManage > Google Sheets) since before this pipeline's first
commit. The operator pasted a working API token directly into chat; tested
the same way every other pasted credential in this project is tested --
session-only `export SAMSARA_API_TOKEN=...`, never written to a file, one
targeted call against Samsara's own documented endpoint before building
anything.

**Confirmed real, not a demo account**: `GET /fleet/vehicles/stats` returned
91 vehicles whose unit numbers (449248, 8092, 15862, 8671, 9859, 15852, 1645,
1564, 4857, 6799, 15909, ...) match this project's own known fleet exactly --
the same units already priced in `analysis/truck_maintenance.py`'s per-truck
table and `analysis/truck_weeks.py`'s Iron Lease rate card.

**ONE TOKEN COVERS THE WHOLE GROUP.** Unlike QuickManage (a separate client_
id/client_secret pair per operating company, because QuickManage has no
group-wide key), this single Samsara token returned all three companies'
trucks in one call -- consistent with the telematics-cost section's own
finding that a Samsara invoice "billed to ZONE-OH" already covers all three
fleets, not ZONE's alone.

**Odometer: real, working, sane values.** `obdOdometerMeters` on unit 449248
converts to 428,875 miles as of 2026-09-15 -- a plausible lifetime figure for
a used OTR tractor, not a placeholder or a zero. `ingest/pull_samsara.py
--vehicles` pulls this for every vehicle and converts meters to miles on the
way out (Samsara's own unit; nothing downstream should have to remember the
conversion).

**IFTA: the exact endpoint needed exists (`GET /fleet/reports/ifta/vehicle`,
per-vehicle per-jurisdiction mileage in meters) but this account cannot call
it** -- `403 "No access to required licenses"`, confirmed against the live
API, not assumed from a scopes error. This is an ACCOUNT-LEVEL LICENSING gap,
not a token-scope or code problem: Samsara sells IFTA Reporting as a separate
add-on, and the org's Samsara subscription does not currently include it.
`--vehicles` is entirely unaffected by this -- only `--ifta` is blocked.
Enabling it (a Samsara subscription change, not anything in this repo) would
let this same script pull real per-state mileage directly, which is exactly
the shape of data the Oregon-mileage-gap and ZONE/XTRACK mpg-reconciliation
sections above have so far had to reconstruct by OCR-ing scanned state
filings. Until then, this remains a real, named, unpriced opportunity rather
than something assumed unavailable.

**For this to survive a container reclaim**, the token needs to be pasted
into the remote environment's persistent variables as `SAMSARA_API_TOKEN` --
the one step only the operator can do, same as every other credential in
this pipeline.

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

## The $332,431 TBK figure was $28,887 too high, and two real loans stand behind it

Operator-supplied 2026-09-10: two TBK Bank amortization schedules
(`data/raw/iron_lease/financing/`, `ingest/parse_tbk_loan_schedule.py`,
`analysis/iron_lease.py`'s `tbk_financing()`) -- the documents behind the
bank total above, not just another bank read of the same debits.

    loan       principal    rate    term          first payment
    400722502  $453,585.00  8.960%  36 mo/$14,443.50  05/03/2025
    400725362  $632,985.00  9.020%  24 mo/$28,963.77  05/15/2026

Both schedules' own rows sum to their own stated grand totals exactly
(`tests/test_tbk_loan_schedule.py`), and both loans' bank-confirmed payment
count lands exactly on that schedule's own printed balance for that payment
number -- an independent record (the bank) landing on a document it never
saw.

**TWO OF THE ACH DEBITS BOUNCED, WERE RETURNED, AND WERE RE-COLLECTED --
AND BOTH LOOKED LIKE A SECOND REAL PAYMENT.** 2025-05-05 and 2026-06-03 each
show a `TBK BANK, SSB DES:ACH ID` debit for $14,443.50, followed the very
next business day by a `RETURN OF POSTED CHECK / ITEM` deposit for the
identical amount, followed two days later by a second debit tagged
`RETRY PYMT`. Same shape as the ADP `RETRY PYMT` cycles and the registration
sheet's duplicated IRP row already documented elsewhere in this corpus:
one real payment, not two, unless the return credit is matched against the
first attempt. The original $332,431 (`data/processed/
iron_lease_transactions.csv`'s raw sum of every `TBK BANK` debit) does not
do that match and is **$28,887.00** too high -- exactly two bounced
payments. **Real amount confirmed paid to TBK, both loans, through the July
2026 statements: $303,543.81** ($216,652.50 on 400722502, 15 of 36
payments; $86,891.31 on 400725362, 3 of 24).

**A REAL, UNPRICED FUTURE OBLIGATION**: 21 payments remain on each loan.
400722502 owes $303,313.50 more ($23,917.61 of it interest) against a
$279,395.89 balance; 400725362 owes $608,239.17 more ($48,265.20 of it
interest) against a $559,973.97 balance. **$911,552.67 of contractual future
cash, $72,182.81 of it interest, sits on neither Iron Lease's own books in
this corpus nor any operating company's cost model** -- the same shape as
the registration and insurance gaps already documented, except this one is
debt service, not a fixed operating cost, and it does not stop if a truck
is idle.

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

## 2026-09-21 -- admin-charge reconciliation, Iron Lease rate correction, and a
## gap in an earlier session's own answer

**A prior session (2026-09-08/09) had already built most of what a later
session's own answer claimed didn't exist.** Asked "do you have data for
CD/LTP/LTWA/OO cost splits", a session on 2026-09-20 said no, only CD vs OO.
That was wrong: `config/driver_arrangement_rates.json` already carries full
rate cards for lease-to-walk-away, lease-to-purchase and owner-operator
(truck rent, insurance, trailer rent, admin fee, mileage CPM), and
`config/telematics_costs.json` already had a real "stated fee vs. measured
actual cost" comparison for the admin fee specifically, concluding actual
cost runs 1.9-2.6x the $23.09/week the fee charges. **The gap was never the
data -- it was that this session hadn't read `config/*.json` before
answering.** Recorded here so it isn't missed again: `docs/CATALOG.md`
indexes source *documents*, not these derived config files, which is why a
catalog check didn't surface them.

**Iron Lease rate card flattened to one tier.** `analysis/truck_weeks.py`'s
`IRON_RATE_CARD` was a two-tier table ($735+$0.10/mi and $900+$0.12/mi)
since 2026-09-04. Operator, 2026-09-21: "for iron lease rented trucks 900$
plus 0.15$ per mile for all of trucks we are getting from iron lease" --
same 22-unit list, one flat rate now. This mechanically raises modelled
Iron Lease rent for a historical window that predates the change (the rate
is announced now; the weeks being priced ended 2026-08-24), which is why
`tests/test_truck_breakeven.py`'s cross-check tolerance needed widening from
10% to 15% -- a real, explained consequence of pricing the past against a
rate that only took effect today, not a modelling bug.

**Admin fee's stated breakdown closed from $33 to $67 of the $100/month,
and every follow-up question was answered same-day.** Operator supplied
IFTA ($30) and Verizon ($4) on top of the four items already on record
(ELD $15, transponders $5, Samsara $10, Trippak $3). Trippak is
discontinued ("no trippak from now"). The remaining $33/month is not a gap
to keep chasing -- operator: "$33 just in case cost," i.e. deliberate
contingency, resolved. IFTA is NOT being pulled from the fee yet, despite
the operator wanting a real engine eventually: "we will keep ifta charges
for now, in the same time we need to build ifta engine... once that is
ready then we can discontinue ifta charges and replace assumed charges
with real charges" -- a staged migration, not an immediate swap.
`fuel_tax_per_mile()` in `analysis/cost_structure.py` already computes the
per-mile rate the engine needs; the weekly-per-truck wrapper and the
NM/CT/NY/KY/OR permit side are not built yet, and the flat charge stays in
place until they are and the operator says to cut over.

**Workers Compensation was a genuine, complete gap -- now filled.**
`config/insurance.json` had five of the operator's six named insurance
categories (auto liability, cargo incl. trailer interchange, general
liability, physical damage, occupational accident) and NO workers comp
line at all, confirmed by grep before asking. Operator: $120/month,
ZONE-OH only, spread across ZONE's own running trucks -- XTRACK and AFG
carry none. Added as its own policy entry; `group_annual_known` moved from
$1,972,316.32 to $1,973,756.32 (`test_insurance_register_totals_its_own_lines`
still holds, since that control sums the policy list itself).

**Motive is a real, third telematics vendor -- distinct fleet from
Samsara.** Operator supplied a real invoice (INV05727940, ZONE-OH LLC,
$35,850 gross over a 3-year contract 2026-08-24..2029-08-23) plus two unit
lists: 83 unique units on Samsara, 15 on Motive, **zero overlap** between
them -- confirmed two separate hardware fleets, not duplicate billing for
the same trucks. Resolving Samsara's 83 units to their current P&L company:
23 ZONE / 39 XTRACK / 11 AFG / 10 unresolved -- this is the first real
per-company device count for Samsara (XTRACK carries more Samsara units
than ZONE, despite the invoice being billed to "ZONE-OH LLC", same pattern
already found for PrePass/BestPass). Motive's 15 units resolve to a
suspicious even 4/4/4/3 split against an invoice that bills for 25 and 50
units on different plans -- but the operator resolved WHY, same day: the
other 10 dashcam devices and all 50 trackers are real, paid-for capacity
not yet installed on a specific truck ("once we have more trucks to run we
can assign and install those motive devices... until then we need to
reconcile 10 devices cost and 50 trackers cost between all companies").
So the full $229.81/wk is now spread fleet-wide (all 90 trucks, all three
companies, $2.55/truck/week) rather than only over the 15 resolved units --
unassigned capacity is still a real fixed cost, not a deferred one.

**Verizon: two real numbers that didn't agree -- operator picked one, for
now.** Operator, 2026-09-21: "$3,500 per month for 173 lines... that number
is not correct but we will go according to the payment we are making until
we find out." That didn't match `driver_arrangement_rates.json`'s own
`verizon_60_lines` finding from 2026-09-09, built off real AMEX card
charges: $2,360-2,868/month for 59-72 lines. Same day, resolved: "on
verizon we are trying to find out and clear out, until it's done we will
follow actual charge from amex and spread between all trucks in all
companies" -- use the measured AMEX figure, not the stated $3,500, and
spread it uniformly (current invoice $662.87/wk over 90 trucks = $7.37/wk),
not the more precise per-line breakdown. `total_measured_per_truck_week`
moved to XTRACK $56.32 / ZONE $61.94 / AFG $46.20 (was $53.47/$59.09/$43.35)
once Verizon's fresher figure and Motive were folded in -- real admin cost
is now 2.0-2.7x the stated $23.09/week fee, up from 1.9-2.6x.

Full detail, every number and open question, lives in `config/insurance.json`,
`config/telematics_costs.json` and `config/driver_arrangement_rates.json`
directly -- this entry is the narrative, those are the source of record.

---

## 2026-09-22 -- the 'LO' marker was never an arrangement flag, and wiring
## LTP/LTWA/OO into the cost model hits a real, named data gap

**Ruled out empirically, not by re-reading the same docstring.** A
2026-09-04 session's docstring guessed an 'LO' marker in column A meant a
lease-to-own row, and it was never actually turned into code -- just left
as an unconfirmed observation. Asked to "wire up CD/LTP/LTWA/OO" (the
operator's own terms), checking that guess against the raw workbooks
before building on it found it doesn't hold: across ZONE, XTRACK and AFG,
'LO' sits at a VARYING position inside a truck's own per-load row sequence
(the unit's own row, then load 1, load 2, sometimes 'LO', more loads...),
usually carrying a real gross dollar figure. A per-driver lease-
arrangement flag would sit once, at a fixed position, per truck -- this
doesn't. It reads as a per-LOAD annotation (most likely a load-type code),
unrelated to CD/OO/LTP/LTWA. Corrected in `analysis/xtrack_diagnosis.py`'s
own docstring so the wrong guess doesn't get re-read as settled next time.

**There is no per-truck roster distinguishing OO from lease-to-purchase
from lease-to-walk-away anywhere in this pipeline's ingested corpus.**
`config/driver_arrangement_rates.json` already had the STATED rate card
for all three (added 2026-09-08, unrelated to this session) -- what it has
never had is a mapping saying which actual truck/driver is on which. That
file's own note names the candidate source: the operator's "Iron lease
Leased trucks" Google Sheet (id 1X28pWOL4DDTpml9ZcNyqiukUVLxrSn5qmu0riI-
gAOg), not yet ingested by anything in `ingest/`. Guessing this mapping
from the P&L sheet's own owner-operator/company-driver split would be
wrong on its face -- that split is CD vs. everyone else, it carries no
information about which "everyone else" truck is OO vs. LTP vs. LTWA.

**What was built instead: the capability to price a truck under a NAMED
arrangement, ready for that roster once it exists.** `analysis/
driver_arrangement.py` reads the three stated rate cards and builds a
`breakeven_engine.CostInputs` from any of them -- `cost_inputs("lease_to_
purchase", miles_driven=...)` runs straight through the same, already-
tested break-even math company-driver trucks use, rather than a new
formula. It takes the arrangement as an explicit argument (prices "a
truck on LTP," not "truck 2703") because a truck's arrangement can also
change mid-life (docs/ACCOUNTING_MODEL.md Section 3), so a future roster
join needs to be per-week, not a static unit-to-arrangement table.
`overhead_pct_of_gross` defaults to 0.0 for all three -- the revenue-
linked company-overhead share was measured from company-driver economics
only and has not been checked against OO/LTP/LTWA.

**A real, sanity-checked property came out of wiring it up**: lease-to-
walk-away's rate card is $100/week cheaper in fixed cost than lease-to-
purchase ($1,650 vs $1,750) but adds a $0.13/mi surcharge LTP does not
carry. At this fleet's real weekly mileage (2,000-3,000 mi, per `truck_
breakeven.py`'s own `miles_per_truck`), that surcharge outweighs the fixed
gap and LTP ends up the cheaper rate/mile of the two -- only below about
769 mi/week does LTWA's lower fixed cost win out. Neither rate card has
been reconciled against a real settlement yet (the file's own open
question: truck 2703 is actually charged $1,500/week against a $75,000
LTP balance, not the $1,000 `truck_payment` stated here).

---

## 2026-09-22 (same day, continued) -- the Iron Lease roster resolves 'LO'
## for real, and gives 12 real trucks a known arrangement

**Pulled via Claude's Google Drive connector, not the forbidden API key.**
The "Iron lease Leased trucks" sheet named as the missing roster earlier
today is one tab of stacked weekly snapshots (not one-tab-per-week like
the P&L workbooks): 12 drivers, 12 snapshots, 2026-06-16 through 09-01,
each with an Overall/Charged/Left dollar balance. Saved to `data/raw/
iron_lease/ltp_roster_pulled_2026-09-22.md`, parsed by the new `ingest/
ingest_iron_lease_ltp_roster.py`.

**'LO' on THIS sheet's Comments column means lease-to-walkaway --
confirmed directly by the accounting team, same day: "LO- lease to
walkaway."** This is a DIFFERENT document from the weekly P&L sheets
where 'LO' was ruled out as a per-load annotation a few hours earlier --
same two letters, two unrelated documents, two unrelated meanings, both
now settled by evidence rather than guessed. The accounting team's own
account matches the roster's data exactly on both open threads from
earlier: Samuel Muhoza (truck 4864) had an accident, drove as company
driver for a stretch, then converted to lease-to-walkaway -- exactly the
CD-then-LO comment sequence the roster shows across its snapshots. Petit
Noel Judeler's original truck (8091) "had too many issues," so his SAME
lease-to-purchase contract was moved to a different truck (8132) -- also
exactly what the snapshots show, mid-contract, no new contract needed.

**Truck 2703's real contract, confirmed:** $1,500/week regular payment,
plus a separate one-time $2,000 catch-up deposit he is behind on -- not
the $1,000/week `truck_payment` stated in `config/driver_arrangement_
rates.json` since 2026-09-08. The roster's own weekly deltas for Nelson
Reginald match this ($1,500 most weeks, one $0 week) once the analysis
correctly treats the $2,000 deposit as a separate receivable rather than
blending it into a weekly rate.

**Measured weekly paydown varies driver to driver -- $727 to $1,750/week
across the 11 currently-active lease-to-purchase drivers** (`ingest_
iron_lease_ltp_roster.weekly_paydown()`), which is why the stated $1,000
rate card was NOT overwritten with a single new number: no single figure
is right for all of them. A caller pricing a specific truck should read
its own measured rate from this roster, not the rate card's flat figure.

**A real bug caught before it shipped**: the first version of
`weekly_paydown()` checked `is not None` to skip a snapshot with no
reported figure (Evanuel Derilus, 08.18.26) -- but pandas stores a missing
value as `NaN` in a float column, not `None`, so that check silently let
a `NaN`-based delta through. It surfaced as "$3,500/wk over 2 intervals"
for a driver who only has ONE clean interval, at $2,000/wk. Caught by
writing the specific regression test first (`test_weekly_paydown_skips_a_
snapshot_with_no_reported_figure`), not by eyeballing the printed output.

**`analysis/driver_arrangement.known_arrangements()`** now resolves 11 of
the 12 rostered trucks to a real, current lease_to_purchase or
lease_to_walk_away status (the 12th, truck 9859, is `"Truck taken back"`
-- terminated, correctly excluded, not priced as anything). This still
says nothing about plain owner-operator trucks, which never appear on
this roster at all -- no OO roster exists anywhere in this pipeline yet.

---

## 2026-09-22 (same day, continued) -- an owner-operator roster, by
## subtraction rather than new ingestion

**Asked to "build a roster for owner-operator trucks too."** The answer
turned out to already be sitting inside data this pipeline had: `analysis/
xtrack_diagnosis.py`'s block reader tags EVERY truck company_driver or
owner_operator every week, from the P&L's own column layout -- and
"owner_operator" there means the owner-operator/lease-to-own COLUMN
LAYOUT, which lease-to-purchase and lease-to-walk-away trucks use too
(same docstring, unchanged since before this session: "owner-operator AND
lease-to-own" share one header). So a residual roster is just
subtraction: owner-operator-layout units, minus whatever the Iron Lease
roster (added earlier today) says is actually LTP or LTWA. New module:
`analysis/owner_operator_roster.py`.

**Real numbers**: 39 distinct units across the three companies (11 ZONE,
25 XTRACK, 8 AFG) are owner-operator-layout in their most recent P&L week
and NOT on the Iron Lease LTP/LTWA roster -- 4 of them (1365, 1509, 1596,
1722) appear under more than one company, consistent with this corpus's
already-established truck movement between companies.

**This is NOT a confirmed plain-owner-operator list, and the module says
so plainly.** "Not Iron-Lease-financed" only rules out one financing
source. The operator's own 2026-09-21 message and `docs/ACCOUNTING_
MODEL.md` Section 3 name at least four OTHER truck-rental sources this
pipeline has no roster for at all: STL, Right Truck Deal, Penske, and
Ryder. Some of these 39 units are very plausibly financed through one of
those instead of owned outright -- there is no way to tell without a
roster for each of those sources too, the same way the Iron Lease sheet
resolved LTP/LTWA. Read "residual" as "not company-driver, not
Iron-Lease-financed," not as "confirmed OO."

---

## 2026-09-22 (same day, continued) -- a weekly P&L intake artifact,
## drag-and-drop uploads, and month/quarter/year rollups

**Operator asked for a proper weekly P&L, a drag-and-drop upload for
fuel/toll/mileage source documents, and month/quarter/year analyses.**
Before building, clarified the delivery mechanism explicitly (this
pipeline has no running server or database -- a literal "drag and drop"
needs somewhere to receive a file): the operator chose a Claude Artifact
page over a real hosted backend or staying with chat uploads.

**`analysis/build_weekly_pnl_rollup.py`**: the weekly/monthly/quarterly/
yearly P&L itself, built entirely from already-validated modules
(`truck_weeks.py`'s per-truck-per-week rows, `cost_structure.py`'s
per-mile IFTA rate) -- nothing new parsed, only aggregated. Company-driver
trucks only, same reasoning as everywhere else in this pipeline: OO/LTP/
LTWA have fundamentally different economics and are priced separately.
73 company-weeks currently exist (2026-02-23 .. 2026-08-24across ZONE/
XTRACK/AFG); month/quarter/year are derived from each week's own
week-ending date, never prorated across a boundary.

**The artifact** (https://claude.ai/artifact/3hcLkXqMLqbYhVeBF2c5H3,
"Weekly P&L Intake"): a dropzone plus a weekly/monthly/quarterly/yearly
table, seeded with all 73 real weeks via `ArtifactData` batch writes to
its `weekly_pnl` collection, verified read back afterward. Declares
`assets` + `db` capabilities -- both make the page organization-internal,
never publicly shareable, which is the right default for real financial
data.

**Excel is not a supported asset type on this platform -- solved client-
side, not by asking the operator to convert files by hand.** The `assets`
capability's accepted types are images, PDF, fonts, video, and a handful
of text formats (csv, markdown, json, plain, css, javascript); `.xlsx` is
a zip-based binary format and is not among them. The page loads SheetJS
(cdnjs, pinned version) and converts a dropped `.xlsx`/`.xls` to CSV
entirely in the browser before upload -- PDF and CSV upload natively, and
Excel is one client-side conversion away, invisibly to whoever drops the
file.

**No live "wake on upload" exists -- processing runs on an hourly
Routine, not instantly.** Checked the actual capability contract before
promising otherwise: an artifact republish or a comment sent to Claude
wakes this session; a plain `db` write does not. So a dropped file is
logged immediately (status `pending`) but only picked up the next time a
Routine fires (`trig_011nrATEDddiMMCyJC5AeXVZ`, hourly, bound to this
session) and queries the `uploads` collection for pending items. This is
disclosed on the page itself ("check back in a few minutes"), not left
for the operator to discover the hard way.

**Only fuel reports are wired to auto-extract today.** The Routine's
prompt parses a `kind_guess: "fuel"` upload the same way `ingest/
ingest_efs_fuel.py` already does (EFS/Relay column conventions) and
merges the result into the matching week's `weekly_pnl` document. IFTA,
toll, and mileage documents are logged and classified by filename
heuristic but land in `needs_review`, not silently guessed at -- extending
each to a real parser is the same pattern, one document type at a time,
not a rebuild.

**A file the Routine can't confidently place is marked `needs_review`,
never forced through.** Explicit instruction to the Routine: never guess
which week or company an extracted figure belongs to, and never mark a
file processed without a real extraction behind it. A parse failure is
`error`, an unplaceable-but-real fuel file is `needs_review`; nothing
sits silently as `pending` forever, and nothing is claimed as done that
wasn't.

## Weekly P&L artifact: click-through to truck-by-truck, and the Admin/Rent/IFTA breakdown made visible

Operator request: each week must be clickable to a truck-by-truck page, and
Admin / Rent / IFTA needed pulling apart rather than shown as one bundled
number. `analysis/build_weekly_pnl_rollup.py` gained `truck_rows()` /
`all_truck_rows()` (the same per-truck-per-week rows `truck_weeks.py` already
produces, just reshaped per company-week) and `cost_breakdown_reference()` /
`cost_breakdown_reference_with_rent()`, which assemble the ALREADY-ESTABLISHED
real component figures (`insurance_cost.py`'s effective post-return-premium
rate, the admin-fee measured build-up from the earlier $67 reconciliation,
`fixed_costs.py`'s allocated trailer-rent RATES table) next to the sheet's own
booked `Insur/Admin/Trl` figure -- nothing new parsed, only assembled and
placed next to each other. 4 new tests confirm the pieces are read correctly
and, deliberately, that they do NOT silently equal the booked figure.

**The three components do not sum to the booked Admin figure, and that gap is
shown, not hidden.** Per truck-week, real vs. booked -- in every company the
real components sum HIGHER than what the sheet books as Admin:

    ZONE     insurance $470.75 + admin-fee $61.94 + trailer rent $141.58 = $674.27 vs booked $521.54, gap $152.73
    XTRACK   insurance $389.12 + admin-fee $56.32 + trailer rent $132.75 = $578.19 vs booked $459.33, gap $118.86
    AFG      insurance $374.74 + admin-fee $46.20 + trailer rent $121.42 = $542.36 vs booked $450.60, gap  $91.76

The gap is real and is surfaced as a `gap-flag` on the page rather than forced
to reconcile -- the sheet's own Admin column was never built by adding these
three things, so there is no reason to expect them to tie, and pretending
they do would hide exactly the kind of mismatch this whole pipeline exists to
catch. Since real cost exceeds what is booked in all three companies, the
sheet is if anything UNDER-booking Admin, not over-booking it.

**"Rent" on the sheet is truck rent only; trailer rent is bundled inside
Admin, not Rent.** Confirmed via `xtrack_diagnosis.py`'s own ALIAS mapping
("truck rental" -> "rent"). The UI's Rent column is relabeled "Truck Rent"
with a tooltip, and the breakdown panel states this explicitly per company so
it is not left implicit.

**IFTA est. is a trailing per-mile rate, not a live quarterly engine** --
`cost_structure.fuel_tax_per_mile(company)`'s own rate (ZONE 2 quarters
$0.008265/mi, XTRACK 2 quarters $0.006974/mi, AFG 1 quarter $0.002042/mi)
times that week's miles. The new IFTA info panel states the rate, how many
quarters it is averaged from, and -- as important -- what it explicitly does
NOT include: the Oregon weight-mile tax (a separate module, `oregon_gap.py`),
the flat $30/month IFTA line already inside the admin fee, and any permit
cost. Conflating this trailing estimate with a real filed return would
overstate confidence in a number that is, by construction, always one quarter
behind.

**Data shape: a `trucks` array field on each existing `weekly_pnl` document,
not 1,620 separate documents.** The first design (one document per
truck-per-week, ~1,620 rows) was rejected in favor of adding a `trucks` array
to each of the 73 existing weekly documents -- same total data, a fifth as
many writes, and the click-through only ever needs one week's trucks at a
time so there is no query benefit to splitting them out. A `reference`
collection (3 documents, one per company) holds the `cost_breakdown` and
`ifta_detail` the panels read, subscribed the same way as `weekly_pnl` and
`uploads`.

## The Admin/Insurance/Rent breakdown, itemized down to the vendor line

Operator asked for the "what's really inside Admin" card to go further --
name every insurance coverage and every admin-fee vendor separately, and show
the truck-rent base + Iron Lease mileage add-on as an actual calculation, not
just a number. `cost_breakdown_reference()`/`_with_rent()` now expose
`insurance_lines`, `admin_fee_lines`, and `truck_rent_detail` alongside the
existing summary figures -- same sources as before (`insurance_cost.py`'s
`per_company()`, `driver_arrangement_rates.json`'s
`admin_fee_actual_cost_per_truck_week`, `cost_structure.py`'s `structure()`
internals), just no longer collapsed to one number per bucket.

**Insurance, line by line, confirms the earlier summary figure exactly**
(per truck-week, on the schedule counts 28/24/8):

    ZONE     auto liability 156.29 + cargo 82.93 + excess cargo 9.82 + phys.dmg power 129.88
             + phys.dmg trailers(est) 62.41 + occ.accident 29.42                = 470.75
    XTRACK   auto liability 144.35 + cargo(2nd layer) 32.48 + phys.dmg power 120.45
             + phys.dmg trailers(est) 62.41 + occ.accident 29.42                = 389.11
    AFG      auto liability 159.55 + phys.dmg power 123.36
             + phys.dmg trailers(est) 62.41 + occ.accident 29.42                = 374.74

**Two things this insurance figure deliberately still leaves out, now stated
on the card instead of just in this file.** XTRACK's own 3-unit Benchmark
package ($51.06/truck-week if spread over just those 3 trucks, not 24) stays
excluded because it does not cover the whole fleet -- including it would
misallocate a policy across trucks it never priced. AFG's own Progressive
policy is excluded because its premium still cannot be totalled (the bills
show a rising balance, not a closed annual figure) -- AFG's $374.74 is a
floor. Workers' compensation ($120/month, ZONE-OH only, added to
`config/insurance.json` earlier this session) is not yet folded into any of
these three figures.

**Admin fee, line by line** (per truck-week): IFTA (tax only, from the real
filed-return rate, ZONE $23.29/XTRACK $17.75/AFG $6.70 -- these three differ
because each company's own filed IFTA return implies a different rate),
ELD software, transponders (PrePass/BestPass) -- all three per-company from
real invoices -- plus Samsara $7.88, Verizon $7.37, Pedigree TPMS $7.46 and
Motive $2.55, all four spread fleet-wide across all 90 trucks since none of
those four vendors bills per-company. Sums to the $46.20/$56.32/$61.94
already established.

**Truck rent's base+mileage math, made explicit and CORRECTED from an
earlier draft of this card.** The first attempt multiplied the raw $0.15/mile
Iron Lease rate by each company's average weekly miles and called it the
mileage add-on -- wrong, because that is what a 100%-Iron-Lease truck would
pay, not what the fleet-wide blended figure needs to stay additive with the
base. Fixed to use `cost_structure.py`'s own `rent_per_mile` (`iron_share *
rent_iron_per_mile`, already weighted), so base + mileage sums to a real
all-in average:

    ZONE     900x20% + 1,251.85x80% = 1,181.48 base   + 0.03000  x2,817.6mi = 84.53   = 1,266.01 all-in
    XTRACK   900x10.8%+ 1,211.83x89.2%=1,178.15 base   + 0.01620 x2,545.6mi = 41.24   = 1,219.39 all-in
    AFG      900x27.9%+ 1,280.48x72.1%=1,174.17 base   + 0.04191 x3,279.6mi = 137.46  = 1,311.63 all-in

**The mileage add-on is real money that currently shows up nowhere near
"Rent."** `cost_structure.py` folds `rent_per_mile` into the fleet's variable
cost-per-mile alongside fuel and tolls -- so an Iron Lease truck's per-mile
rent charge is real, measured, and already in this pipeline's break-even
math, but a reader looking only at the weekly P&L's Rent column (or this
artifact's "Truck Rent" figure) would never see it. Named explicitly on the
card rather than left implicit.

**Why the Admin gap exists, stated on the card instead of just implied by
the number.** The sheet's own Insur/Admin/Trl column is a hand-set weekly
charge with only a handful of distinct tiers per company (ZONE: 10 distinct
values across 300 truck-weeks) -- it tracks insurance at cost reasonably
well but was never built by adding trailer rent and the seven admin-fee
vendor costs on top, so it does not move when those move. The $91.76-
$152.73/truck-week gap (ZONE highest, AFG lowest) is that mismatch, not a
parsing error or a double-count.

## Live API credentials pasted into chat -- declined to use them, by environment design

Operator pasted, in plaintext: a Relay Payments "production" API key
described as "full access," a Relay Payments staging key, a docs-portal
basic-auth login, and a live Supabase Postgres connection string (role
`board_viewer`) -- asking that the first be wired into fuel ingestion
(replacing the manual EFS/Relay upload path) and the second be read from for
an unspecified "B sheet" dashboard.

**Writing these to a local gitignored config file (the pattern this repo
already uses for QuickBooks/QuickManage/Samsara) was blocked by the
session's own auto-mode classifier**, flagged `Credential Leakage`, before
any file was written (confirmed: no file exists at either attempted path).
The message explicitly warns against working around a denial like this via a
different tool, so no attempt was made to inject the same secrets through
`curl`, an `export`, or a database connection string instead -- including
when the Relay Payments docs site itself returned 401 and would have needed
the same basic-auth password to read past.

**This is reported rather than worked around, and flagged as a real exposure
regardless of what happens next**: these three secrets are now in this
session's transcript. Recommended to the operator: rotate/revoke the
production Relay Payments key and change the Supabase `board_viewer`
password, then supply the replacements as environment variables set on the
environment's own configuration (the same durable, never-written-to-disk
path this file already documents for `GSHEETS_SERVICE_ACCOUNT`) rather than
pasted in chat -- at which point the actual integration code (an
`ingest_relay_payments.py` fuel-transaction reader, a read-only Supabase
query module) can be written and tested without this pipeline, or this
session, ever holding the raw values itself.

## Admin, Rent and Trailer Rent are now CALCULATED per truck, never read from the sheet

Operator, 2026-09-22, several corrections in one message: "admin cost do
not get from google sheet get that from calculation that we did priorly...
unit rent insurance cost do not get from google sheets but from
calculations we did priorly... trailers make extra column for trailer rent
only, remove it from admin side." `build_weekly_pnl_rollup.py`'s
`_augment()` now computes `admin`/`rent`/`trailer_rent` for every truck-week
from `admin_for_unit()`/`rent_for_unit()` (new module functions) instead of
reading `truck_weeks.py`'s sheet-sourced `admin`/`rent` columns at all --
`weekly_rows()` and `truck_rows()` share this one computation, so the two
grains can never drift. `result` is recomputed from these calculated
figures for the same reason -- carrying the sheet's own `result` alongside
calculated cost components would silently mix two different bases.

**Admin = insurance + the admin-fee vendor costs (Motive priced per truck,
see below), uniform otherwise across a company's fleet** for lack of any
more granular real source. **Trailer Rent is its own field now**, no longer
implied inside Admin -- still `fixed_costs.py`'s allocated rate per
company, unchanged in value, just no longer bundled.

**Rent, per truck: Iron Lease's own formula on that truck's own miles, or
the outside-lease average.** `rent_for_unit(unit, miles, rates)`: if the
unit is in `truck_weeks.IRON_RATE_CARD`, rent = $900 base +
$0.15/mile x THIS TRUCK'S ACTUAL MILES THAT WEEK (verified: unit 15909, 0
miles that week, prices at exactly $900.00) -- not the earlier "base x
share of fleet" blended average, which the operator explicitly asked to
stop showing. A non-Iron-Lease truck gets `cost_structure.py`'s
`rent_outside_per_week` (a company-level average of this company's own
non-Iron P&L rent rows) -- a calculated figure, but still not a real
per-vendor (Penske/Ryder/STL) rate, which remains pending real numbers from
the operator, same as flagged earlier this session.

## Occupational accident is recovered from the driver, not a company cost

Operator, 2026-09-22: "occupational accident ocac paid by driver ... are
you calculating it companies cost?" -- yes, `insurance_cost.py`'s
`per_company()` was including it in the company-cost total. Fixed at the
source: the key is renamed `occupational_accident_RECOVERED_FROM_DRIVER`
(matching the existing `_ESTIMATED`/`_benchmark` suffix convention this
module already uses to flag a line that needs different handling than a
plain addable cost), excluded from `main()`'s printed totals and from
`build_weekly_pnl_rollup.cost_breakdown_reference()`'s insurance figure.
The reasoning: OCAC is billed and paid by the company, then deducted back
from the driver's settlement -- the exact same recovery pattern CLAUDE.md
already documents for a Truck Max repair invoice -- so counting it as a
net company cost double-counts money the company never actually keeps.
Kept in the register (real, billed, worth knowing exists) but excluded
from every total. Confirmed safe: grepped every other caller of
`insurance_cost.per_company()` in this repo -- only this file's own
`cost_breakdown_reference()` consumes the line-item dict programmatically,
everything else only references the module in prose, so the rename could
not silently change any other established number.

## Motive priced per truck: camera-installed trucks vs. everyone else

Operator, 2026-09-22: "motive you can divide to cameras we have from
motive count and consolidate between motive installed trucks only per
truck price and rest consolidate between all other trucks." Read literally
from the invoice's own line items (`config/telematics_costs.json`), not
hardcoded: the three dashcam-only plans (Driver Safety + Fleet Management +
Communications) total $25,200 over the 36-month contract; the AG-Mini
tracker software plan nets against its matching "Sales Credit - SW" line
(both are the only two line items sharing "SW" -- and only pairing them
this way reconstructs the already-established $229.81/wk total exactly) to
$10,650 over the same 36 months. Split:

    dashcam total $161.54/wk ÷ 15 trucks with a known installed camera = $10.77/truck-week
    tracker total  $68.27/wk ÷ 75 other trucks (90-truck fleet)        =  $0.91/truck-week
    check: 15x10.77 + 75x0.91 = $229.80 ≈ established $229.81/wk

A truck's own Admin now uses whichever of these two applies to its unit
number (`_motive_rates()`'s `installed_units` set, from the invoice's own
`unit_list_supplied`); the company-level reference figure blends each
company's own known installed-camera count (ZONE 4, XTRACK 4, AFG 4, 3
unresolved) against its total truck count for a representative average.

## Two items flagged back to the operator rather than guessed

**Trailer rent by type.** Operator: AFG and XTRACK run open-deck trailers
(flatbed, stepdeck) at their own separate monthly/weekly rates, open-deck
should be AFG-only, and reefers split between AFG and XTRACK. No real
per-type dollar figures exist anywhere in this corpus yet, so
`fixed_costs.py`'s one blended allocated rate per company stays in place
(now surfaced as its own column, per the change above) with an explicit
note naming this gap, rather than inventing a flatbed/stepdeck/reefer
split with no invoice behind it.

**A true weekly IFTA engine.** Operator: build a real IFTA engine and
compute weekly miles/gallons for a precise weekly cost, not the current
quarterly-trailing rate. `cost_structure.fuel_tax_per_mile()` already gives
the best AVAILABLE per-mile rate (from the latest filed quarterly return);
a genuinely weekly engine needs jurisdiction-by-jurisdiction miles and fuel
purchases for each week, which this corpus does not have -- IFTA returns
are themselves quarterly, state-by-state aggregates, not weekly. This
week's own real miles and gallons ARE already available per company
(`weekly_rows()`), so a scoped interim step (recompute using this week's
own mpg against the filed return's own average per-gallon tax rate,
instead of a flat historical per-mile rate) is buildable without new data
-- a full per-jurisdiction weekly split is not, without either new weekly
state-mileage data or a different data source than what is in this corpus
today. Not built this session pending the operator's choice between the
two.

## Provenance answers, on the record

Operator asked directly where several admin-fee figures come from:

- **Transponders** ($3.94/$3.96/$4.06 per truck-week, XTRACK/ZONE/AFG):
  `config/telematics_costs.json`'s `prepass_bestpass_transponders` --
  the PrePass/BestPass invoice cross-referenced device-by-device (EQUIP ID)
  against `ingest/fleet_registry.py`'s fleet registry, confirmed 2026-09-08
  to cover trucks from all three companies despite billing under ZONE-OH's
  name alone.
- **Samsara** ($7.88/truck-week, fleet-wide): the same file's `samsara`
  section -- ZONE-OH's own Sept-2026 invoice ($2,194.36 for 65 trucks'
  dashcam/streaming plan), spread over the whole 90-truck fleet since the
  invoice gives only aggregate quantities, no per-truck unit list, and
  PrePass already proved a ZONE-OH-billed account can cover all three
  companies once checked at the device level.
- **Toll is already per-truck, not consolidated.** Every truck's own
  `toll` figure in the truck-by-truck table is that unit's real P&L toll
  charge for that week (unchanged by this session's admin/rent work) --
  confirmed by inspection of the underlying data, not something that
  needed fixing.

---

