---
type: weekly-close
week: "most recent complete week — exact dates unconfirmed"
pulled_on: 2026-08-21
status: provisional
coverage: 3 of 8 entities
---

# First group consolidation — PROVISIONAL

> **Read the "What this does not include" section before using any number here.**
> This covers three of eight entities and the net-profit figures could not be
> independently recomputed. It is a starting point, not a close.

## Carriers — most recent complete week

| | Zone-OH | Xtrack | AFG | **Group** |
|---|---:|---:|---:|---:|
| Trucks running | 4 | 9 | 5 | **18** |
| Gross revenue | $31,500 | $67,295 | $50,547 | **$149,342** |
| Miles | 12,027 | 22,636 | 17,172 | **51,835** |
| Revenue / mile | $2.62 | $2.97 | $2.94 | **$2.88** |
| Driver pay | $8,709 | $18,776 | $14,499 | **$41,983** |
| Fuel / DEF | $10,674 | $21,324 | $12,777 | **$44,775** |
| Tolls / scales | $1,706 | $2,417 | $715 | **$4,838** |
| Truck Rental → Iron Lease | $4,747 | $10,977 | $6,423 | **$22,147** |
| Net profit *(as reported)* | $3,773 | $11,415 | $16,196 | **$31,384** |

## Intercompany elimination

| Line | Amount |
|---|---:|
| Sum of carrier net profit (as reported) | $31,384 |
| **Truck Rental paid by carriers → Iron Lease** | **$22,147** |
| Iron Lease costs against that revenue (payments, interest, insurance) | **not available** |

**The elimination cannot be completed.** $22,147/week leaves the carriers as an
expense and lands in Iron Lease as revenue — roughly **$1.15M/year** of
intercompany flow. Whether that is profit or a wash at group level depends
entirely on Iron Lease's cost side, and no Iron Lease P&L exists.

This is the single biggest hole in group reporting. Until it is closed, no
group profit number is real.

## Week over week

| | This week | Prior week | Change |
|---|---:|---:|---:|
| Group gross | $149,342 | $178,705 | **−$29,363 (−16%)** |
| Group net (as reported) | $31,384 | $54,017 | **−$22,633 (−42%)** |
| Truck rental | $22,147 | $24,168 | −$2,021 |

**Zone-OH drove almost all of it.** Gross fell $53,665 → $31,500 (−41%) and net
fell $41,407 → $3,773 (−91%), on the same 4 trucks. Revenue per mile of $2.62 is
well below Xtrack ($2.97) and AFG ($2.94). Worth asking why before anything else
in this note.

Xtrack and AFG both improved week over week.

## What this does not include

**Five of eight entities are absent**, because no weekly P&L sheet exists for them:

| Entity | Weekly P&L found? |
|---|---|
| Zone-OH, Xtrack, AFG | ✅ included above |
| Runstar LLC | ❌ none found |
| Sher Trucking LLC | ❌ none found |
| Iron Lease LLC | ❌ roster + invoice ledger only, no P&L |
| Shaeffer Technologies | ❌ none found |
| Fleet Prime LLC | ❌ none found |

So the brokerage margin, the shop's P&L, and the lease company's cost side are
all invisible. **A group number covering 3 of 8 entities is not a group number.**

## Data-quality findings

1. **Net profit is reported, not verified.** The stated weekly "Net profit" cell
   could not be reproduced from the underlying rows — sum(unit totals) plus the
   visible deduction lines does not reconcile to it, off by $45k–$84k per week on
   Zone-OH and Xtrack. Either there is revenue outside the unit rows, or the
   formula pulls from cells the export does not expose. **Worth checking directly
   in the sheet.** Every net-profit figure above is copied as-is.

2. **Weekly tabs carry no date inside the sheet.** Week identity lives only in the
   tab name, which the export drops. That is why this note cannot state its own
   dates. **Fix: put the week's date range in a cell inside each weekly tab.**
   One-time change, permanently makes these sheets machine-readable.

3. **Week alignment is assumed, not proven.** Iron Lease's last invoiced period is
   08.03.26–08.09.26. The carrier sheets were last modified 08.17.26. The three
   carriers' most recent complete tabs are assumed to be the same week as each
   other — unverified.

4. **Iron Lease roster (~44 unit rows, 13 marked rented, 1 sold, 2 accident)
   far exceeds the 18 trucks appearing in any carrier P&L.** Some are rented out
   externally, some presumably run under Runstar or Sher Trucking. But units that
   exist and appear in no weekly P&L are the classic place for cost to hide.

5. **The Iron Lease sheet holds two unrelated tables side by side** (truck roster
   and invoice ledger). They are not row-aligned. Anything reading that tab will
   mis-associate rows.

## Next actions

- [ ] Check the Net profit formula in one Zone-OH weekly tab — what feeds it?
- [ ] Add a date-range cell to each weekly tab (all three sheets)
- [ ] Why did Zone-OH gross drop 41% on the same 4 trucks?
- [ ] Why is Zone-OH at $2.62/mile vs $2.94–2.97 for the others?
- [ ] Build a weekly P&L for Iron Lease — needed to close the elimination
- [ ] Build weekly P&Ls for Runstar, Shaeffer, Fleet Prime
- [ ] Reconcile: 44 Iron Lease units vs 18 in carrier P&Ls
- [ ] Split the Iron Lease roster and invoice ledger into separate tabs

## Sources
- `ZONE Profit & Loss 2024 and 2025 and 2026` — 138 weekly tabs
- `Xtrack LLC Profit and Loss Weekly` — 144 weekly tabs
- `AFG Profit and Loss Weekly` — 19 weekly tabs
- `Iron lease` — roster + invoice ledger, last period 08.03.26–08.09.26

Tab order confirmed **newest-first** in all three carrier sheets (AFG grows
1 → 5 trucks reading backwards; Xtrack and Zone-OH follow the same pattern).
