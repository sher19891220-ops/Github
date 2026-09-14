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

## 6. Two open assumptions from the original prompt's own pre-flight questions

The original prompt's Section 8 said to ask rather than assume anything not
already answered in the codebase. Two of its four questions ARE already
answered here (which Postgres tables hold GL data: none yet, this hasn't
been built; overhead allocation default: per-truck, confirmed by the
project owner). The other two are not yet resolved by real data, and are
recorded here as open rather than guessed silently:

- **Per-truck lease/loan payment schedule, source of truth.** This project
  already has real financing schedules for Iron Lease's own equipment debt
  (`data/raw/iron_lease/financing/`, read by `analysis/iron_lease.py`'s
  `tbk_financing()` — two TBK Bank loans, $453,585 and $632,985 principal)
  and Iron Lease's own per-truck rate card
  (`analysis/truck_weeks.py`'s `IRON_RATE_CARD`, two tiers: $735/wk+$0.10/mi
  and $900/wk+$0.12/mi). Neither of these is a lease/loan schedule for
  every individual truck across all three companies — they cover the
  Iron-Lease-financed subset only. No broader source exists in this corpus
  yet.
- **Tire replacement amortization.** No tire replacement data exists
  anywhere in this project's corpus. Pending real data, this engine has NO
  built-in default — a caller must supply its own tire cost as part of
  `variable_cost_per_mile` (or as a separate line item at whatever level it
  is tracked). If an interim placeholder is wanted before real data is
  loaded, industry benchmarks commonly cited for OTR dry van tractor tires
  run roughly **$0.03-0.04/mile** (a full tractor tire set replaced roughly
  every 150,000-200,000 miles) — offered here as a documented starting
  point only, not as a measured figure for this fleet.

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
