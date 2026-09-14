"""
Per-company P&L for ZONE, XTRACK and AFG, and a ranked list of what is actually
costing money.

WHAT IS COMPARABLE ACROSS THESE COMPANIES, AND WHAT IS NOT

The three run different pay models. ZONE is largely company-driver; XTRACK and
AFG carry owner-operators and lease-to-own contracts, where the driver is paid
close to the full linehaul and buys their own fuel, insurance and maintenance
out of it. So a cost line that looks high at one company and low at another may
be recording nothing but that difference.

  COMPARABLE      revenue per mile  -- what the customer pays, model-independent
                  margin per mile   -- nets the model out at the company level
                  miles per truck-week -- utilisation, model-independent

  NOT COMPARABLE  driver pay, fuel, truck rent, insurance per mile. An
                  owner-operator's fuel is inside their settlement, not in the
                  fuel line, so a LOW fuel line can mean more owner-operators
                  rather than cheaper fuel. Ranking these as leaks is a category
                  error and this module refuses to do it.

Decontaminating the second group needs the owner-operator split, which lives in
the weekly P&L panel (columns P-V) and nowhere else in the corpus.

MAINTENANCE IS ABSENT FROM THE P&L COST LINES. Margin here is before it. The
shop bills it, so it is charged at the shop-implied band rather than assumed.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from breakeven import load_overhead

COST_LINES = [("driver_salary", "Driver pay"), ("def_fuel_fee", "Fuel & DEF"),
              ("truck_rental", "Truck & trailer rent"), ("toll_scale", "Tolls & scales"),
              ("insur_admin_trl", "Insurance, admin, trailer")]
COMPARABLE = {"revenue_per_mile", "margin_per_mile", "miles_per_truck_week"}
WEEKS_PER_MONTH = 52 / 12


def load_payload(path):
    m = re.search(r'<script id="payload" type="application/json">(.*?)</script>',
                  Path(path).read_text(), re.S)
    if not m:
        raise ValueError(f"{path}: no payload block")
    return json.loads(m.group(1))


def company_slice(entity, year):
    """Aggregate one company's months for `year` into a single period."""
    idx = [i for i, mo in enumerate(entity["months"]) if mo.startswith(year)]
    if not idx:
        raise ValueError(f"no months matching {year}")
    s = entity["series"]
    d = {"months": len(idx), "weeks": len(idx) * WEEKS_PER_MONTH,
         "trucks": sum(entity["units"][i] for i in idx) / len(idx),
         "miles": sum(s["mileage"][i] for i in idx),
         "gross": sum(s["gross"][i] for i in idx),
         "pnl_net": sum(s["total"][i] for i in idx)}
    for k, _ in COST_LINES:
        d[k] = sum(s[k][i] for i in idx)
    d["truck_weeks"] = d["trucks"] * d["weeks"]
    d["margin"] = d["gross"] - sum(d[k] for k, _ in COST_LINES)
    d["revenue_per_mile"] = d["gross"] / d["miles"]
    d["margin_per_mile"] = d["margin"] / d["miles"]
    d["miles_per_truck_week"] = d["miles"] / d["truck_weeks"]
    d["margin_per_truck_week"] = d["margin"] / d["truck_weeks"]
    return d


