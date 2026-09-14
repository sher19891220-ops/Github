"""
Cost allocation & break-even calculation engine.

Pure, source-agnostic math: every function here takes plain numbers (or a
`CostInputs`/`EntityBasis` built from them) and returns a number. Nothing in
this module reads a file, queries a database, or knows about ZONE/XTRACK/AFG
by name -- that keeps it usable from the current static pipeline today and
from a live feed (Postgres, an API) later without changing a single formula.
See COST_METHODOLOGY.md for the plain-English explanation of every formula
and allocation method below, and for why the overhead_pct_of_gross term
exists (it does NOT appear in a textbook break-even formula, and leaving it
out silently overstates margin for this business).

`from_cost_breakdown_view()` at the bottom is the one adapter in this file:
it builds real CostInputs from data/processed/cost_breakdown_view.json (a
pipeline output already reviewed and used elsewhere in this dashboard), so
the engine can be checked against numbers this project has already spent
weeks establishing -- see tests/test_breakeven_engine.py's parity tests.
"""
from dataclasses import dataclass
from enum import Enum


@dataclass(frozen=True)
class CostInputs:
    """Cost inputs for one truck, driver, or company over one period.

    `fixed_costs_total` and `variable_cost_per_mile` are LEVEL-AGNOSTIC on
    purpose -- for a truck they are that truck's own fixed cost and $/mile;
    for a company they are the already-summed fleet fixed cost and a
    fleet-average $/mile. Section 4.3's "company break-even" is just this
    same math run on company-level aggregates (see `company_breakeven_rpm`).

    `overhead_pct_of_gross` is the share of GROSS REVENUE that never reaches
    the truck at all -- factoring fees, dispatch commission, and any
    revenue-rated cost (e.g. cargo insurance billed as % of revenue). It is
    OPTIONAL and defaults to 0.0, which collapses every formula below to the
    literal textbook shape (fixed/miles + variable/mile). This business
    measures it at 3.29-4.69% per company (facts.json variable/overhead_pct
    _of_gross) and leaving it at 0.0 for a fleet where it is real materially
    overstates every margin and understates every break-even mile figure.
    """
    fixed_costs_total: float
    variable_cost_per_mile: float
    miles_driven: float
    days_in_period: float
    revenue: float | None = None
    revenue_per_mile: float | None = None
    overhead_pct_of_gross: float = 0.0

    def __post_init__(self):
        if self.miles_driven < 0 or self.days_in_period <= 0:
            raise ValueError("miles_driven must be >= 0 and days_in_period > 0")
        if not 0.0 <= self.overhead_pct_of_gross < 1.0:
            raise ValueError("overhead_pct_of_gross must be in [0, 1)")

    def rpm(self) -> float:
        """Revenue per mile, from whichever of revenue/revenue_per_mile was given."""
        if self.revenue_per_mile is not None:
            return self.revenue_per_mile
        if self.revenue is not None and self.miles_driven > 0:
            return self.revenue / self.miles_driven
        raise ValueError("need revenue or revenue_per_mile to compute rpm")


def contribution_per_mile(inputs: CostInputs, rpm: float) -> float:
    """What a mile actually keeps after the revenue-linked cut and the direct
    variable cost -- the number break-even and margin are both built from."""
    return rpm * (1 - inputs.overhead_pct_of_gross) - inputs.variable_cost_per_mile


def breakeven_per_mile(inputs: CostInputs) -> float:
    """Section 4.2: the rate/mile this truck needs, AT ITS CURRENT MILES, to
    cover its own fixed cost. (Section 4.2 as written has no overhead_pct
    term; this is that formula generalized -- pct=0.0 reduces to it exactly.)
    """
    if inputs.miles_driven == 0:
        return float("inf")
    return ((inputs.fixed_costs_total / inputs.miles_driven)
             + inputs.variable_cost_per_mile) / (1 - inputs.overhead_pct_of_gross)


def breakeven_miles(inputs: CostInputs, rpm: float) -> float:
    """The other direction: at a GIVEN rate/mile, how many miles this truck
    needs to run to break even. Not in the prompt's Section 4 by name, but
    it is the more commonly asked question in practice ("how many miles do
    I need at $2.93/mile") and it is what this project's own dashboard
    already reports as its headline break-even figure."""
    c = contribution_per_mile(inputs, rpm)
    return inputs.fixed_costs_total / c if c > 0 else float("inf")


