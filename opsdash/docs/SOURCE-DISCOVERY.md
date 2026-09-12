# Source discovery — what the data actually looks like

**Method:** read directly from the live Google Drive sheets on 2026-09-09.
Not inferred, not assumed. Row structures and defects below are quoted from
production data.

**Scope decision:** the aiops Postgres is **out of the build entirely**. Google
Sheets and drag-drop documents are the only inputs.

## A note on what is NOT in this file

No Drive file IDs, no driver names, no truck numbers. This repository is public,
and a file ID plus a business's name is a targeting aid. Sheet identity is
configured at runtime in `accounting.sheet_source`, which is why that table
exists. Sample values below are anonymised; the *shapes* are real.

---

## 1. Source map

| Purpose | Sheet | Feeds | State |
| --- | --- | --- | --- |
| Revenue | Dispatch Sheet 2026 | `ledger_entry` (revenue), forecast basis | live, weekly |
| Fuel detail | Fuel | fuel cost, IFTA purchase state | live, updated daily |
| Fuel summary | Fuel Avrg Company Report | entity attribution, gallons | live, per driver |
| Maintenance + toll | Truck and trailer expenses ZONE | `ledger_entry` (cost) | live, ~2,200 cost rows |
| Truck roster | Master Fleet Sheet, Truck Max | `truck` dimension | live |
| Driver pay | Drivers Pay list | `driver` dimension, driver_pay cost | live |
| Lease-to-own | Iron lease Leased trucks | `driver_class_history` | live |
| Odometer | Odometers of trucks | mileage cross-check | live |

**Entities confirmed: three** — `zone`, `xtrack` (written `xtuck` in one sheet),
`afg`. A fourth party, an equipment-leasing entity, owns the lease-to-own sheet.

---

## 2. Dispatch Sheet 2026 — revenue

Weekly blocks. One row per truck per week, grouped by dispatcher, with the
header row **repeating at every dispatcher group** rather than once at the top.

Columns: `Dispatcher | Truck # | Payment | Driver Names | ` then **seven day
groups of three** (`lane text`, `amount`, `miles`), then `Gross | Miles | RPM`.

**`Payment` is the driver class**, and it maps straight onto the schema:

| Sheet value | `accounting.driver_class` |
| --- | --- |
| `CPM` (also `cpm`, `CPM ` ) | `company` |
| `LO` | `lease_to_own` |
| `OO` | `owner_operator` |

### Defects the parser must survive

1. **Entity is buried in free text, not a column.** Zone is the default;
   the others appear appended to the driver name — `"<name> XTRACK"`,
   `"<name> / AFG"`. Miss this and two entities' revenue lands on the third.
2. **Amounts are inconsistently typed.** `$2,400.00`, bare `3000`, and
   `$ 2,346` (leading space, comma) all appear in the same column.
3. **The miles column sometimes carries a `$`** — `| $1,265.00 | $775 |`
   is revenue 1265, miles 775. Reading column 3 as money double-counts.
4. **Day-cell lane text is free-form**: `transit`, `OFF`, `HOME`, `stuck`,
   `TOWING`, `Truck is not ready`, `OOS`, `Sick`, `truck change`. A day with no
   amount is *no load* and must post no entry rather than a zero one.
   **But the words are not the signal.** Measured across the sheet: 484 day-cells
   match one of those keywords, and **28 of them also carry a real amount** that
   is part of the truck's Gross total — about **$49.5k of genuine revenue** a
   keyword filter would silently delete. Presence of a parseable amount in the
   amount cell is the only reliable no-load test. *(An earlier revision of these
   notes got this wrong and prescribed the keyword filter; the parser agent
   caught it against real data.)*
5. **`#DIV/0!` appears in the RPM column** for trucks with no miles.
6. Merged cells above the day groups (`[merged] Week-1`).
7. Blank truck numbers on rows that still carry a driver.

**No per-state mileage.** Miles are per-day totals only.

---

## 3. Fuel — purchase detail

Columns: `Unit | Percentage | Driver | Location 1 | Gallon | Price | Agent |
Location 2 | Gallon | Price | Agent | Notes`. Some sections insert `Speed` and
`Fault Code`, so **column position is not stable across sections** — parse by
header, never by index.

- **`Location` is a full postal address**, e.g.
  `"66377 <street>, Belmont, OH 43718, United States"`. **The IFTA purchase
  state is extractable from it**, which is the one genuinely good news here.
