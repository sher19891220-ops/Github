"""
The shop as its own entity: what it costs to run, what it must bill to cover
itself, and what that implies for the trucking companies' maintenance rate.

The shop is NOT trucking overhead. It sells maintenance to ZONE, XTRACK and AFG
and buys parts and labour. So it carries its own P&L, and the trucking side
carries the shop's BILLINGS as a variable cost per mile -- never the shop's own
cost lines. Counting both is the double-count this separation exists to prevent.

On consolidation the shop's revenue eliminates against trucking's maintenance
expense; only parts and outside labour survive as group cost.

What is measured and what is not:
  COST     facility and labour come from config/overhead.json -- operator-supplied.
  PARTS    not supplied. Inferred from the gap between recorded breakdown events
           and labour+facility, which is an inference from a COST log, not a
           purchase ledger.
  REVENUE  not supplied. The Cases log records events by payer, but whether those
           figures are what the shop BILLED or what the event COST is unresolved.

So this reports a cost side that is solid and a revenue side that is provisional,
and says which is which rather than blending them into one number.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from breakeven import load_overhead


def shop_economics(cost_per_week, events_total, event_weeks, fleet_miles):
    """Shop cost against the work it handled, and the implied per-mile rate.

    `events_total` is the recorded cost of breakdown and shop events over
    `event_weeks`; `fleet_miles` is the miles the fleet ran in that same window.
    Returns the weekly figures plus the maintenance rate trucking should carry.
    """
    if event_weeks <= 0 or fleet_miles <= 0:
        raise ValueError("event_weeks and fleet_miles must be positive")
    events_wk = events_total / event_weeks
    return {
        "cost_per_week": cost_per_week,
        "events_per_week": events_wk,
        "parts_implied_per_week": events_wk - cost_per_week,
        "events_per_mile": events_total / fleet_miles,
        "labour_facility_per_mile": cost_per_week * event_weeks / fleet_miles,
    }


def breakeven_at(fixed_per_truck, revenue_per_mile, variable_ex_maint, maint_per_mile):
    """Trucking break-even miles per truck-week at a given maintenance rate."""
    contribution = revenue_per_mile - variable_ex_maint - maint_per_mile
    if contribution <= 0:
        raise ValueError(f"contribution is {contribution:.3f}/mile -- no break-even")
    return fixed_per_truck / contribution, contribution


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--overhead", default="config/overhead.json")
    ap.add_argument("--events-total", type=float, required=True,
                    help="recorded breakdown/shop event cost over the window")
    ap.add_argument("--event-weeks", type=float, required=True)
    ap.add_argument("--fleet-miles", type=float, required=True)
    ap.add_argument("--fixed-per-truck", type=float, default=1133.15,
                    help="trucking fixed cost per truck-week, shop excluded")
    ap.add_argument("--revenue-per-mile", type=float, default=2.717)
    ap.add_argument("--variable-ex-maint", type=float, default=1.602,
                    help="fuel + driver pay + tolls, excluding maintenance")
    a = ap.parse_args()

    ov = load_overhead(a.overhead)
    e = shop_economics(ov["shop"], a.events_total, a.event_weeks, a.fleet_miles)

    print(f"\nSHOP -- standalone entity\n")
    print(f"  {'Facility + mechanics (operator)':<38}{e['cost_per_week']:>12,.0f}/wk"
          f"{e['cost_per_week'] * 52:>14,.0f}/yr")
    print(f"  {'Work handled (events log)':<38}{e['events_per_week']:>12,.0f}/wk"
          f"{e['events_per_week'] * 52:>14,.0f}/yr")
    print(f"  {'Parts, implied by the gap':<38}{e['parts_implied_per_week']:>12,.0f}/wk"
          f"{e['parts_implied_per_week'] * 52:>14,.0f}/yr   INFERRED")
    print(f"\n  The shop must bill at least {e['cost_per_week'] + max(e['parts_implied_per_week'], 0):,.0f}/wk "
          f"to cover itself.")

    print(f"\nMAINTENANCE RATE trucking should carry\n")
    print(f"  {'Recorded events per mile':<38}{e['events_per_mile']:>12,.3f}")
    print(f"  {'Model estimate in use':<38}{0.220:>12,.3f}")
    print(f"\n  {'maint/mile':>12}{'contribution':>15}{'break-even mi':>16}")
    for m in (e["events_per_mile"], 0.160, 0.220):
        be, c = breakeven_at(a.fixed_per_truck, a.revenue_per_mile,
                             a.variable_ex_maint, m)
        print(f"  {m:>12,.3f}{c:>15,.3f}{be:>16,.0f}")
    print("\n  The events log covers breakdowns and shop visits only -- it excludes"
          "\n  PM services, tyres and EFS maintenance purchases, so the true rate sits"
          "\n  ABOVE the recorded figure. The shop ledger settles it.")


if __name__ == "__main__":
    main()