def breakeven_per_day(inputs: CostInputs) -> float:
    """Section 4.1: the REVENUE (not rate) this truck needs per day to break
    even, given its current miles/day. Section 4.1 as written is
    fixed/days + variable*avg_miles_per_day; this divides that by
    (1 - overhead_pct_of_gross) for the same reason breakeven_per_mile does
    -- a dollar of revenue does not all reach the truck."""
    avg_miles_per_day = inputs.miles_driven / inputs.days_in_period
    return ((inputs.fixed_costs_total / inputs.days_in_period)
             + inputs.variable_cost_per_mile * avg_miles_per_day) / (1 - inputs.overhead_pct_of_gross)


def margin_per_mile(inputs: CostInputs) -> float:
    """Section 4.4: revenue/mile actually earned minus the rate/mile that
    would have broken even at these same miles."""
    return inputs.rpm() - breakeven_per_mile(inputs)


def profit_per_day(inputs: CostInputs) -> float:
    """Section 4.4: actual revenue/day minus the break-even revenue/day."""
    revenue_per_day = (inputs.revenue / inputs.days_in_period if inputs.revenue is not None
                        else inputs.rpm() * inputs.miles_driven / inputs.days_in_period)
    return revenue_per_day - breakeven_per_day(inputs)


def company_breakeven_per_mile(trucks: list[CostInputs], overhead_pct_of_gross: float = 0.0) -> float:
    """Section 4.3: one fleet-wide rate/mile, from every truck's own fixed
    and variable cost and its own miles. `overhead_pct_of_gross` is a single
    company-level rate applied once at the end, not per truck -- it is a
    weighted-by-revenue rate in reality (see COST_METHODOLOGY.md), so pass
    the company's own measured figure here rather than averaging per-truck
    values, which would weight it by truck count instead of revenue."""
    total_cost = sum(t.fixed_costs_total + t.variable_cost_per_mile * t.miles_driven
                      for t in trucks)
    total_miles = sum(t.miles_driven for t in trucks)
    if total_miles == 0:
        return float("inf")
    return (total_cost / total_miles) / (1 - overhead_pct_of_gross)


class AllocationMethod(str, Enum):
    PER_TRUCK = "per_truck"
    PER_REVENUE_SHARE = "per_revenue_share"
    PER_MILE = "per_mile"


@dataclass(frozen=True)
class EntityBasis:
    """One truck, driver, or company's share of whatever an overhead pool is
    being allocated across -- Section 3.3's three toggleable bases."""
    name: str
    truck_count: float = 0.0
    revenue: float = 0.0
    miles: float = 0.0


_BASIS_FIELD = {
    AllocationMethod.PER_TRUCK: "truck_count",
    AllocationMethod.PER_REVENUE_SHARE: "revenue",
    AllocationMethod.PER_MILE: "miles",
}


def allocate_overhead(pool: float, method: AllocationMethod,
                       entities: list[EntityBasis]) -> dict[str, float]:
    """Section 3.3: split one overhead dollar pool across entities by the
    chosen basis. Returns {entity_name: dollars allocated}; the entities'
    shares always sum back to `pool` (to the penny, modulo float rounding)
    so this can never silently lose or invent overhead dollars."""
    field = _BASIS_FIELD[AllocationMethod(method)]
    shares = {e.name: getattr(e, field) for e in entities}
    total = sum(shares.values())
    if total <= 0:
        raise ValueError(f"total {field} across entities must be > 0 to allocate by it")
    return {name: pool * (share / total) for name, share in shares.items()}


def from_cost_breakdown_view(company_view: dict, overhead_pct_of_gross: float | None = None) -> CostInputs:
    """Build a company-level CostInputs from one company's entry in
    data/processed/cost_breakdown_view.json (analysis/build_cost_breakdown_
    view.py's output, itself read from facts.json). This is the one place
    in this module that assumes a real shape, and it exists so the engine
    can be checked against this project's own already-established numbers
    (see tests/test_breakeven_engine.py) rather than only synthetic fixtures.
    Per-truck-week and per-truck-day figures are both period views of the
    SAME per-truck-week numbers here (days_in_period=7); a real per-truck or
    per-driver period from a live feed would build CostInputs directly
    instead of going through this adapter."""
    fx, vr, cur = company_view["fixed"], company_view["variable"], company_view["current"]
    pct = (vr["overhead_pct_of_gross"] / 100 if overhead_pct_of_gross is None
           else overhead_pct_of_gross)
    return CostInputs(
        fixed_costs_total=fx["true_total_per_truck_week"],
        variable_cost_per_mile=vr["true_total_per_mile"],
        miles_driven=cur["miles_per_truck_week"],
        days_in_period=7,
        revenue_per_mile=cur["rate_per_mile"],
        overhead_pct_of_gross=pct,
    )