- **`Gallon` is almost never a number.** Measured by the parser across the real
  file: of 1,499 purchase rows, **1,461 — 97.5% — carry `"full tank"` or
  similar** rather than a quantity. An independent count over raw cells agrees
  (only ~6.8% numeric). Values like `80g` also appear.
  **This is decisive: the fuel sheet cannot supply IFTA gallons at all.** EFS
  and Relay statements are not a preferred source, they are the *only* source,
  and Phase 3 therefore hard-depends on Phase 2. Quantity is emitted as `null`
  — never 0, never inferred.

  **The card-statement parser now exists** (`src/ingest/fuelcard/**`,
  `doc_type = 'fuel_card'`). It was built without a sample of the operator's
  own statement — none is on disk and none is in Drive, searched rather than
  assumed — so columns are matched **by meaning, not by position**, and a
  statement whose layout it cannot map reports the header it actually read
  and which roles it could not fill. That is a diagnosis an operator can act
  on, rather than "parse failed".

  Verified against the two real corpora this build does have (1,582 real
  address cells from the fuel sheet, 897 real free-text descriptions from the
  expenses sheet), which caught three bugs synthetic fixtures would not have:
  the cells `"80 GA"` and `"50 GA"` — eighty and fifty *gallons* — were being
  read as Georgia; `"diesel anti gel"` was being classified as diesel; and
  fuel's real three-decimal unit price (`3.799$`, 319 of 399 real cells) was
  being truncated to two.
- **Jurisdiction survives, though.** The two-letter state parses out of the
  postal address for **1,469 of 1,499** rows. So this sheet knows *where* fuel
  was bought but not *how much* — useful for corroborating an EFS statement,
  useless on its own.
- `Price` is written `3.56$` — **suffix** dollar sign.
- Free-text noise in the driver/location columns, some non-English.
- Diagnostic fault-code text shares the sheet in places.

## 4. Fuel Avrg Company Report — gallons by entity

Three entity blocks **side by side across the columns**, not stacked in rows:
`xtuck | Driver | Gallons | Avg Price | Savings | with discount |` then the same
six columns for `zone`, then for `afg`.

Gallons here are real numbers (`223.80`, `481.98`) but are **aggregated per
driver per period with no purchase state**, so this sheet gives good totals and
the other gives good states — and neither gives both.

**Consequence for IFTA:** tax-paid gallons by state cannot be derived reliably
from either sheet. The EFS/Relay statements remain the authoritative source, as
originally specified. This is a Phase 3 dependency on Phase 2.

## 5. Truck and trailer expenses — maintenance and toll

Several tables in one tab, with differing column counts (11, 9, 4 and 3 all
appear). The cost table's header:

`Work Order | $ used | Unit | Issued To | Unit Type | Cost type | Date | Expense side | Details`

Real row shape:
`EFS | <wo> | <wo> | $693.44 | <unit#> | <driver> <truck#> | trailer | 2 tires replaced | 01.01.26 | company`

Two columns here are worth more than the rest of this document:

- **`Expense side` = company vs driver.** A repair charged back to a
  lease-to-own driver is not a company cost. Counting it as one overstates cost
  per truck and understates lease-to-own margin — precisely the numbers this
  dashboard exists to get right. Now modelled as `ledger_entry.charged_to`.
- **`Unit Type` = truck vs trailer.** Trailer costs are frequent
  (`trl <n> towing and storage`). Attributing them to a truck corrupts per-truck
  profitability. Now modelled as `ledger_entry.unit_type`.

**Toll violations are in this sheet too**, as rows whose vendor column reads
`Toll violations` — so toll is partly a sheet source, not purely drag-drop.

### Defects

1. **Dates are `MM.DD.YY`** — and at least one is mistyped
   (`01.06.25` in a run of `01.06.26` rows). Year inference from surrounding
   rows is unsafe; surface these for review rather than guessing.
2. **`Issued To` mixes driver name and truck number in unstable order** —
   `"<id> <NAME>"`, `"<Name> # <id>"`, `"<Name> #<id>"`. Identity resolution
   must go through `source_key_map`, never a string match.
3. `Unit` is sometimes a truck number, sometimes a trailer number, sometimes
   blank. `Unit Type` disambiguates — when it is filled in.
4. Section headers and `total:` rows are interleaved with data rows and must not
   be read as line items.
5. Non-EFS vendors appear (`M&Y`, and others).

---

## 6. What this changes

**Scope shrinks.** Maintenance cost and part of toll are already maintained in
sheets. The drag-drop path is still required for fuel statements (IFTA gallons)
and remains the design for documents generally, but it is no longer the *only*
way cost enters the ledger.

**Scope grows in one place.** Sheet ingestion is not simpler than document
parsing. These sheets are live, human-edited, and change shape without notice —
hence `sheet_source.header_checksum`, so a layout change fails loudly instead of
silently reading the wrong column as an amount.

**Still unresolved: miles by state.** No sheet has it. The Samsara IFTA report
export, dropped per quarter as an `ifta_mileage` document, is the only
identified source. Phase 3 cannot start until one arrives.

## 7. Open questions

1. Do `xtrack` and `afg` have their own dispatch sheets, or are all three
   entities inside the one Dispatch Sheet with entity in the name text?
2. Is `Truck and trailer expenses ZONE` Zone-only, with separate sheets for the
   other two entities?
3. What does `Percentage` mean in the Fuel sheet — a fuel-card discount tier,
   or a driver split?
