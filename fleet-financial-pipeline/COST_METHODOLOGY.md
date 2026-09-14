# Cost & break-even methodology

This is the plain-English explanation of every formula and allocation choice
in `analysis/breakeven_engine.py` — the calculation engine behind this
project's cost figures. It exists so the numbers are defensible to a lender,
insurer, or accountant, not just a screen to look at, per this project's own
standing rule that financial math is never "trust the dashboard."

**Status: the calculation engine and this document are built and tested
(`tests/test_breakeven_engine.py`, 18 tests). The live Postgres-backed
ingestion, drill-down dashboard, and reconciliation flagging described in
the original project prompt are NOT built yet** — see "What's not built yet"
at the end. This was a deliberate staged decision: start with the math,
since it's the piece every later layer depends on, and it doesn't require
guessing at infrastructure that doesn't exist yet.

## 1. What this project's own data already establishes

Before writing a single formula, the engine was checked against numbers
this pipeline had already spent weeks proving correct (see `CLAUDE.md` and
`docs/FINDINGS.md`): each company's true fixed cost per truck-week, true
variable cost per loaded mile, current miles and rate per truck-week, and
the resulting break-even miles, all in `data/processed/cost_breakdown_view.
json`. `tests/test_breakeven_engine.py`'s parity tests feed those real
numbers through the new engine and confirm it reproduces the same
break-even miles this dashboard already shows for ZONE, XTRACK, and AFG
(within ±1 mile of rounding drift — see "Two break-even models" below for
why not exactly ±0).

## 2. The formulas

### 2.1 Break-even per mile

```
breakeven_per_mile = (fixed_costs / miles_driven + variable_cost_per_mile)
                      / (1 - overhead_pct_of_gross)
```

The rate/mile this truck needs, **at its current miles**, to cover its own
fixed cost. The `(1 - overhead_pct_of_gross)` divisor is the one addition
beyond the textbook shape — see section 3.

### 2.2 Break-even miles

```
contribution_per_mile = rpm * (1 - overhead_pct_of_gross) - variable_cost_per_mile
breakeven_miles = fixed_costs / contribution_per_mile
```

The other direction: **at a given rate/mile**, how many miles this truck
needs to run to break even. This is the figure this project's existing
dashboard already reports as its headline break-even number (e.g. ZONE:
2,161 miles/truck-week at $2.928/mile).

### 2.3 Break-even per day

```
avg_miles_per_day = miles_driven / days_in_period
breakeven_per_day = (fixed_costs / days_in_period + variable_cost_per_mile * avg_miles_per_day)
                     / (1 - overhead_pct_of_gross)
```

The REVENUE (not a rate) this truck needs per day to break even, given its
current miles/day.

### 2.4 Break-even per company

```
company_breakeven_per_mile = (Σ(truck fixed + truck variable × truck miles) / Σ(truck miles))
                              / (1 - company overhead_pct_of_gross)
```

The same math as 2.1, run on the whole fleet's totals instead of one
truck's. The `overhead_pct_of_gross` term is applied ONCE at the company
level here, not per truck, because it is a rate on **revenue** — averaging
it per truck would silently reweight it by truck count instead of revenue.

### 2.5 Margin and profit

```
margin_per_mile = revenue_per_mile - breakeven_per_mile
profit_per_day  = revenue_per_day  - breakeven_per_day
```

## 3. Why `overhead_pct_of_gross` exists, and why it matters

The original project prompt's Section 4.2 writes break-even per mile as
`fixed/miles + variable`, with no other term. That is correct **only** for
a business where every dollar of revenue reaches the truck's own P&L.

This business's own numbers say otherwise: `cost_structure.py`'s measured
`overhead_pct_of_gross` is 3.29% (ZONE), 4.69% (XTRACK), and 3.60% (AFG) —
dispatch commission, factoring fees, and revenue-rated cost (e.g. cargo
insurance billed as a % of gross) that come off the top before a mile's
revenue is available to cover fixed and variable cost at all. Using the
literal Section 4.2 formula for this fleet would understate every
break-even mile figure and overstate every margin by exactly that amount —
XTRACK's the largest case: at 4.69%, a truck grossing $10,000/week loses
$469 of revenue to this cut before fixed/variable cost is even in the
picture.

**`overhead_pct_of_gross` defaults to 0.0**, which makes every formula
above reduce EXACTLY to the literal prompt-specified shape
(`tests/test_breakeven_engine.py::test_zero_overhead_pct_matches_literal_
prompt_formula`). It is not a silent deviation from the spec — it is an
optional, disclosed generalization, off by default, that this fleet's own
real numbers require turning on.

