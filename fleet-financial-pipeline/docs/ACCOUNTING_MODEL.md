# Fleet Accounting Domain Reference

**Purpose.** This document describes the accounting model behind a multi-entity
over-the-road (OTR) dry van trucking group — how revenue, cost, and financing
actually work across its operating companies — so that another system (a TMS,
a dispatch/orchestration layer, a settlement engine) can be built against the
same domain model without re-deriving it from raw statements.

It is a **methodology and domain reference**, not a live data feed. Every
dollar figure below is a snapshot from a specific analysis window, stated with
its date and source; treat the *structure* (entities, formulas, categories,
responsibility rules) as durable, and re-derive current figures from source
documents before relying on them for a real decision.

This reference does not assume the reading system has access to this
project's own codebase, database, or source documents. Section 14 names the
modules that produced each figure, for provenance only.

---

## 1. Corporate structure

| Entity | Role | Fleet (approx.) |
|---|---|---|
| **ZONE** (Zone LLC, dba Zone-OH) | Operating company — freight, mostly company drivers | ~32 trucks |
| **XTRACK** (Xtrack LLC) | Operating company — freight, heavy owner-operator mix | ~41 trucks |
| **AFG** (AFG Transportco LLC) | Operating company — freight, heavy owner-operator mix | ~17 trucks |
| **IRON_LEASE** (Iron Lease LLC) | Asset-holding company — owns trucks, leases them to the three operating companies and to drivers on lease-to-purchase | owns ~90+ units |
| **TRUCKMAX** (Truck Max USA LLC) | The shop — parts and labor, bills out to whichever company or driver owns the repair | — |

**Iron Lease is not an operating company.** It owns equipment, bills rent and
per-mile mileage charges to ZONE/XTRACK/AFG, and services its own equipment
debt. It has no payroll, no insurance line, and no maintenance spend of its
own — those all belong to the operating company or driver running the truck.
Transfers between Iron Lease and the operating companies, and between the
three operating companies themselves, are **intercompany**: they move cash,
but are not a group-level revenue or cost event.

---

## 2. Revenue

Freight revenue ("gross") is booked by the operating company in the week the
load ran, per truck. It is mostly **factored**: a factor (Triumph) advances
against invoices for a fee and collects from the customer directly.

- **Booked gross ≠ collected cash.** A load is gross the week it runs,
  regardless of whether the invoice has been submitted, funded, paid, or
  denied by the factor.
- **Factoring status is not binary.** An invoice can be `Paid` (the debtor
  settled), `Funded` (the factor advanced but the debtor hasn't paid — a
  different party carries the risk today), `Denied` (credit-denied; the
  company must collect it itself), `Short Paid`, `Recoursed`, or
  `Rejected/Held`. Do not add `Funded` and `Paid` together as if both were
  settled.
- **A material share of booked revenue can be genuinely at risk** — credit
  denials concentrated on a single customer, invoices never submitted to the
  factor at all (freight billed direct is legitimate, not automatically an
  error). Any revenue-recognition logic should carry factoring status as a
  first-class field, not assume gross equals cash.

---

## 3. Truck arrangement types

The same fleet runs on at least four different economic arrangements, and
they are **not comparable** on cost lines that the arrangement itself
determines — only on model-independent metrics (see §6).

| Arrangement | Who buys fuel | Who carries equipment/insurance | Company's real economics |
|---|---|---|---|
| **Company Driver (CD)** | Company | Company | Full revenue in, full direct cost out |
| **Owner-Operator (OO)** | Driver, out of settlement | Driver's own truck; still on the group's insurance schedule and pays its own IRP/HVUT | Company's profit = a company charge (a flat % of gross) plus a fuel-discount margin — nothing else. Rent and fuel sit in the driver's deductions, not the company's cost side. |
| **Lease-to-Purchase (LTP)** | Driver (once operating) | Iron Lease holds title until paid off; driver pays it down through settlement deductions | Registration and other equipment-linked costs can be billed to the driver at a **stated flat rate**, which need not equal the truck's own actual cost |
| **Lease-to-Walk-Away (LTWA)** | Driver | Driver | Fixed weekly rate + per-mile charge; driver never acquires the truck |

**A truck's arrangement can change mid-life** (a driver moves from LTP to OO,
a truck is repossessed and re-leased). Attribution logic must key on the
arrangement in effect for the period being priced, not assume it is static.

**On an owner-operator truck, the company's profit is exactly:** company
charge (~11–13% of gross) + fuel discount margin. A negative "driver pay"
figure on an OO block is not a company loss — it is the arithmetic of the
driver's own deductions netting below zero, and inverting that sign is a
common and serious modeling error.