4. `Iron lease Leased trucks` — is that lease-to-own contracts, or third-party
   equipment leasing? It determines whether it feeds `driver_class_history` or a
   lease cost category.

---

## 8. Entity attribution — measured, and it does not work

All three entities share one dispatch sheet (confirmed by the operator), so
entity for **all revenue** rests on the free-text marker in the driver-name
column. That was measured against the full 2026 sheet rather than assumed.

| Measure | Result |
| --- | --- |
| Truck-week rows | 337 |
| Gross revenue on the sheet | *(withheld — public repo)* |
| Rows carrying an explicit entity marker | **15 (4.5%)** |
| Revenue that would default to Zone | **94.9%** |
| Trucks marked inconsistently week to week | **7** |

Those 7 trucks are the proof. The same truck is marked one week and unmarked
the next, so a blank means *the marker was omitted*, not *this is Zone*.
Parsing entity from the dispatch text would misattribute roughly **95% of
revenue to a single entity**.

The scale of the error is clear from the fuel summary, which does carry
structured entity blocks: **xtrack has 52 drivers, zone 40, afg 18.** xtrack is
the largest entity by headcount, yet naive parsing would hand nearly all
revenue to zone.

### What was tried

1. **Driver → entity from the fuel summary.** 110 drivers mapped with **zero
   ambiguity** — no driver appears under two entities. Covers 203/335 rows
   (**61% of revenue**). Good signal, insufficient alone.
2. **Truck → entity, derived from the above.** Resolves 61 of 82 trucks, but
   **4 trucks come back with conflicting entities** across weeks — drivers move
   between trucks, and some rows are team drivers.
3. **Truck → entity from the IRP plate series** in the decal registry. **No
   discrimination**: all three entities span the same plate formats.

### A roster table was missed on the first pass

**Correction.** An earlier revision of these notes concluded no sheet carried a
truck → entity mapping. That was wrong. The dispatch workbook contains a
**roster table further down the same file** (around lines 249–468), missed
because the first pass stopped at the truck-week blocks:

`Dispatcher Name | № | Truck # | Driver name | Company Type | Inactive date`

It maps units explicitly: **31 Xtrack LLC, 22 Zone OH LLC, 3 AFG, 6 Inactive**.
An `Inactive date` column and a `Need to Transfer` marker also appear, which are
transfer signals in their own right.

Measured against the trucks that actually earn revenue:

| Measure | Result |
| --- | --- |
| Revenue-bearing trucks | 82 |
| Covered by the roster | **58 (71%)** |
| **Revenue covered** | **74.2%** |
| Uncovered trucks | 24 |

Split of the covered revenue: **Xtrack 34.0%**, Zone OH 32.5%, Inactive 4.1%,
AFG 3.6%. That independently confirms the §8 argument — **Xtrack is the largest
entity by revenue, not Zone** — and kills any default-to-Zone rule for good.

### Conclusion

Entity attribution is **no longer a hard blocker, but it is not solved either**.
The roster covers 74% of revenue; the free-text markers covered 4.5%. The
remaining ~26% still needs the operator's roster, and the roster's own accuracy
is unverified against the trucks that were marked inconsistently week to week.
After rebuilding on the precedence below, **10.6% of 2026 revenue remains
unattributed across 13 units** — down from 19 unassigned units, and now every
one of them carries a named reason rather than "no evidence".

Order of precedence for resolution, best first:
1. The operator's confirmed roster (authoritative, effective-dated).
2. This embedded `Company Type` roster — **declared, not inferred**.
3. The fuel summary's own unit → entity table.
4. The fuel summary's driver → entity blocks (a name match, not a unit match).
5. Free-text markers in the dispatch driver name (unreliable).

### The weaker sources, measured against the declared roster

Tiers 3 and 4 were not taken on trust. Each was scored on the units where the
declared roster gives an unambiguous answer, so the comparison is like for like:

| Source | Agreement with the declared roster |
| --- | --- |
| Fuel summary **unit** table | 28 of 39 — **72%** |
| Fuel summary **driver-name** match | 37 of 43 — **86%** |

Both are too weak to override a declaration, and the unit table — despite keying
on the unit number directly, which looked like the stronger of the two — is the
worse of the pair. It is a fuel-discount grouping, not a registration fact.

The staged roster was rebuilt on this order. Of 82 revenue-bearing trucks:
**50 now rest on the declaration**, 12 on the unit table, 7 on the driver-name
match, and **13 stay unassigned** — 4 where the declared roster lists the unit
under two companies with different drivers, 4 where it marks the unit inactive
though the unit still earns, and 5 with no evidence in any source. Each carries
the specific question to put to the operator rather than a blank.

An earlier revision of the staged roster had 63 trucks assigned, but **52 of
those 63 came from the driver-name match** — the second-weakest tier — and only
7 from a dispatch marker. Trading 6 assignments for 50 declared ones is the
right direction even though the assigned count barely moved: the point is not
how many cells are filled, it is what fills them.