## 4. Two break-even models already exist in this codebase — not yet reconciled

This is disclosed here rather than papered over, because reconciling it
silently would be exactly the kind of unverified assumption this project's
own conventions forbid.

- **`analysis/cost_structure.py`**'s `true_breakeven()` computes fixed and
  variable cost as **residuals** of each company's own weekly P&L sheet
  (gross − net − block costs, and the sheet's own itemized fixed/variable
  lines), then applies `overhead_pct_of_gross` exactly as this engine does.
  This is the model `breakeven_engine.py` reproduces (see the parity
  tests), and the one `data/processed/cost_breakdown_view.json`'s
  `breakeven.miles_at_current_rate` comes from.
- **`analysis/truck_breakeven.py`** independently derives fixed and variable
  cost from a **least-squares regression** of block cost on loaded miles
  across real truck-weeks — a different, empirically-fitted number, not a
  P&L residual. `cost_breakdown_view.json`'s separate
  `breakeven.rate_at_current_miles` field comes from THIS model.

The two models' fixed/variable figures are not identical (e.g. ZONE:
cost_structure.py's $2,391/truck-week + $1.7254/mile vs.
truck_breakeven.py's own separately-fitted numbers), so a rate/mile solved
from one and a miles figure solved from the other will not round-trip
against each other exactly. `breakeven_engine.py` deliberately uses only
one model's inputs at a time (see `from_cost_breakdown_view()`) rather than
mixing the two. **Reconciling these two models — or deciding one supersedes
the other — is real, undone follow-up work**, not something this document
resolves by picking a favorite.

## 5. Overhead allocation (Section 3.3)

`allocate_overhead(pool, method, entities)` splits one overhead dollar pool
across trucks/drivers/companies by a chosen basis. All three bases from the
original spec are implemented and toggleable at call time — nothing here
hardcodes one:

| Method | Basis | When it's the right lens |
|---|---|---|
| `PER_TRUCK` (default for this project) | active truck count | Matches what `cost_structure.py`'s existing overhead model already uses — chosen as the default specifically so this new engine doesn't disagree with numbers already in production on the dashboard. |
| `PER_REVENUE_SHARE` | revenue | Answers "which company's own freight is paying for this cost" — a bigger, higher-earning company absorbs more. |
| `PER_MILE` | miles driven | Answers "which company's own utilization is driving this cost" — right for anything that scales with activity rather than fleet size or revenue. |

Every allocation sums back to the pool exactly
(`test_allocation_always_sums_back_to_the_pool`) — the function raises
rather than silently allocating $0 if the chosen basis totals zero across
every entity (e.g. allocating by revenue when no revenue figure was
supplied).

## 6. Both remaining open assumptions are now resolved

The original prompt's Section 8 said to ask rather than assume anything not
already answered in the codebase. Two of its four questions were already
answered in the first version of this document (which Postgres tables hold
GL data: none yet, this hasn't been built; overhead allocation default:
per-truck, confirmed by the project owner). The other two are now resolved
with real data.