---

## 4. Cost structure

Every cost is one of three shapes. Conflating them is the single most common
source of a wrong break-even number.

| Shape | Behavior | Examples |
|---|---|---|
| **Fixed** | Charged whether the truck moves or not; typically weekly or annual/prepaid | Truck rent, insurance/admin, company overhead (fixed share), registration (IRP/HVUT) |
| **Variable, per mile** | Scales with loaded miles | Fuel, driver pay, tolls, per-mile equipment rent, IFTA/road tax |
| **Variable, % of gross** | Scales with revenue, not miles | Dispatch commission, factoring fee, company-overhead variable share |

### 4.1 Benchmark figures (13-week window ending 2026-08-24)

**Fixed cost, $ per truck-week (company-driver truck):**

| | ZONE | XTRACK | AFG |
|---|--:|--:|--:|
| Truck rent, base | $1,166 | $1,165 | $1,167 |
| Admin/insurance/trailer | $522 | $459 | $451 |
| Fixed company overhead | $672 | $505 | $398 |
| Registration (IRP/HVUT, company-responsibility basis — §5) | ~$11 | ~$11 | ~$11 |
| **Total fixed, $/truck-week** | **~$2,372** | **~$2,141** | **~$2,027** |
| **Per truck-day** | **~$339** | **~$306** | **~$290** |

**Variable cost, $ per loaded mile:**

| | ZONE | XTRACK | AFG |
|---|--:|--:|--:|
| Fuel | $0.8163 | $0.8657 | $0.8168 |
| Driver pay | $0.8071 | $0.7922 | $0.8628 |
| Tolls | $0.0834 | $0.0793 | $0.0739 |
| Equipment mileage charge | $0.0225 | $0.0115 | $0.0330 |
| Road/fuel tax (IFTA + state) | $0.0083–0.0086 | $0.0070 | $0.0020 |
| **Total variable, $/mile** | **~$1.725** | **~$1.764** | **~$1.795** |

**Overhead** (shared company costs — dispatch, admin, factoring fee,
maintenance allocation — split into a fixed $/truck-week share and a
variable %-of-gross share):

| | ZONE | XTRACK | AFG |
|---|--:|--:|--:|
| Total, $/truck-week | $938 | $887 | $766 |
| — fixed portion | $672 | $505 | $398 |
| — variable portion (rest is % of gross) | 3.29% | 4.69% | 3.60% |

These three companies are genuinely different businesses, not the same
business at three scales: XTRACK gives up the largest variable share before
a mile is even priced (4.69% of gross); AFG carries the lowest fixed base
and the highest current utilization.

---

## 5. Registration (IRP/HVUT) — a responsibility model, not just a cost line

IRP (apportioned plate fees) and HVUT (federal heavy-vehicle use tax) are
**annual, prepaid, fixed** costs — the same shape as insurance. They do not
pause when a truck is idle, and there is no refund for one paid mid-term
the way there can be on an insurance policy.

**Two different questions can be asked of the same registration data, and
they have different answers:**