### The unanswerable ones were asking the wrong question

Thirteen units resisted every source. Put to the operator, the answer was that
the question had no single answer: **units transfer between the carriers
mid-year, and units leave** — returned to the vendor, or an owner-operator who
quits. A truck listed under two companies is not ambiguous data. It is a
transfer, and it has a date.

That is checkable, and it checks out. Every unit absent from the declared
roster **stops earning before the dispatch sheet ends** — one after a single
week, the rest within six to fourteen — and three of the five carry an
owner-operator pay code. They did not go missing from the
roster; they left, and the roster is current.

So the dispatch sheet's own weekly blocks, which are dated, give each unit a
period: first week seen, and an end date from either the roster's `Inactive
date` column or the last week the unit appears while the sheet runs on without
it. Resolving the carrier within a period uses the driver on those weekly rows,
scored against every company list including the fuel summary's, which still
names drivers who have since left.

That driver method agrees with the declared roster on **36 of 39 units (92%)**,
the best of any inferred source here — but only after requiring **two** matching
name tokens. One is not identity: the real data has three different drivers
sharing one common first name, and a single-token rule maps all of them to
whichever of the three is on the declared roster.

Result: **74 of 82 units carry a dated carrier period**, 50 of them declared;
23 periods have an end date; 8 units remain open at 5.8% of revenue. Replayed
against the real dispatch sheet, **313 of 336 truck-weeks (93.2%) resolve to a
carrier**.

One row resolves to nothing for an interesting reason: a unit whose roster
`Inactive date` falls ten days before a week in which the sheet still shows it
earning. The resolver refuses it as `outside_period` rather than quietly
stretching the period to fit — one of those two records is wrong, and only the
operator knows which.

### What this cost in the schema

`truck_entity_history` had been in the schema since migration 001, described in
DATA-CONTRACT.md as "what the posting code reads to resolve the correct value
for the accrual date", and **nothing had ever written to it**. The truck →
carrier map lived in `source_key_map` instead, whose primary key
(source_system, source_key, canonical_kind) allows exactly one carrier per unit
for all time.

Migration 015 wires the history table up and adds the one guarantee it lacked:
its primary key (truck_id, effective_from) stops two periods *starting* on the
same day but happily accepts 01-01..06-01 alongside 03-01..09-01, which would
leave the resolver picking whichever row the planner reached first. An
exclusion constraint over `daterange(effective_from, effective_to, '[]')` makes
overlap impossible, so the date lookup is a function.

None of this belongs in a parser. Resolution happens in the review/commit layer
through `source_key_map`, so that a figure can always be traced to *which*
source decided its entity. Until a truck is resolved, its entity is null — an
unattributed figure is recoverable, a confidently wrong one is not.

## 9. The decal registry — a crosswalk worth having

The sheet linked as "IFTA" from the fleet index is **not** mileage by state. It
is a registration registry: `UNIT # | IFTA Decal # | IRP Plate # | Samsara
serial`. It does not close the IFTA gap.

It is valuable for a different reason: it maps roughly **90 trucks to their
Samsara device serials**, which is exactly the join the Samsara IFTA mileage
export will need. It seeds `source_key_map` for `source_system = 'samsara'`.

Caveats: several units appear in multiple sections with **different decal
numbers** (different registration years), one unit number is literally
`"<n> Inactive"`, and some rows carry a state prefix (`MO #`, `OH #`, `IL #`,
`IN #`) marking base jurisdiction. Load the most recent section, not the first
match.

## 10. Other sheets discovered

The fleet sheet is an index. It links to: PM & DOT, Weekly Performance,
Hometime, the decal registry, Maintenance History, a daily update list, and
Risk Management. **Maintenance History** in particular may overlap or conflict
with the expenses sheet already mapped in §5, and should be reconciled before
the maintenance cost path is built, so the same repair is not counted twice.

---

## 11. A fourth entity, and an inter-company layer

The `Maintenance History` sheet linked from the fleet index **returns 404** — it
is not shared with the connected account. Access is needed before its overlap
with the expenses sheet can be judged, so that question stays open.

Searching for it surfaced something else: **`Accounting Zone - Shop`**, updated
daily. It is not per-truck maintenance. It is an **inter-company settlement
ledger between Zone LLC and Truck Max USA LLC**, the repair shop, holding three
stacked tables:

1. Shop invoices issued to Zone against Zone's payments, with a standing shop
   debt balance.
2. A shop P&L — labour hours split `Zone LLC` vs `Others`, two labour rates,
   parts at original and sell price, and a daily shop balance.
3. Bank-derived detail: payroll transfers and card transactions with merchant
   categories.

Three consequences.

**There is a fourth entity.** Truck Max USA LLC is a related repair business,
not a carrier. A fifth name, Solid Progress LLC, appears as a payer. Neither is
in the three-entity model the contract assumes.

