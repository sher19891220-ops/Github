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
4. **Non-revenue days are free text**: `transit`, `OFF`, `HOME`, `stuck`,
   `TOWING`, `Truck is not ready`, `OOS`, `Sick`, `truck change`. These are
   not zero-revenue — they are *no load*, and must not post a zero entry.
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
- **`Gallon` is frequently the literal string `"full tank"`**, not a number.
  This is the blocker for using this sheet as the IFTA gallons source.
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
`EFS | <wo> | <wo> | $693.44 | 50174 | <driver> <truck#> | trailer | 2 tires replaced | 01.01.26 | company`

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
   `"496648 <NAME>"`, `"<Name> # 6169"`, `"<Name> #495803"`. Identity resolution
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
| Truck-week rows | 335 |
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

### Conclusion

No sheet examined carries a reliable truck-or-driver → entity mapping. Since
cross-entity P&L roll-up is the core of the CEO dashboard, this is a **blocking
input**, equal in severity to the missing state mileage. It needs an
authoritative roster from the operator, loaded into `entity`,
`truck_entity_history` and `source_key_map`.

Until then, any entity-sliced figure would be confidently wrong, which the
"no silent estimates" rule forbids.

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

## 12. Open decisions

1. **Is Truck Max USA in scope?** If the CEO dashboard should show group margin
   across the carriers *and* the shop, entities need an `is_internal` flag and
   the roll-up needs an elimination step. If the shop is simply a vendor to
   Zone, it stays a cost line and nothing changes.
2. **Access to `Maintenance History`**, to settle its overlap with the expenses
   sheet.
3. **Which layer is the maintenance source of record** — the per-truck expense
   rows, or the shop invoices. Both cannot post.
