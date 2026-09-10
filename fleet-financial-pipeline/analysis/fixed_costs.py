"""
Fixed cost per company, from two directions that answer different halves.

ALLOCATED VIEW -- the group's own "Fixed costs by company" rates multiplied by
the trucks each company actually runs. This is what the business prices with,
and it is the only view that splits cost across the three trucking companies at
all.

CASH VIEW -- what left the bank on fixed-cost categories. Verified, but it
cannot split by company, because Zone's account pays for everything: in 2026
Xtrack's own accounts show $0 of rent, $0 of insurance and $0 of software.

Neither is wrong; they measure different things and disagree for reasons worth
naming:

  * The sheet's TRUCK RENT rate is stale. It prices a rented fleet at
    $843-889 a truck-week, but the group stopped renting from STL in October
    2025 and now buys through Iron Lease. Cash rent in 2026 annualises to
    $1.21M against the $3.9M the rate implies. An owned truck costs debt
    service and depreciation, not rent.

  * BACK-OFFICE SALARIES cannot be verified from cash. ADP is one payroll rail
    for at least five companies and mixes drivers with office staff, so the
    bank cannot say what the office costs. The sheet's rate is the only figure
    available and it is an assertion.

  * The OFFSHORE back office ($965,204 to ZONEOH Freight Insights over 19
    international wires) is paid entirely from Zone accounts, so cash charges
    100% of it to Zone. It serves all three companies.

  * NO PREMISES RENT appears anywhere in the corpus -- $631 in three years. If
    the group pays for an office or a yard it is not visible in these accounts.

Two kinds of fixed cost are kept apart throughout, because they behave
differently when the fleet changes size:

  per-truck fixed   truck and trailer, insurance, ELD, transponder, telematics.
                    Fixed per truck, so it scales with the fleet.
  overhead          office staff, software, phones. Does not move when a truck
                    is added or parked.

Usage:
    python analysis/fixed_costs.py --pnl out/ --cash cash_categorized.csv --month 2026-08
"""
import argparse
import collections
import csv
from datetime import datetime
from pathlib import Path

# "Fixed costs by company", per truck per week
RATES = {
    "ZONE": {"Truck rent": 842.95, "Trailer rent": 141.58,
             "Insurance cargo/liability": 231.52, "Insurance physical": 103.46,
             "Occupational accident": 24.90, "ELD": 7.35, "Transponders": 5.00,
             "Samsara": 8.88, "Verizon": 3.34, "Trippak": 3.62, "QuickManage": 2.66,
             "ADP fee": 7.14, "DAT": 11.05, "QuickBooks": 0.51, "8x8 phones": 2.29,
             "Outlook": 1.45, "Back-office salaries": 443.54},
    "XTRACK": {"Truck rent": 877.53, "Trailer rent": 132.75,
               "Insurance cargo/liability": 233.68, "Insurance physical": 103.46,
               "Occupational accident": 24.90, "ELD": 9.38, "Transponders": 5.00,
               "Samsara": 8.88, "Verizon": 3.34, "Trippak": 3.62, "QuickManage": 2.73,
               "ADP fee": 6.59, "DAT": 1.24, "QuickBooks": 0.19, "8x8 phones": 1.66,
               "Outlook": 2.02, "Back-office salaries": 354.16},
    "AFG": {"Truck rent": 888.57, "Trailer rent": 121.42,
            "Insurance cargo/liability": 225.23, "Insurance physical": 103.46,
            "Occupational accident": 24.90, "ELD": 11.18, "Transponders": 5.00,
            "Samsara": 8.88, "Verizon": 3.34, "Trippak": 3.62, "QuickManage": 2.73,
            "ADP fee": 0.0, "DAT": 0.0, "QuickBooks": 0.67, "8x8 phones": 3.00,
            "Outlook": 3.96, "Back-office salaries": 321.42},
}
PER_TRUCK = ["Truck rent", "Trailer rent", "Insurance cargo/liability",
             "Insurance physical", "Occupational accident", "ELD", "Transponders",
             "Samsara", "Verizon", "Trippak", "QuickManage"]
OVERHEAD = ["ADP fee", "DAT", "QuickBooks", "8x8 phones", "Outlook",
            "Back-office salaries"]
FIXED_CATS = ["lease_rent", "insurance_premium", "subscriptions_saas",
              "registration", "permits", "related_party_review", "loan_finance"]
ACCOUNTS = {"ZONE": ["0271", "1558"], "XTRACK": ["5745", "5525"], "AFG": ["4504"],
            "TRUCKMAX": ["8660"], "IRON_LEASE": ["5151"]}
WEEKS_PER_MONTH = 4.333