1. *Which company's books did this truck's registration land on* (an
   operational/reporting question — "whichever company's P&L last ran the
   truck")?
2. *Who should actually bear this cost* (a responsibility/recharge
   question)?

For (2), apply this precedence, most specific rule wins:

| Bearer | Rule |
|---|---|
| **Owner-operator** | Any truck the driver owns outright bears its own IRP/HVUT — general policy, not a per-unit list |
| **Named investor** | A truck financed or owned by a named third party (not the operating company, not the asset-holding company) bears its own cost |
| **Lease-to-purchase driver** | Bears IRP/HVUT at a **stated flat rate** set by the operator (which need not equal the truck's own actual cost — see below) |
| **Sold / departed** | A truck already paid off and titled to a driver no longer affiliated with the company is excluded entirely — not a company cost, and not spread over the active fleet either |
| **Default** | Everything else is split equally across the operating companies, then spread evenly across the whole running fleet as a single per-truck rate |

**A stated recharge rate is a policy choice, not a cost measurement.** IRP is
apportioned per truck by miles and weight and can vary 3× truck to truck; a
flat rate charged to a driver will not equal any individual truck's real
cost, and can recover meaningfully more (or less) than was actually spent.
Track both numbers — actual cost and stated recharge — as separate fields;
collapsing them hides the margin (or shortfall) the arrangement produces.

**A registration data file is very often a partial record.** It will name
substantially fewer trucks than the group's full fleet (a fleet still being
onboarded, or a truck registered under a sibling account this file doesn't
cover). Any per-truck rate derived from it is a **floor**, and truck counts
should be stated alongside the rate rather than assumed to cover the whole
fleet.

---

## 6. Break-even

For a company-driver truck:

```
kept_per_mile   = rate_per_mile × (1 − overhead_variable_%) − variable_cost_per_mile
break_even_miles_per_week = total_fixed_per_truck_week / kept_per_mile
```

- **A floor rate exists below which no mileage helps.** If `kept_per_mile`
  is zero or negative at a given rate, more miles produce *more* loss, not
  less — the truck cannot break even at that rate at any volume. This floor
  sits just below variable cost per mile, adjusted for the overhead
  variable-% bite.
- **Price a parked truck differently from a running one.** An idle truck is
  charged a lower rent than a running one under most lease structures, so
  the "cost of an idle truck" and "the fixed base used in a break-even
  calculation" are two different numbers, not one reused for both purposes.
- **A zero-gross week is not necessarily a parked truck.** A truck can move,
  burn fuel, and pay a driver in a week its revenue is booked in a different
  period or a different reporting block. Filter idle trucks on cost
  evidence (zero fuel, zero driver pay that week), not on gross alone.

---

## 7. Insurance

Insurance is priced on **different bases for different coverage lines**, and
using one basis for all of them mis-prices an idle or added truck:

| Coverage | Priced per |
|---|---|
| Auto liability, excess cargo, non-trucking liability | scheduled unit (flat $/unit-year) |
| Physical damage | % of each unit's insured value |
| Primary cargo (varies by carrier) | % of gross revenue |
| A secondary cargo layer (if present) | $ per 100 miles |
| Occupational accident (owner-operators) | flat $ per enrolled owner-operator per month |

**The effective (at-cost) premium, not the face rate, is the number that
matters.** A reporting policy's premium moves as units are added or removed
mid-term — a unit that stops running still costs its liability and physical
damage in full, but a return premium is real when a unit comes off the
schedule. A single blended "insurance per truck" figure gets this backwards
for exactly the trucks it matters most for: idle ones.

---

## 8. Iron Lease: asset ownership, billing, and financing

Iron Lease's economics have three independent layers, easily confused with
each other:

1. **Billing** — weekly invoices to the operating companies for truck rent
   and per-mile mileage charges. A significant share of what it bills comes
   right back as maintenance credits, so the invoice *total* understates
   both the lease charge and the repair flow running the other way.
2. **Cash** — invoices marked "Paid in Full" are frequently settled by
   **netting** against an intercompany balance, not by a matching bank
   deposit. Treating a P&L lease-rent line as if it were a cash outflow
   overstates the paying company's real cash cost.
3. **Financing** — Iron Lease's only real third-party outgoings are trucks:
   equipment purchases and installment loans against them. These loans carry
   their own amortization schedule (principal, interest, remaining balance)
   entirely separate from anything billed to the operating companies. **The
   unpaid balance on such a loan is a real, contractual future cash
   obligation that does not appear in any operating company's cost model** —
   it is debt service, and unlike a fixed operating cost it does not pause
   if a truck sits idle, nor does it appear in a per-truck or per-mile rate
   anywhere else in this model.

**A recurring debit that appears twice around the same date is not
automatically two payments.** A bank ACH debit can bounce, post a same-day
or next-day return credit for the identical amount, and be re-collected days
later. Before treating any pair of same-amount debits as two real charges,
check for a matching return/reversal credit in between.

---

## 9. Admin / recharge fees to drivers

A flat per-driver admin fee (covering things like ELD, telematics, permits,
transponders) should be checked against the **actual, itemized cost of the
services it claims to cover**, priced from real vendor invoices — not
assumed to break even. It is common for:

- The real, measured cost of the named services to run several times the
  stated fee (drivers effectively subsidized by margin elsewhere, not by the
  fee itself).
- Shared vendor accounts (telematics, tracking) to be billed as one lump sum
  covering **multiple operating companies at once**, with no per-truck or
  per-company split in the vendor's own invoice — requiring a device-level
  export to attribute correctly, not an assumed even split.
- A vendor's line count to drift over time (a wireless/tablet account, for
  instance) — a multi-month average can obscure a real, recent step change
  in enrolled lines that a per-invoice check would catch.

---

## 10. Conventions this model depends on

- **Cash-flow sign convention: negative = money out, positive = money in**,
  applied uniformly. A source's *native* sign convention almost never
  matches this (a credit-card export prints a charge as positive and must be
  negated on ingest; a bank feed's `Spent`/`Received` columns are unsigned
  and the column itself is the sign). Get this wrong once and every
  downstream total is wrong in a way that can look plausible.