**There is a real double-count risk, and it is not the one that was asked
about.** The shop invoices Zone in bulk; the expenses sheet itemises repairs per
truck. Those are plausibly the *same money* at two levels of granularity.
Ingesting both would count shop cost twice. The per-truck itemisation is what
the ledger wants; the settlement sheet is a control total to reconcile against,
not a second cost source.

**Cross-entity P&L needs inter-company elimination.** A payment from Zone to
Truck Max is a cost to Zone and revenue to the shop. Rolled up naively, group
margin is overstated on both sides. This is ordinary consolidation and the
contract does not model it yet.

Minor note: the merchant-category column is unreliable — sizeable amounts are
coded to categories that plainly do not match the spend. Do not derive cost
categories from it.

**No live bank connection is involved.** This is a hand-maintained sheet, so
§2's prohibition holds. It does mean bank-derived data reaches the ledger by way
of a spreadsheet, which is worth stating plainly rather than discovering later.

## 11b. VIN is the universal crosswalk — proven

An IRP invoice for a 42-unit fleet settled how identity should be resolved
across systems, because it exposed a **third** numbering scheme.

| Join attempted | Result |
| --- | --- |
| IRP unit number → operational unit number | **10 of 42** |
| IRP plate → decal registry plate | **0 of 42** |
| **IRP VIN → company-list VIN** | **42 of 42** |

The IRP unit number is **the last four of the VIN** (37 of 42 confirm it
directly), not the number the office uses. Plates do not join either, because
the registry's plate column sits in a differently shaped section and holds
dates in places.

**Consequence for `source_key_map`: VIN is the primary key for a truck.**
Operational unit numbers are a per-system alias and must never be joined on
across systems. Anything registration-related (IRP, IFTA decals, HVUT, title,
insurance) keys on VIN; anything operational (dispatch, fuel, expenses) keys on
the unit number, and the two only meet through the crosswalk.

## 11c. Registration and road-tax costs — a worked example

A real IRP renewal, useful because it is the permit engine's first genuine
input and it reconciles exactly.

| Fee line | Amount |
| --- | --- |
| Registration Fee | 4,067.28 |
| Foreign Jurisdiction Fees | 74,554.18 |
| BMV Fee | 336.00 |
| Postage | 1.75 |
| **Invoice total** | **78,959.21** |

The parts sum to the stated total to the cent. Fleet: **ZONE-OH LLC**, 42 units,
**every one weight group 80**, expiring 09/2027. HVUT is a flat **$550 per
unit**, so **$23,100** for the same 42.

Two things follow that the ledger must respect.

**Per-unit IRP is an allocation, not an actual.** The invoice is a fleet-level
total; no per-unit breakdown exists on it. An even split is $1,879.98 per unit,
and it is *defensible here only because the fleet is homogeneous* — same weight
group, type and year. It is still an allocation, so it posts with a memo saying
so, and `source_kind` stays `document` pointing at the invoice. A per-unit
figure presented as an actual would breach §2.

**Annual costs must amortize, not land on one day.** IRP runs to a registration
year and HVUT to the federal tax year. Expensing $1,879.98 + $550 on the payment
date makes that truck catastrophically unprofitable for a day and free for the
rest of the year, which would make "profitable vs negative trucks" on the CEO
dashboard meaningless. These post as a prepaid balance amortized monthly over
the coverage period, with the payment itself recorded against the invoice.

**HVUT is split by driver class**, which is exactly what `charged_to` exists
for: lease-to-own drivers reimburse their own unit, and the company bears the
rest. Resolving that split needs the lease-to-own roster — of these 42 units,
only 11 currently resolve to a driver class from the 2026 dispatch sheet.

## 11d. The settlement sheet is the effective-dated entity history

The lease-to-own settlement workbook is the source §8 was missing. It holds
**weekly snapshots** (May–Aug 2026 observed), each grouped under `ZONE:`,
`Xtrack:` and `AFG:`, with per-truck mileage, mileage charge, worked weeks,
truck rent and EFS/maintenance chargebacks.

Because it snapshots weekly, it is not a mapping — it is a **time series**, and
therefore a direct source for `truck_entity_history` with real effective dates.
That closes the gap the transfer remarks could not: those carried a date in 1
case out of 46.

Tested rather than assumed: of 39 trucks, 11 appear under more than one entity.
Ordering each truck's appearances by snapshot date, **10 of the 11 form a single
clean chronological move** (`afg 05.10→06.28, then zone 07.05→08.30`). They are
transfers, not contradictions. One truck round-trips zone → xtrack → zone and
needs a human look.

Parsing note: entity blocks end at a totals row, but the column header itself
contains the word "Total" (`Truck Rent total`), so a naive block-end test
terminates the block before reading a single row. Data rows carry a numeric
index in the first cell; that is the reliable boundary.

## 11e. Registration entity ≠ operating entity