def rank_gaps(cos, overhead_per_truck_week, maint_per_mile):
    """Rank only the model-independent gaps. Never rank a contaminated line."""
    best_rev = max(c["revenue_per_mile"] for c in cos.values())
    best_util = max(c["miles_per_truck_week"] for c in cos.values())
    out = []
    for name, c in cos.items():
        gap = best_rev - c["revenue_per_mile"]
        if gap > 0.01:
            out.append((name, f"Revenue {gap:.3f}/mi below the best rate in the group",
                        gap * c["miles"], "comparable"))
        ugap = best_util - c["miles_per_truck_week"]
        if ugap > 100:
            out.append((name, f"Utilisation {ugap:,.0f} mi/truck-week below best",
                        ugap * c["margin_per_mile"] * c["truck_weeks"], "comparable"))
    out.sort(key=lambda r: -r[2])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--payload", default="dashboard/console.html")
    ap.add_argument("--overhead", default="config/overhead.json")
    ap.add_argument("--year", default="2026")
    ap.add_argument("--maint-lo", type=float, default=0.102)
    ap.add_argument("--maint-hi", type=float, default=0.220)
    a = ap.parse_args()

    D = load_payload(a.payload)
    ov = load_overhead(a.overhead)
    overhead = ov["us_total"] + ov["tashkent"]
    cos = {k: company_slice(e, a.year) for k, e in D["entities"].items()}
    fleet = sum(c["trucks"] for c in cos.values())
    ohtw = overhead / fleet

    print(f"\n{a.year} year-to-date, from the weekly P&Ls.")
    print(f"Overhead ${overhead:,.0f}/wk over {fleet:.0f} trucks = ${ohtw:,.0f}/truck-week.\n")

    print(f"COMPARABLE ACROSS COMPANIES\n")
    print(f"  {'':<24}{'ZONE':>10}{'XTRACK':>10}{'AFG':>10}")
    for key, lab, spec in [("revenue_per_mile", "Revenue per mile", ",.3f"),
                           ("margin_per_mile", "Margin per mile", ",.3f"),
                           ("miles_per_truck_week", "Miles per truck-week", ",.0f"),
                           ("margin_per_truck_week", "Margin per truck-week", ",.0f")]:
        print(f"  {lab:<24}" + "".join(format(cos[c][key], spec).rjust(10)
                                       for c in ("ZONE", "XTRACK", "AFG")))

    print(f"\nNOT COMPARABLE — pay-model dependent, shown for reference only\n")
    print(f"  {'':<24}{'ZONE':>10}{'XTRACK':>10}{'AFG':>10}")
    for k, lab in COST_LINES:
        print(f"  {lab + ' /mi':<24}" +
              "".join(f"{cos[c][k] / cos[c]['miles']:,.3f}".rjust(10)
                      for c in ("ZONE", "XTRACK", "AFG")))

    print(f"\nNET PER TRUCK-WEEK, after overhead and maintenance\n")
    print(f"  {'':<10}{'margin':>10}{'overhead':>10}{'maint lo':>10}{'maint hi':>10}"
          f"{'NET lo':>10}{'NET hi':>10}")
    tot = [0.0, 0.0]
    for c in ("ZONE", "XTRACK", "AFG"):
        d = cos[c]
        ml, mh = a.maint_lo * d["miles_per_truck_week"], a.maint_hi * d["miles_per_truck_week"]
        lo, hi = d["margin_per_truck_week"] - ohtw - ml, d["margin_per_truck_week"] - ohtw - mh
        tot[0] += lo * d["truck_weeks"]; tot[1] += hi * d["truck_weeks"]
        print(f"  {c:<10}{d['margin_per_truck_week']:>10,.0f}{-ohtw:>10,.0f}"
              f"{-ml:>10,.0f}{-mh:>10,.0f}{lo:>10,.0f}{hi:>10,.0f}")
    print(f"\n  GROUP over the period: {tot[0]:+,.0f} at ${a.maint_lo}/mi maintenance, "
          f"{tot[1]:+,.0f} at ${a.maint_hi}/mi.")
    print(f"  The maintenance rate decides the sign. It is the single most valuable"
          f"\n  unknown left in this model.")

    print(f"\nRANKED GAPS — model-independent only\n")
    print(f"  {'co':<8}{'gap':<52}{'period':>13}{'annualised':>13}")
    for name, lab, cost, _ in rank_gaps(cos, ohtw, a.maint_hi):
        months = cos[name]["months"]
        print(f"  {name:<8}{lab:<52}{cost:>13,.0f}{cost * 12 / months:>13,.0f}")


if __name__ == "__main__":
    main()