- **Tire replacement — RESOLVED, measured, not benchmarked.** The operator
  pointed at a maintenance ledger already in this corpus (the
  "ZONE_MAINT_MASTER" Google Sheet, `data/raw/pnl/gs-ZONE_master_truck_
  trailer_expenses.xlsx`) that carries real truck and trailer tire changes,
  already tagged `tires/rims` by `analysis/maintenance_ledger.py`'s own
  categorizer — 252 tire-related charges, 2025-01 through 2026-09-01,
  simply never queried for this purpose before. `analysis/tire_cost.py`
  measures it, company-borne only (same rule as `truck_maintenance.py`:
  driver-billed and Iron-Lease-reversal rows are not a company cost):

  | | Company-borne tire $, truck+trailer | $/loaded mile |
  |---|--:|--:|
  | ZONE | $44,856 | $0.0180 |
  | XTRACK | $42,823 | $0.0137 |
  | AFG | $9,699 | $0.0189 |
  | **Fleet** | **$97,378** | **$0.0159** |

  (2026-02-23..2026-08-24, the window every company's P&L mileage covers.)
  **This replaces the earlier industry-benchmark placeholder of
  $0.03-0.04/mile — the real, measured rate is about half that.** Using the
  benchmark instead of this measured figure would have overstated tire
  cost by roughly 2x. `tests/test_tire_cost.py` locks in the real numbers
  as a regression and guards against the rate ever silently exceeding the
  old benchmark (which would mean the join broke, not that tires got more
  expensive). Two disclosed limits: this draws on the primary maintenance
  ledger only, not the separate Truck Max invoice log
  `truck_maintenance.py` also reads (that second source has no per-category
  tag, so it cannot be split into "tires" specifically) — so, like every
  other maintenance figure in this project, treat it as a measured floor,
  not a ceiling; and it is reported truck+trailer combined per loaded mile,
  matching how every other variable-cost line here already blends the
  running fleet's cost over its own miles, rather than split per truck vs.
  per trailer.

- **Per-truck lease/loan payment schedule, source of truth — RESOLVED: there
  isn't one, per truck, because this business's structure doesn't have one,
  and that's now confirmed rather than assumed.** ZONE, XTRACK, and AFG do
  not hold truck loans of their own — they pay Iron Lease **rent** (a fixed
  weekly charge, sometimes plus a per-mile charge), which is the economic
  equivalent of a truck payment and is already the `fixed_costs_total`
  input `breakeven_engine.py` uses (`cost_structure.py`'s "truck rent, base"
  line, itself a weighted blend of Iron Lease's rate card and the P&L's own
  measured rent — see `docs/ACCOUNTING_MODEL.md` section 8). No separate
  loan schedule applies at the operating-company level because the
  operating company isn't the one holding debt on the truck.

  This was checked, not assumed: `data/processed/cash_categorized.csv`
  appeared to show ZONE and XTRACK carrying real `loan_finance` activity —
  $1.92M and $91K respectively. Both were a taxonomy false positive, found
  and fixed while chasing this down. Triumph Finance's factoring-advance
  wires route through TBK Bank as their own sending bank ("ORIG:TRIUMPH ...
  SND BK:TBK BANK, SSB"), and `taxonomy/categorize.py`'s `loan_finance`
  rule matched on the bank's name alone — in two places, one gated by
  ingest order and a second, redundant, fully unconditional copy in the
  generic category list that caught the same rows right back. Both are now
  fixed: `loan_finance` from a named-vendor match requires a negative
  amount (a loan payment is money going OUT; a positive amount naming the
  same bank cannot be one), and the redundant unconditional copy is
  removed. Regenerating `cash_categorized.csv` after the fix: ZONE's
  `loan_finance` drops to $100,591 of real, one-off outflows (a Triumph
  advance reversal and one TBK Bank transfer — neither an amortization
  schedule), XTRACK's to $71,145 (one wire whose own memo reads "IRON LEASE
  14 TRUCKS" — plausibly XTRACK funding Iron Lease's equipment, i.e.
  intercompany, not XTRACK's own debt; not reclassified here since that is
  a separate, not-yet-confirmed attribution question). IRON_LEASE's own
  figure, $332,431 — the real TBK loan debits — is unchanged, exactly as it
  should be: that debt is real, it is just Iron Lease's, not the operating
  companies'. `tests/test_categorize.py` locks in both fixes as regression
  cases (99 taxonomy cases, up from 97).

  **The real per-truck/per-driver schedules that DO exist**, for the two
  arrangements where a truck's payment is genuinely tracked individually:
  - **Iron Lease's own equipment debt** (the trucks it bought to lease out):
    `data/raw/iron_lease/financing/`, read by `analysis/iron_lease.py`'s
    `tbk_financing()` — two TBK Bank loans, $453,585 and $632,985
    principal, principal/interest/balance broken out per payment.
  - **Lease-to-Purchase drivers** (paying down a specific truck through
    settlement deductions): the "Iron Lease Leased trucks" weekly sheet
    (`data/raw/iron_lease/leased_trucks_weekly.csv` — driver name, truck
    number, overall/charged/remaining balance). This is the driver's own
    payment schedule, not the operating company's cost.

  Owner-operators finance their own trucks entirely outside this corpus —
  correctly absent, not a gap to fill.

## 7. What's not built yet

The original prompt asked for a live Postgres-backed system
(`aiops` database, Samsara/QuickManage/QuickBooks ingestion, a React
drill-down SPA, a staff-portal auth model, reconciliation flagging between
QuickBooks and bank data). None of that infrastructure exists in this
environment: `localhost:5432` does not respond from this container, no
"staff portal" app exists anywhere in this monorepo, and this repository's
own `CLAUDE.md`/`docs/FINDINGS.md` already flagged the real `aiops` schema
as "assumed, pending recon on the Mac Mini" before this document was
written. Building the calculation engine first, independent of where the
data ends up living, means none of that infrastructure work has to be
redone or guessed at now — whichever system eventually feeds it real
per-truck numbers, the math itself is already built and tested.
