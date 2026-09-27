"""Per-state, per-unit IFTA fuel tax and weight-distance/HUT "permit" tax --
the per-jurisdiction weekly engine cost_structure.py's own docstrings call out
as missing (fuel_tax_per_gallon(), weight_distance_tax_per_mile()), closed by
two REAL per-state inputs neither of which existed in this corpus before:

  real per-unit, per-state MILES        Samsara / Motive weekly mileage
                                         reports. `ingest/ingest_state_mileage.py`
                                         is the parser for those, once a real
                                         export is on hand to build it against
                                         -- see that module for status. Until
                                         then this module takes mileage_rows as
                                         a plain argument so it is fully built
                                         and tested ahead of that parser.
  real per-state FUEL GALLONS PURCHASED already in this corpus: EFS and Relay
                                         fuel transactions both carry a `state`
                                         column (ingest/ingest_efs_fuel.py,
                                         ingest/pull_relay_fuel.py /
                                         ingest/ingest_rails.py) that nothing
                                         downstream had aggregated by state
                                         until gallons_by_state() below.

WHAT "IFTA" AND "PERMIT" MEAN HERE, KEPT AS TWO SEPARATE COLUMNS PER THE
OPERATOR'S OWN WORDS (2026-09-27): "put ifta + permits cost separately for
each state."

  ifta_tax    the standard IFTA fuel-tax liability for THAT state: this
              period's real miles in the state, divided by a fleet mpg, less
              gallons actually purchased there (already taxed at the pump),
              at that state's own per-gallon rate. Every IFTA member
              jurisdiction gets this column, including OR at its real filed
              rate of $0.00 -- Oregon collects nothing through IFTA (see
              cost_structure.py's oregon_per_mile()).
  permit_tax  the SEPARATE per-mile weight-distance / highway-use tax that
              Oregon (monthly weight-mile), Kentucky (KYU, monthly), New York
              (HUT, monthly), Connecticut (HUT) and New Mexico charge
              directly, paid on each state's own site rather than through the
              IFTA return -- config/weight_distance_tax_rates.json's rates x
              this period's real per-unit miles in that state. Every other
              state gets permit_tax == 0.0.

RATES ARE ESTIMATES, NEVER RE-DERIVATIONS. The current quarter has not been
filed yet, so ifta_by_state() uses the MOST RECENTLY FILED quarter's own
per-state rate (parse_tax_and_insurance.jurisdiction_tax_rows()) applied to
this period's real activity -- the same estimate discipline
cost_structure.fuel_tax_per_gallon() already uses fleet-wide, now per state.
A state's printed rate is itself a 2-decimal DISPLAY of a more precise filed
figure (confirmed against a real ZONE-OH return: Kentucky's real KYU rate
divides to ~0.105, printed as 0.11), so a state that files its own surcharge
as a second row (Kentucky, Virginia) has both displayed rates summed into one
effective per-gallon rate here -- close, not exact, and never asserted as
exact until that quarter is itself filed and its own return supersedes the
estimate.

PER-UNIT ALLOCATION. IFTA is filed at the FLEET level, never per truck -- a
state doesn't see or care which of a carrier's trucks ran its miles. So a
unit's ifta_tax share of a state's fleet-level tax is that unit's own share
of the fleet's miles in that state that period -- an allocation of
responsibility, not a filing concept. permit_tax has no such ambiguity: each
state's own flat per-mile rate applies directly to that unit's own real
miles, no allocation needed.
"""
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ingest"))

WD_RATES_PATH = ROOT / "config" / "weight_distance_tax_rates.json"


def _period_end_date(s):
    """Filed returns print period_end as 'MM/DD/YYYY' -- sorting that STRING
    puts '03/31/2026' before '12/31/2025' (lexicographic '0' < '1'), which is
    chronologically backwards. Parse it before comparing."""
    try:
        return datetime.strptime(str(s).strip(), "%m/%d/%Y")
    except ValueError:
        return None


def permit_states(path=WD_RATES_PATH):
    """{state: $/mile} for the five weight-distance/HUT states -- the same
    config cost_structure.weight_distance_tax_per_mile() already reads."""
    return json.loads(Path(path).read_text())["rates_per_mile_80000lb"]


def gallons_by_state(fuel_rows):
    """{state: gallons} from already-loaded, already-fuel-filtered EFS or
    Relay rows -- either shape works since both carry `state`. EFS rows carry
    the purchased quantity as `qty` (a diesel line item); Relay rows carry it
    as `gallons` on a type=="Fuel" row. The caller has already restricted the
    rows to real diesel/fuel purchases (ingest_efs_fuel.py's DIESEL filter,
    pull_relay_fuel.py's type=="Fuel") -- this function only sums by state."""
    out = {}
    for r in fuel_rows:
        st = (r.get("state") or "").strip().upper()
        if not st:
            continue
        g = r.get("gallons")
        if g is None:
            g = r.get("qty")
        out[st] = out.get(st, 0.0) + (g or 0.0)
    return out