def trucks_running(pnl_dir, entity, month):
    p = Path(pnl_dir) / f"pnl_unit_week_{entity}.csv"
    if not p.exists():
        return 0.0
    wk = collections.defaultdict(set)
    for r in csv.DictReader(p.open()):
        if r.get("week_start", "")[:7] == month and r.get("unit"):
            try:
                if float(r["gross"] or 0) > 0:
                    wk[r["week_start"]].add(r["unit"])
            except ValueError:
                pass
    return sum(len(v) for v in wk.values()) / len(wk) if wk else 0.0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pnl", required=True)
    ap.add_argument("--cash", required=True)
    ap.add_argument("--month", default="2026-08")
    ap.add_argument("--cash-from", default="2026-01-01")
    a = ap.parse_args()

    print(f"\nALLOCATED — the group's own per-truck rates x trucks running in {a.month}\n")
    print(f"{'company':<10}{'trucks':>7}{'$/truck/wk':>12}{'per week':>12}"
          f"{'per month':>13}{'PER YEAR':>14}")
    print("-" * 68)
    grand = collections.defaultdict(float)
    for e, r in RATES.items():
        n = trucks_running(a.pnl, e, a.month)
        pt = sum(r[k] for k in PER_TRUCK)
        oh = sum(r[k] for k in OVERHEAD)
        tt = pt + oh
        print(f"{e:<10}{n:>7.0f}{tt:>12,.2f}{tt * n:>12,.0f}"
              f"{tt * n * WEEKS_PER_MONTH:>13,.0f}{tt * n * 52:>14,.0f}")
        print(f"{'  equipment':<10}{'':>7}{pt:>12,.2f}{pt * n:>12,.0f}"
              f"{pt * n * WEEKS_PER_MONTH:>13,.0f}{pt * n * 52:>14,.0f}")
        print(f"{'  overhead':<10}{'':>7}{oh:>12,.2f}{oh * n:>12,.0f}"
              f"{oh * n * WEEKS_PER_MONTH:>13,.0f}{oh * n * 52:>14,.0f}")
        grand["trucks"] += n
        grand["wk"] += tt * n
        grand["pt"] += pt * n
        grand["oh"] += oh * n
    print("-" * 68)
    print(f"{'3 TRUCKING COS':<10}{grand['trucks']:>7.0f}"
          f"{grand['wk'] / max(grand['trucks'], 1):>12,.2f}{grand['wk']:>12,.0f}"
          f"{grand['wk'] * WEEKS_PER_MONTH:>13,.0f}{grand['wk'] * 52:>14,.0f}")
    print(f"{'  equipment':<10}{'':>7}{'':>12}{grand['pt']:>12,.0f}"
          f"{grand['pt'] * WEEKS_PER_MONTH:>13,.0f}{grand['pt'] * 52:>14,.0f}")
    print(f"{'  overhead':<10}{'':>7}{'':>12}{grand['oh']:>12,.0f}"
          f"{grand['oh'] * WEEKS_PER_MONTH:>13,.0f}{grand['oh'] * 52:>14,.0f}")

    rows = [r for r in csv.DictReader(Path(a.cash).open())
            if float(r["amount"]) < 0 and r["date"] >= a.cash_from]
    print(f"\n\nCASH — what actually left the bank on these categories "
          f"since {a.cash_from}\n")
    print(f"{'account of':<12}{'rent':>11}{'insurance':>11}{'software':>10}"
          f"{'reg/permit':>11}{'offshore':>11}{'debt':>10}{'/YEAR':>13}")
    print("-" * 79)
    for e, accs in ACCOUNTS.items():
        g = [r for r in rows if r["account"] in accs]
        if not g:
            continue
        d0 = datetime.fromisoformat(min(r["date"] for r in g))
        d1 = datetime.fromisoformat(max(r["date"] for r in g))
        mo = max((d1 - d0).days / 30.44, 1)
        v = {k: sum(abs(float(r["amount"])) for r in g if r["category"] == k)
             for k in FIXED_CATS}
        tot = sum(v.values())
        print(f"{e:<12}{v['lease_rent']:>11,.0f}{v['insurance_premium']:>11,.0f}"
              f"{v['subscriptions_saas']:>10,.0f}"
              f"{v['registration'] + v['permits']:>11,.0f}"
              f"{v['related_party_review']:>11,.0f}{v['loan_finance']:>10,.0f}"
              f"{tot / mo * 12:>13,.0f}")
    print("-" * 79)
    print("\n  Cash cannot split fixed cost by company: Zone's accounts pay for all")
    print("  three. It also cannot see back-office salaries, which sit inside an ADP")
    print("  draft shared with driver pay and with at least four other entities.")


if __name__ == "__main__":
    main()