The IRP invoice is billed to **ZONE-OH LLC** and covers 42 units. The settlement
sheet says **24 of those units are operated under Xtrack or AFG**, and the
operator separately confirmed more as Xtrack. (Two of those later proved to be
numbering artefacts rather than separate trucks — see §11g.)

So the entity that *registers and pays* is not always the entity that *operates
and earns*. Booking the whole invoice to Zone would overstate Zone's cost and
understate the other two — silently, and by a wide margin.

This is a business-structure question, not a data defect: title and apportioned
registration legitimately sit with one entity while another runs the truck. The
ledger must therefore distinguish **the entity that paid** from **the entity the
cost is attributed to**, and the correct treatment (Zone bears it, or Zone
recharges the operating entity) is the operator's call, not an inference.

Until answered, registration costs post to the paying entity with the operating
entity recorded, so the split can be restated without re-ingesting anything.

## 11f. Correction to the homogeneity claim

§11c said the fleet was uniform in "weight group, type and year". Only the
weight group is: **42 of 42 at group 80**. Type is 39 TT / 3 TR, year spans
2020–2023, and make is 41 Freightliner plus 1 Volvo.

The even-split allocation still stands, because apportioned IRP is driven by
weight and jurisdiction rather than by model year — but the justification is
narrower than first written, and the posting code asserts weight-group
uniformity specifically.

## 11g. Registration coverage — reconciled against the operator

The operator's unit list (46) against the ZONE-OH fleet-001 invoice (42):
**40 appear on both**, 6 are listed but unregistered on this invoice, and 2 are
registered but absent from the list.

**The unit-by-unit crosswalk is not in this file.** This repository is public
and unit numbers, VINs and plates are fleet data; the real table lives in
`tests/fixtures/real/irp-unit-crosswalk.md`, which is gitignored. What belongs
here is the reasoning, which is what generalises.

Each of the 6 unregistered units has an operator-confirmed explanation, and
they fall into four kinds: **sold** (whether outright or lease-to-purchase and
out of operations), **paid off and deliberately not renewed**, **registration
pending**, and **registered on another carrier's IRP account**. None is a data
defect; all four are ordinary fleet events that a naive "missing from the
invoice" report would have raised as errors.

**Correction — one unit reported as unregistered actually is registered.** An
earlier revision of this section, and the answer given to the operator, said it
was not. Both were wrong, and the error came from comparing unit numbers
instead of VINs.

Re-running the comparison on VIN rather than unit number resolved two
discrepancies that a number-to-number match cannot see, and they are two
different failure modes:

- **A dropped leading digit on the registration record.** The invoice carries a
  4-digit number; the office's number for the same truck is that number with a
  leading digit. Same VIN, same plate.
- **A genuine numbering disagreement.** The BMV used the VIN's tail as the unit
  number; the office uses its own. Same VIN, same plate, two different numbers,
  neither of them wrong.

**Every one of the 42 registered VINs appears in the company sheets.** There are
no orphans. Corrected totals: **5 not registered**, all explained by the
operator, and **1 registered but absent from the operator's list**.

This is the clearest possible argument for §11b's rule. Comparing unit numbers
produced two false findings — one truck wrongly reported as unregistered, and
another wrongly reported as an unknown extra. Comparing VINs produced neither.
**Unit numbers are per-system aliases; only the VIN identifies a truck.**

The wider lesson for the data model: **absence from one IRP invoice is not
evidence of non-registration.** Each carrier runs its own IRP account, and this
build has sight of exactly one. Registration status therefore belongs on the
truck as a fact with a named source account, never inferred from an invoice's
silence.

A fifth and sixth party also appear as title holders: **Iron Lease** on paid-off
units, and the **owner personally**. Neither is a carrier, so neither has
operating revenue to absorb a recharge — which is why registration costs
attributed to them are flagged for confirmation rather than posted as ordinary
intercompany balances.

## 12. Open decisions

1. ~~Is Truck Max USA in scope?~~ **Answered: no.** Truck Max and Fleet Prime
   LLC are the same company and it sits **outside the group**. It is therefore
   an ordinary external vendor: its invoices are a Zone cost line, no
   `is_internal` flag is needed, and **no inter-company elimination step**
   belongs in the roll-up. The entity model stays at three carriers.
2. **Access to `Maintenance History`**, to settle its overlap with the expenses
   sheet.
3. **Which layer is the maintenance source of record** — the per-truck expense
   rows, or the shop invoices. Both cannot post. (Unchanged by item 1: an
   external vendor can still be double-counted if bulk invoices and itemised
   repairs both post.)

---

## 13. Integrations: what is actually reachable

Checked rather than assumed, because two planned inputs turn out not to exist.

### Samsara — NOT connected, and not available

There is **no Samsara integration in this environment.** The full connector
catalogue was searched; Samsara is not in it. The nearest match, Fleetio, is a
different product entirely and is also unconnected.