def rates_by_state(jurisdiction_rows):
    """Sum each state's filed rate(s) from parse_tax_and_insurance.
    jurisdiction_tax_rows() -- a state with its own surcharge row (Kentucky's
    KYU, Virginia's own second line) files it as a second row at a different
    rate, and both belong in that state's real effective per-gallon cost."""
    out = {}
    for r in jurisdiction_rows:
        out[r["state"]] = out.get(r["state"], 0.0) + r["rate"]
    return out


def miles_by_state(mileage_rows):
    out = {}
    for r in mileage_rows:
        out[r["state"]] = out.get(r["state"], 0.0) + r["miles"]
    return out


def fleet_mpg(mileage_rows, total_gallons):
    """This period's own real mpg -- total real miles (every state, every
    unit) over total real gallons purchased anywhere -- rather than a stale
    filed-quarter mpg, matching fuel_actuals.py's own reasoning for using a
    week's real gallons instead of an assumed mpg."""
    total_miles = sum(r["miles"] for r in mileage_rows)
    return total_miles / total_gallons if total_gallons else None


def ifta_by_state(mileage_rows, gallons_state, rate_state, mpg):
    """{state: {state_miles, taxable_gallons, gallons_purchased,
    net_taxable_gallons, rate, ifta_tax}} -- fleet level, one row per state
    that had real miles this period. A state with no rate on file (never
    filed for) or no usable mpg is skipped, never zeroed -- zero would read
    as "no tax owed" instead of "not computable yet"."""
    out = {}
    if not mpg:
        return out
    for st, miles in miles_by_state(mileage_rows).items():
        rate = rate_state.get(st)
        if rate is None:
            continue
        taxable_gallons = miles / mpg
        purchased = gallons_state.get(st, 0.0)
        net = taxable_gallons - purchased
        out[st] = {"state_miles": round(miles, 1),
                   "taxable_gallons": round(taxable_gallons, 2),
                   "gallons_purchased": round(purchased, 2),
                   "net_taxable_gallons": round(net, 2),
                   "rate": rate, "ifta_tax": round(net * rate, 2)}
    return out


def latest_rate_state(legal_name_substring, ifta_returns):
    """Real per-state rates from THIS company's own MOST RECENTLY FILED IFTA
    return -- matched the same way cost_structure.py's IFTA_NAME /
    fuel_tax_per_mile() already match a company to its returns: the company's
    legal-name substring found in the return's own uppercased legal_name.
    `ifta_returns` is parse_tax_and_insurance.load_ifta()'s output (or a
    slice of it) -- passed in rather than loaded here so this stays testable
    without touching the real, gitignored PDF corpus.

    Returns (rate_state, period_end) so a caller can show which quarter the
    estimate came from -- ({}, None) if this company has no usable return.
    """
    name = legal_name_substring.upper()
    candidates = []
    for r in ifta_returns:
        if name not in (r.get("legal_name") or "").upper():
            continue
        if not r.get("jurisdiction_tax_rows"):
            continue
        d = _period_end_date(r.get("period_end"))
        if d is None:
            continue
        candidates.append((d, r))
    if not candidates:
        return {}, None
    _, latest = max(candidates, key=lambda pair: pair[0])
    return rates_by_state(latest["jurisdiction_tax_rows"]), latest.get("period_end")


def unit_state_report(mileage_rows, gallons_state, rate_state, mpg, permit_rates=None):
    """The combined per-unit, per-state table: ifta_tax and permit_tax as two
    separate columns for every (company, unit, state) this period saw real
    miles in -- one row per mileage_rows entry, never invented for a
    (unit, state) pair with no real mileage.

    ifta_tax is this unit's MILES-SHARE of that state's fleet-level ifta_tax
    (see module docstring: IFTA is filed at the fleet level, so a truck's
    share of the liability is its share of the state's miles). permit_tax is
    computed directly per unit, no allocation.
    """
    permit_rates = permit_rates if permit_rates is not None else permit_states()
    ifta_state = ifta_by_state(mileage_rows, gallons_state, rate_state, mpg)
    state_totals_miles = miles_by_state(mileage_rows)
    out = []
    for r in mileage_rows:
        st, miles = r["state"], r["miles"]
        row = {"company": r.get("company"), "period": r.get("period"),
               "unit": r["unit"], "state": st, "miles": miles,
               "ifta_tax": 0.0, "permit_tax": 0.0}
        s = ifta_state.get(st)
        if s and state_totals_miles.get(st):
            row["ifta_tax"] = round((miles / state_totals_miles[st]) * s["ifta_tax"], 2)
        pr = permit_rates.get(st)
        if pr is not None:
            row["permit_tax"] = round(miles * pr, 2)
        out.append(row)
    return out
