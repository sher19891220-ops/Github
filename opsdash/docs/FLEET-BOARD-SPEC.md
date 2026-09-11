# Fleet availability board — design spec

A dispatch-side board, modelled on the operator's existing Truck Availability
Report. This spec fixes the form, the colour and the data sources so the build
is execution rather than invention.

## 1. What the data can and cannot fill

Measured against the parsed dispatch sheet, not assumed.

| Panel | Source | Status |
| --- | --- | --- |
| Driver type split | dispatch `Payment` column | **real** |
| Weekly RPM | revenue ÷ miles, per week | **real** |
| Revenue per active driver | revenue ÷ trucks earning that week | **real** |
| Active drivers | distinct trucks with revenue | **real** |
| Coverage % | active ÷ assigned, per week | **real** *(see §2)* |
| Other trucks — sold, lease-to-purchase, inactive | unit status list | **real** |
| Trucks by status — assigned / open / shop / broken-down | — | **needs a source** |
| Ready · Ready 24+ · Home 48+ | — | **needs a source** |
| Days since last suspension | — | **needs a source** |

Nine weeks parse cleanly. Driver type across 82 distinct trucks comes out
**Company 66, Owner 14, Lease 2**, which does *not* match the reference board's
69/17/14 split — that board is a current snapshot and this is the 2026 sheet, so
the two are measuring different populations. Neither is wrong; they must not be
presented as the same number.

**The status panels are the gap.** Words like `SHOP`, `HOME`, `OOS` and
`NOT READY` do appear in the dispatch lane text — 26, 156, 7 and 9 times — but
§2 of the discovery notes already established that lane-text keywords are not a
reliable signal there, because 28 cells carrying such a word also carry real
revenue. Deriving an operational status from them would repeat a mistake this
project has already made once and measured. Status needs a maintained field.

## 2. Coverage is a ratio, so say which one

The reference board shows 76% on a gauge without stating the denominator. Define
it explicitly on the board: **covered ÷ assigned**, where *covered* means the
truck earned revenue in the period. A percentage whose denominator is invisible
is the easiest number on a dashboard to misread.

## 3. Form decisions

**The gauge becomes a stat tile.** The visualisation guidance is explicit that a
single value is not a chart: *"a one-bar bar chart, or a 2-slice pie → a stat
tile. The number is the chart."* A gauge spends a quarter of the board to render
one number less precisely than type does, and its coloured arc implies
thresholds nobody defined. The tile shows the percentage large, with the
composition beneath it — `54 of 71 assigned` — which the gauge cannot express at
all.

**Status breakdowns stay tables.** Six status classes across four driver
populations is past the point where colour carries meaning (the guidance caps
that around seven classes). The numbers are the content; colour is a secondary
cue on the status chip only.

**Weekly stats gain a sparkline**, not a second axis. RPM and revenue per driver
are different scales — the single most common charting error is putting them on
one plot with two y-axes. Two small, separate sparklines, or the table alone.

## 4. Colour

Validated with the palette script rather than by eye, in both modes.

**Driver type** — categorical slots 1–3:
`#2a78d6` Company · `#eb6834` Owner · `#1baf7a` Lease
(dark: `#3987e5` · `#d95926` · `#199e70`)

All six checks pass in both modes on the all-pairs list. One light-mode contrast
warning on the aqua slot obliges visible labels — which every panel has anyway,
being a table.

**Status** — the reserved status palette, never the categorical slots:
`#0ca30c` covered · `#fab219` ready · `#d03b3b` home · `#ec835a` shop

These ship as **chip + label**, never colour alone. Two of them sit below 3:1 on
the light surface by design, and the label is the mitigation. A colour-blind
reader, a printed copy and a forced-colours display all still read the board.

## 5. Layout

One column of context on the left (fleet totals, driver mix), the period's
headline numbers across the top, per-population status tables below. Filters —
company / lease / owner / all — sit in one row above the panels and drive every
panel at once.

Density over decoration. This is a board someone watches all day; the reference
board's photographic background is the kind of thing that looks good in a
screenshot and costs legibility every hour after.

## 6. Open question for the operator

Where does truck status live today — assigned, open, shop, broken-down, and the
ready/home timers? It is maintained somewhere, because the reference board
renders it. Until that source is named, those panels render as *no data* rather
than being inferred from lane text.