**Consequence: miles by state must be exported manually.** The IFTA mileage
input cannot be automated here. It stays a per-quarter `ifta_mileage` document
drop, exactly as §5 already specifies.

### Telegram — available, but cannot do the retroactive part

A Telegram toolkit exists but has **no active connection**. More importantly,
the approach itself has a hard limit worth knowing before any of it is built:

**The Telegram Bot API cannot read history.** A bot sees only messages sent
*after* it joins a chat, retrieved through `getUpdates`, and undelivered
updates expire after about 24 hours. There is no call that fetches a group's
past messages.

So the idea splits cleanly in two:

| | Feasible? | Notes |
| --- | --- | --- |
| **Going forward** — watch groups for renames and new groups | **Yes** | Group renames arrive as `new_chat_title` service messages. A bot added to each driver group captures every change from that day on. |
| **Retroactively** — reconstruct past truck/company moves from group history | **No, not with a bot** | Requires a Telegram *user* client (MTProto), which authenticates as a person, not a bot. Different build, different auth, and it reads everything that account can see. |

The signal itself is sound: a group renamed to a different unit number, a new
group with a known driver on a different truck, or the same truck under a
different company name are all genuine change events. But a bot started today
answers "what changes from now on", not "what happened this year" — and the
history is what the ledger needs to attribute past revenue.

### Transfer notes — searched, not found

The operator reports that moves are noted in driver and unit lists as
`transferred to <entity> with date`. Every sheet reachable here was searched
for that wording: the fleet index, the 2026 dispatch sheet, the expenses sheet,
both fuel sheets, the decal registry, and the Zone driver pay list. **Zero
matches.** The `Transfer code` column in the expenses sheet is an EFS payment
reference, unrelated to company moves.

Only **one** driver pay list is shared — Zone's. It carries name, unit, pay
rate, 1099 status, escrow, LLC name and notes, but **no entity column**. If
equivalent lists exist for xtrack and AFG, membership of each list would be a
clean entity signal; neither is currently shared.

### Quick Manage — not visible

No Quick Manage file or export exists in Drive. It is an external system, and
data entry into it is reportedly under way. Access route unknown.

### The company list — transfer remarks found, and measured

The per-company workbook (driver list and unit list per tab, inactive rows
listed below the active ones with remarks) **does** carry the transfer notes.
Measured across it, excluding safety-violation prose that merely contains the
word "transfer":

| | Count | Share |
| --- | --- | --- |
| Usable transfer remarks | 46 | — |
| Name a destination entity | 23 | 50% |
| **Also carry a date** | **1** | **2%** |
| No destination named at all | 23 | 50% |

Destinations seen: Zone 13, Xtrack 9, AFG 1. Spelling varies across
`transfer`, `transfered`, `transferred`, and one remark is a future intention
(`transfer afg next week`) rather than a completed move.

**Verdict: the remarks prove transfers happen and roughly where, but cannot
reconstruct effective-dated history.** Ledger attribution needs the date — a
truck that moved to Xtrack in August must not have its July revenue
reattributed. With 2% dated, this source alone cannot do that, which is why a
purpose-built transfer log is the right answer rather than better parsing.

### PII warning on the company list

That workbook contains **Social Security numbers, driver licence numbers, dates
of birth and home addresses**. It must never reach this repository, public or
private, and it should not be pasted into tickets, prompts or exports.

Extraction from it is restricted to unit numbers and remark text, with SSN,
DOB, licence and VIN patterns stripped before anything is written out. Any
future ingestion of driver data must take the qualification fields it needs and
leave the identity documents where they are.

### Corrected header

The expenses cost table header is fuller than §5 first recorded. Both variants
appear across sections:

`Extra | Transfer code | ID | $ used | Unit | Issued To | Unit Type | Cost type | Issued Date | Expense side | Details`

Another reason to parse by header rather than by column index.

---

## 11h. Ownership determines who bears registration cost

Registration cost does not always fall on a carrier. Four distinct bearers exist,
and they are a property of **ownership**, not of operation:

| Bearer | Meaning | Bears IRP/HVUT? |
| --- | --- | --- |
| `company` | leased from the asset-holding company to a carrier | **yes**, the carriers |
| `investor` | owned by an outside investor | no — the investor does |
| `ltp_owner` | a lease-to-purchase driver who has paid the unit off | no — the owner does |
| `owner_operator` | an owner-operator's own truck | no — the operator does |

Of the 42 registered units: **32 company-borne, 3 investor, 6 lease-to-purchase
owners, 1 owner-operator.** The ten non-company units are **$24,299.81** of the
invoice that is recoverable rather than absorbed — money that would otherwise
have been buried in carrier overhead.

The asset-holding company holds title to the company-borne units and leases them
to the three carriers. It has no IRP account and never bears cost; it is a title
holder, which is why it can never be a recharge target.

Two identity corrections belong here: the unit the registration record calls
one unit number is the office's same number with a leading digit, and another
is the VIN's tail where the office uses its own number. Both are confirmed by
matching VIN and plate — see §11g.