- **Intercompany is not revenue or cost.** A transfer between two entities
  in this group proves a relationship, never a reason. Classify it as
  intercompany and stop — do not infer from the classification alone
  whether one side was "funding" the other or "paying" it; only a
  settlement-level record (e.g., a deduction line) can close that question.
- **A stated/contractual rate and a measured/actual rate are different
  facts and both are worth keeping.** This model repeatedly finds real gaps
  between what a rate card, invoice, or policy says and what is actually
  paid or charged. Neither should silently overwrite the other in a data
  model — keep both, dated, and let a consumer choose which one a given
  calculation needs.
- **A missing filing or document is not a zero.** A company with no return
  or invoice on file for a given cost is the least-documented case, not the
  cheapest one. Model an unmeasured cost as null/unknown, never as $0.

---

## 11. Known structural gaps in this model

Durable caveats — true regardless of which analysis window is current:

- **Maintenance is not currently a line in most operating P&Ls at all.**
  Any break-even or margin figure computed without it is *before*
  maintenance, and the real rate can plausibly run from a small fraction of
  a cent per mile to a figure large enough to flip a truck from profitable
  to unprofitable. Treat it as the single largest open unknown in a
  per-truck economics model until it is priced from a complete, reconciled
  maintenance ledger.
- **"Overhead" can be measured on two different bases that do not have to
  agree**: a per-company residual derived from that company's own P&L
  arithmetic, versus a flat operator-supplied staff/office roster spread
  evenly across the whole fleet. Both are legitimate answers to different
  questions ("what does this company's own sheet imply its overhead is" vs.
  "what does the shared staff actually cost per truck") — a consuming
  system should pick one deliberately and document which, rather than
  averaging or silently preferring one.
- **A registration, insurance, or tax data file frequently covers less than
  the full fleet.** Any rate derived from it prices the trucks it names, not
  the fleet at large, until the file is confirmed complete.
- **Equipment-financing debt service is typically absent from per-truck or
  per-company cost models entirely**, even when the underlying loans are
  known and documented. It belongs in whichever entity holds the debt (here,
  the asset-holding company), not spread across the operating companies
  that lease the equipment.

---

## 12. Suggested data model hooks

For a system representing this domain, the following fields recur enough to
be worth making first-class rather than derived ad hoc:

- **Per truck**: current arrangement type (CD/OO/LTP/LTWA), the company
  currently operating it, the entity holding title, and — where financed —
  a link to the loan schedule paying it down.
- **Per cost line**: shape (fixed / variable-per-mile / variable-%-of-gross),
  basis (per-unit, per-value, per-gross-dollar, per-mile — insurance
  especially needs this), and a stated-vs-measured pair rather than a single
  value.
- **Per revenue event**: gross booked, and a separate factoring/collection
  status field (paid / funded / denied / short-paid / recoursed /
  rejected), never collapsed into a single "revenue" number.
- **Per transfer**: an explicit intercompany flag, independent of any
  inferred reason for the transfer.
- **Per financing obligation**: separate principal and interest, a link to
  the amortization schedule, and the remaining unpaid balance as a queryable
  liability, not just a recurring payment amount.

---

## 13. Reading this alongside operational (TMS) data

Where this accounting model meets dispatch/TMS data (loads, miles, driver
assignments), two joins matter most:

- **Mileage reconciliation**: this model treats an independently-measured
  mileage source (ELD/telematics) as stronger evidence than a hand-kept
  sheet, which is in turn stronger than a derived/implied mileage. Since
  cost-per-mile is linear in miles, a mileage error of a given size moves
  every downstream per-mile figure by the same proportion — validate the
  mileage feed before trusting any per-mile cost or margin it produces.
- **Truck-to-company attribution is a per-week fact, not a static
  assignment.** A truck can move between operating companies over its life
  (and even within a single reporting period); attributing a cost or a load
  to "the company running this truck" requires the date, not just the unit
  number.

---

## 14. Provenance (for audit, not execution)

This reference was synthesized from a working forensic accounting pipeline
covering bank statements, weekly P&L workbooks, factoring records, IFTA/tax
filings, insurance policies and invoices, IRP/HVUT registration records, an
Ohio BMV IRP status filing, Iron Lease's own invoicing and TBK equipment-loan
amortization schedules, and operator-supplied rate cards and corrections. The
benchmark figures in §4 reflect a 13-week window ending 2026-08-24; the
registration responsibility model in §5 reflects operator instructions given
2026-09-10. Neither this pipeline's source code nor its raw documents are
assumed to be reachable by a system consuming this reference — treat the
numbers as a dated snapshot and the structure as the durable part.