**Consequence for the model:** `cost_bearer` is a separate axis from
`operating_entity`. A truck can be operated by one carrier, titled to a holding
company, and paid for by an investor, all at once. Collapsing these into one
"entity" column is what produced two earlier mistakes — a title holder treated
as an operator, and an owner-held unit treated as unattributed.

---

## 14. Scanned documents — measured, not assumed

The accounting team needs to drop any file — PDF, spreadsheet, or a phone
photo of an invoice — and have it read. Tested against the real IRP document
rather than a sample: rendered to an image at 200 dpi and OCR'd, discarding the
text layer, to simulate a scan.

| Measure | Result |
| --- | --- |
| Document structure recovered | fully — headers, columns and rows all legible |
| **VINs recovered exactly** | **33 of 42 (79%)** |
| Distinct numbers recovered | 47 of 50 |

**79% is not good enough to post.** One VIN in five wrong means one truck in
five misattributed, and a misread digit in an amount is both catastrophic and
silent. So OCR output **never reaches the ledger directly** — it fills the
review queue, which already exists for exactly this reason.

### Check digits close most of the gap

A concrete failure: OCR read a VIN with `I` where the truth has `9` — the
two are adjacent glyphs in the scanned font, and `I` is not a legal VIN
character at all. Two facts make that recoverable rather than a guess:

1. **`I`, `O` and `Q` never appear in a VIN.** Their presence is proof of a
   misread, not a suspicion.
2. **Position 9 is a check digit computed from the other sixteen characters.**
   All 42 real VINs validate against it. The garbled character here *was*
   position 9, so recomputing it returned the true VIN exactly.

The same principle generalises: the check digit detects a misread anywhere in
the VIN even when it cannot correct it, which converts a silent wrong answer
into a flagged one. That is the whole game — a field that is *known* doubtful
gets human attention; a field that is quietly wrong does not.

**Design rule that follows:** every extracted field carries a confidence, and
anything that fails a structural check (VIN check digit, a total that does not
sum, a date outside the document's period) is flagged for review rather than
accepted. Extraction assists the accountant; it does not replace them.

### Tooling

`pdftotext` for PDFs with a text layer, `pdftoppm` plus `tesseract` for scanned
pages and images, `exceljs` for spreadsheets. Tesseract is a **system**
dependency, not an npm one — a deployment without it silently loses the ability
to read scans, so it belongs in the deploy checklist rather than being
discovered in production.

---

## 15. Equipment financing — and the distinction that dominates it

Two real loan schedules for the asset-holding company. Both reconcile exactly:
payments equal interest plus principal, principal repaid equals principal
borrowed, and the payment count matches the stated term. Nothing here is
inferred.

| | Loan A | Loan B |
| --- | --- | --- |
| Principal | 632,985.00 | 453,585.00 |
| Nominal annual rate | 9.020% | 8.960% |
| Term | 24 monthly | 36 monthly |
| Monthly payment | 28,963.77 | 14,443.50 |
| Total interest | 62,145.48 | 66,381.00 |

Combined: **1,086,570 borrowed, 1,215,096.48 to repay, 128,526.48 of interest,
43,407.27 leaving the bank every month.**

### Only the interest is a cost

Principal repayment is a balance-sheet movement — debt going down — not an
expense. Booking the whole payment as cost is the single most expensive
bookkeeping error available here:

| Year | Paid | Interest (the cost) | Principal (not a cost) |
| --- | --- | --- | --- |
| 2026 | 405,032.16 | **60,448.82** (14.9%) | 344,583.34 |
| 2027 | 520,887.24 | **39,635.45** (7.6%) | 481,251.79 |

Spread across the 32 carrier-borne units, the difference is stark:

| Treatment | Per truck / year | Per truck / day |
| --- | --- | --- |
| Interest only — correct | 1,889.03 | **5.18** |
| Whole payment — wrong | 12,657.25 | 34.68 |

**An overstatement of $29.50 per truck per day** — more than four times the
entire registration overhead this project measured earlier. A fleet priced off
the wrong figure would refuse profitable freight.

### Whose profit and loss, though

These loans belong to the **asset-holding company**, which owns the trucks and
leases them to the carriers. So there are two different costs and they are not
interchangeable:

- **The holding company's cost** is interest plus depreciation on the equipment.
- **A carrier's cost** is the lease rent it pays the holding company.

Putting loan interest into a carrier's P&L would be wrong, and adding it to the
lease rent already charged would double-count the same equipment. The group view
must eliminate the intercompany lease exactly as it already eliminates the
registration recharge — the mechanism built in migration 004 applies unchanged.

**Open, and needed before any of this posts:** what the carriers actually pay the
holding company per truck, and which units these two loans financed. The
settlement sheet shows truck-rent values of 735, 900 and 514.29 against
lease-to-purchase drivers, which is a third relationship again — driver to
carrier, not carrier to holding company.
