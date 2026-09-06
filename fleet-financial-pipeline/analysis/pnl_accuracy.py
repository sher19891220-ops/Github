"""Is the Google-Sheets P&L accurate? Two tiers of test, and only one of them counts.

The sheets are HAND-MAINTAINED. Everything else in this pipeline treats them as
an assertion to be tested, and this module is the test.

TIER 1 -- THE SHEET AGAINST ITSELF. Cheap, runs on every week, and catches
typing and formula damage. It cannot catch a number that is wrong in the same
way in two places, which is the failure mode of a hand-kept sheet, so passing
tier 1 is necessary and proves almost nothing.

TIER 2 -- THE SHEET AGAINST A RECORD IT DID NOT WRITE. This is the real test,
and the strength of each check is exactly how independent the other record is:

    IFTA returns      FILED WITH A STATE under penalty of perjury, by a
                      different person, from the fuel and mileage systems. The
                      strongest external check in the corpus.
    Iron Lease bills  a counterparty's invoice -- independent of the operating
                      company, though not of the group.
    Insurance         signed with a carrier: the premium is a fact, not a view.
    Bank statements   cash cannot be miscoded the way a manual entry can, but it
                      is NOT comparable line for line (see the factoring note).

WHAT A GAP MEANS DEPENDS ENTIRELY ON THE PAIR. Bank deposits sit STRUCTURALLY
below P&L gross because revenue arrives through a factor net of its fee, days
later -- that gap is a real cost, not an error, and reporting it as a
discrepancy would be wrong. The IFTA comparison is the opposite: both sides
claim to count the same miles, so a gap there is somebody's mistake.

MILES ARE NOT ALL THE SAME MILES. The sheet keeps two figures -- odometer miles
(all of them, company drivers only) and loaded miles (every truck, revenue miles
only) -- and IFTA counts EVERY mile of EVERY truck under the authority,
owner-operators included. Comparing the return to loaded miles alone understates
the sheet by the empty ratio and by the whole owner-operator fleet, which on
XTRACK is 43% of the trucks. This scales the owner-operators' loaded miles by the
company drivers' own odometer-to-loaded ratio and says so.
"""
import argparse
import functools
import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import parse_tax_and_insurance as X   # noqa: E402
import truck_breakeven as B      # noqa: E402
import truck_weeks as T          # noqa: E402
from xtrack_trend import load as load_weeks   # noqa: E402

COMPANIES = ("ZONE", "XTRACK", "AFG")
# Tolerances, each chosen against what the pair can actually agree to.
TIE = 1.0                 # sheet against itself: it is arithmetic, so a dollar
IFTA_MILES_TOL = 0.05     # different systems counting the same trucks
# The band a Class 8 fleet mpg has to fall in. Reused from the IFTA reader
# rather than re-invented, widened only because the owner-operator figure here
# is a RESIDUAL (filed gallons less the company drivers' measured burn) and so
# carries both records' error. 3.15 mpg is not a truck; neither is 31.
LO, HI = X.PLAUSIBLE_MPG[0] - 0.5, X.PLAUSIBLE_MPG[1] + 1.5
IFTA_GALLONS_TOL = 0.05
# Below this share of the miles, the owner-operator residual is noise and is
# reported rather than judged.
OO_SHARE_TO_JUDGE = 0.15
QUARTERS = {"2026Q1": ("2026-01-01", "2026-03-31"),
            "2026Q2": ("2026-04-01", "2026-06-30")}
# A quarter is thirteen weeks. Fewer than this and the sheet does not cover the
# return, so the comparison measures the missing weeks and not the accuracy.
MIN_WEEKS_FOR_A_QUARTER = 12


def internal(company):
    """Tier 1: every identity the sheet asserts about itself."""
    wk = load_weeks(ROOT / B.WORKBOOK[company])
    tw = T.truck_weeks(company)
    counted = tw.groupby("week").size().to_dict()
    ks = sorted(wk)
    rows = []
    for k in ks:
        w = wk[k]
        rows.append({
            "week": k,
            "gross": w["gross"],
            # The control CLAUDE.md names: the panel's total must be the trucks.
            "gross_vs_units": w["unit_gross"] - w["gross"],
            # net = CD result + OO result - overhead. Whatever is left over is
            # the sheet disagreeing with itself.
            "net_identity": w["unallocated"],
            "other_itemisation": w.get("item_gap", 0.0),
            "unmapped": dict(w.get("unmapped") or {}),
            # The panel states a truck count of its own. If it disagrees with
            # the number of blocks on the tab, one of them is stale -- and in
            # XTRACK's 06-01 week the panel says 45 while 46 blocks are there.
            "trucks_stated": (w.get("cd_trucks") or 0) + (w.get("oo_trucks") or 0),
            "trucks_counted": counted.get(k, 0),
        })
    return ks, rows


def week_coverage(ks):
    """Missing and duplicated weeks. A hand-kept tab list loses one silently."""
    import datetime as dt
    d = [dt.date.fromisoformat(k) for k in ks]
    missing = []
    for a, b in zip(d, d[1:]):
        gap = (b - a).days
        if gap != 7:
            missing.append((a.isoformat(), b.isoformat(), gap))
    return missing, len(ks) - len(set(ks))


@functools.lru_cache(maxsize=None)
def _returns():
    """Every IFTA return, read once.

    Extracting 177 PDFs takes about a minute, and this is called for each
    company and again for the cross-authority netting. Without the cache the
    audit reads the whole IFTA corpus six times and times out.
    """
    return tuple(X.load_ifta())


@functools.lru_cache(maxsize=None)
def ifta_check(company):
    """Tier 2, the strongest one: the sheet against a return filed with a state.

    Returns one row per quarter the sheet actually covers. A quarter the sheet
    covers only partly is REPORTED AND SKIPPED, never compared -- the gap would
    be the missing weeks, and reading that as an error would condemn a sheet for
    not existing yet.
    """
    returns = [r for r in _returns() if r.get("total_miles")]
    name = {"ZONE": "ZONE", "XTRACK": "XTRACK", "AFG": "AFG"}[company]
    mine = [r for r in returns if name in (r.get("legal_name") or "").upper()]

    wk = load_weeks(ROOT / B.WORKBOOK[company])
    tw = T.truck_weeks(company)
    out = []
    for r in mine:
        pe = r.get("period_end")
        q = next((q for q, (a, b) in QUARTERS.items()
                  if pe and b.replace("-", "/")[5:] in str(pe)), None)
        q = q or next((q for q, (a, b) in QUARTERS.items()
                       if _same_quarter(pe, b)), None)
        if not q:
            continue
        a, b = QUARTERS[q]
        ks = [k for k in sorted(wk) if a <= k <= b]
        row = {"quarter": q, "weeks_in_sheet": len(ks),
               "filed_miles": r["total_miles"], "filed_gallons": r.get("total_gallons"),
               "source": r.get("source", "")}
        if len(ks) < MIN_WEEKS_FOR_A_QUARTER:
            row["skipped"] = (f"the sheet covers {len(ks)} of ~13 weeks -- the gap "
                              f"would be the missing weeks, not an error")
            out.append(row)
            continue
        cd_odo = sum(wk[k]["cd_odo"] for k in ks)
        cd_loaded = sum(wk[k]["cd_miles"] for k in ks)
        cd_gal = sum(wk[k]["cd_gallons"] for k in ks)
        oo_loaded = tw[tw.week.isin(ks) & (tw.kind == "owner_operator")].miles.sum()
        # Owner-operators keep no odometer column here, so scale their loaded
        # miles by the company drivers' own empty ratio. Named, not hidden.
        empty_ratio = cd_odo / cd_loaded if cd_loaded else 1.0
        sheet_miles = cd_odo + oo_loaded * empty_ratio
        row.update({"cd_odo": cd_odo, "oo_loaded": oo_loaded,
                    "empty_ratio": empty_ratio, "sheet_miles": sheet_miles,
                    "miles_gap": sheet_miles - r["total_miles"],
                    "miles_gap_pct": (sheet_miles - r["total_miles"]) / r["total_miles"],
                    "cd_gallons": cd_gal,
                    "sheet_mpg": cd_odo / cd_gal if cd_gal else None,
                    "filed_mpg": (r["total_miles"] / r["total_gallons"]
                                  if r.get("total_gallons") else None)})
        # What the FILED gallons imply for the owner-operators, once the company
        # drivers' own measured burn is taken out. An impossible mpg here is the
        # return being wrong, not the sheet.
        oo_miles = oo_loaded * empty_ratio
        oo_gal = (r["total_gallons"] or 0) - cd_gal
        row["implied_oo_mpg"] = (oo_miles / oo_gal) if oo_gal > 0 else None
        # Judge the FUEL on gallons, not on the derived owner-operator mpg: a
        # residual divides by a small number and swings, while the gallon gap
        # is a direct comparison and reads the same way for every company.
        row["sheet_gallons"] = (sheet_miles / row["sheet_mpg"]) if row["sheet_mpg"] else None
        row["gallons_gap"] = ((r["total_gallons"] or 0) - row["sheet_gallons"]
                              if row["sheet_gallons"] else None)
        row["gallons_gap_pct"] = (row["gallons_gap"] / r["total_gallons"]
                                  if row["gallons_gap"] is not None and r["total_gallons"]
                                  else None)
        out.append(row)
    return out


def _same_quarter(period_end, quarter_end):
    if not period_end:
        return False
    s = str(period_end).replace("-", "/")
    m, d, *_ = (s.split("/") + ["", ""])[:3]
    qm = quarter_end.split("-")[1]
    return m.zfill(2) == qm


def iron_lease_check(company):
    """Tier 2: rent charged in the sheet against Iron Lease's own rate card."""
    tw = T.truck_weeks(company)
    iron = tw[tw.iron_leased & (tw.kind == "company_driver")]
    if not len(iron):
        return None
    return {"truck_weeks": len(iron),
            "charged": float(iron.rent.sum()),
            "contract": float(iron.iron_rent_due.sum()),
            "gap": float(iron.rent.sum() - iron.iron_rent_due.sum())}


def cross_authority(cos, quarter="2026Q2"):
    """The gallons the returns are missing, netted across the authorities.

    Each company's return is checked against its own sheet above. Netting them
    is a different question and the more useful one: if one authority reports
    too FEW gallons and another too MANY in the same quarter, that is not two
    unrelated errors, it is one fuel allocation split the wrong way between two
    IFTA accounts -- and it would net out at group level while leaving each
    filing wrong on its own.
    """
    rows = []
    for co in cos:
        for r in ifta_check(co):
            if r.get("quarter") != quarter or "skipped" in r:
                continue
            # What the sheet's own measured burn says this fleet should have
            # used, at the mpg its company drivers actually achieved.
            rows.append((co, r["filed_gallons"], r["sheet_gallons"], r["gallons_gap"]))
    if len(rows) < 2:
        return
    print(f"\n  ACROSS THE AUTHORITIES, {quarter}")
    print(f"    {'':<10}{'gallons filed':>15}{'gallons the sheet':>19}{'difference':>14}")
    for co, filed, need, d in rows:
        print(f"    {co:<10}{filed:>15,.0f}{need:>19,.0f}{d:>+14,.0f}")
    net = sum(d for _, _, _, d in rows if d is not None)
    tot = sum(f for _, f, _, _ in rows)
    print(f"    {'NET':<10}{tot:>15,.0f}{'':>19}{net:>+14,.0f}")
    # Only the materially wrong ones. AFG is 2.4% out on a small fleet and
    # naming it here would turn a return that ties into part of a finding.
    over = [co for co, f, _, d in rows if d and f and d / f > IFTA_GALLONS_TOL]
    under = [co for co, f, _, d in rows if d and f and d / f < -IFTA_GALLONS_TOL]
    if over and under:
        print(f"    {', '.join(over)} filed MORE gallons than its trucks burnt and "
              f"{', '.join(under)} filed FEWER,")
        print("    in the same quarter. Two unrelated errors would not point opposite")
        print("    ways: this is one fuel allocation split the wrong way between two")
        print("    IFTA accounts. It roughly nets out at group level and leaves each")
        print("    return wrong on its own -- and the direction decides the risk.")
        print("    Understating gallons UNDERSTATES the tax owed, which is the side an")
        print("    audit collects on.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--company", default="all")
    a = ap.parse_args()
    cos = COMPANIES if a.company == "all" else (a.company.upper(),)

    print("=" * 78)
    print("TIER 1 -- THE SHEET AGAINST ITSELF")
    print("  Arithmetic the sheet asserts about its own numbers. Cheap, and it")
    print("  cannot catch a figure that is wrong the same way twice.")
    print("=" * 78)
    tier1 = {}
    for co in cos:
        ks, rows = internal(co)
        bad_gross = [r for r in rows if abs(r["gross_vs_units"]) > TIE]
        net_gap = sum(abs(r["net_identity"]) for r in rows)
        gross = sum(r["gross"] for r in rows)
        item = [r for r in rows if abs(r["other_itemisation"]) > TIE]
        unmapped = [r for r in rows if r["unmapped"]]
        missing, dup = week_coverage(ks)
        miscount = [r for r in rows
                    if r["trucks_stated"] and r["trucks_stated"] != r["trucks_counted"]]
        tier1[co] = dict(weeks=len(ks), gross=gross, bad_gross=bad_gross,
                         net_gap=net_gap, item=item, unmapped=unmapped,
                         missing=missing)
        print(f"\n  {co}  {len(ks)} weeks, {ks[0]} .. {ks[-1]}, ${gross:,.0f} of gross")
        print(f"    panel gross == sum of the unit rows      "
              f"{'PASS' if not bad_gross else 'FAIL on %d of %d weeks' % (len(bad_gross), len(ks))}")
        if bad_gross:
            tot = sum(r["gross_vs_units"] for r in bad_gross)
            print(f"      net ${tot:,.0f} ({100 * tot / gross:+.2f}% of gross). "
                  f"The unit rows and the panel are not the same number:")
            for r in bad_gross[:12]:
                print(f"        {r['week']}  {r['gross_vs_units']:>+10,.0f}")
        print(f"    net == CD + OO - overhead                "
              f"${net_gap:,.0f} unexplained over the period "
              f"({100 * net_gap / gross:.2f}% of gross)")
        print(f"    'Other charges' itemisation ties         "
              f"{'PASS' if not item else 'FAIL on %d weeks' % len(item)}")
        print(f"    every block header recognised            "
              f"{'PASS' if not unmapped else 'FAIL on %d weeks' % len(unmapped)}")
        print(f"    no missing or duplicated weeks           "
              f"{'PASS' if not missing else 'GAPS: %s' % missing}")
        print(f"    panel truck count == blocks on the tab   "
              f"{'PASS' if not miscount else 'FAIL on %d of %d weeks' % (len(miscount), len(ks))}")
        for r in miscount[:6]:
            print(f"        {r['week']}  panel says {r['trucks_stated']:.0f}, "
                  f"{r['trucks_counted']} blocks on the tab")

    print("\n" + "=" * 78)
    print("TIER 2 -- THE SHEET AGAINST A RECORD IT DID NOT WRITE")
    print("  This is the test that counts. IFTA returns are filed with a state")
    print("  under penalty, from the fuel and mileage systems, by someone else.")
    print("=" * 78)
    for co in cos:
        print(f"\n  {co}")
        rows = ifta_check(co)
        if not rows:
            print("    no IFTA return in the corpus for this authority")
        for r in rows:
            if "skipped" in r:
                print(f"    {r['quarter']}: NOT COMPARED -- {r['skipped']}")
                continue
            v = "TIES" if abs(r["miles_gap_pct"]) <= IFTA_MILES_TOL else "DIFFERS"
            print(f"    {r['quarter']}  MILES  {v}")
            print(f"      filed with the state              {r['filed_miles']:>12,.0f}")
            print(f"      sheet: company-driver odometer    {r['cd_odo']:>12,.0f}")
            print(f"           + owner-operator loaded x {r['empty_ratio']:.3f}"
                  f"{r['oo_loaded'] * r['empty_ratio']:>10,.0f}")
            print(f"      sheet total                       {r['sheet_miles']:>12,.0f}")
            print(f"      gap                               {r['miles_gap']:>+12,.0f}"
                  f"   {100 * r['miles_gap_pct']:+.1f}%")
            if r["filed_mpg"]:
                gap, pct = r["gallons_gap"], r["gallons_gap_pct"]
                v = "TIES" if abs(pct) <= IFTA_GALLONS_TOL else "DIFFERS"
                print(f"    {r['quarter']}  FUEL   {v}")
                print(f"      gallons filed                     {r['filed_gallons']:>12,.0f}")
                print(f"      gallons the sheet's own mpg needs {r['sheet_gallons']:>12,.0f}"
                      f"   ({r['sheet_miles']:,.0f} mi at {r['sheet_mpg']:.2f})")
                print(f"      gap                               {gap:>+12,.0f}"
                      f"   {100 * pct:+.1f}%")
                print(f"      mpg: return {r['filed_mpg']:.2f}, "
                      f"sheet measures {r['sheet_mpg']:.2f} on its company drivers")
                oo = r["implied_oo_mpg"]
                # The residual mpg is only worth quoting when the owner-operator
                # fleet is big enough to carry it. On AFG it is 8% of the miles,
                # so the residual swings wildly on a rounding and would condemn a
                # return whose miles tie to 0.6%.
                share = (r["oo_loaded"] * r["empty_ratio"]) / r["sheet_miles"]
                if abs(pct) <= IFTA_GALLONS_TOL:
                    print("      The two records agree on fuel as well as miles.")
                elif share < OO_SHARE_TO_JUDGE:
                    print(f"      (owner-operators are only {100 * share:.0f}% of the miles "
                          f"here, so the implied {oo:.1f} mpg residual is noise)")
                elif oo is None:
                    print("      The return's gallons are BELOW what the company drivers")
                    print("      alone burnt, leaving NOTHING for the owner-operators.")
                    print("      The RETURN is wrong, not the sheet.")
                elif not (LO <= oo <= HI):
                    print(f"      implied owner-operator mpg        {oo:>12.2f}  <- not a truck")
                    print("      Take the sheet's own measured burn out of the filed")
                    print("      gallons and what is left cannot have moved the remaining")
                    print("      miles. The RETURN is the odd one out, not the sheet.")

        il = iron_lease_check(co)
        if il:
            print(f"    IRON LEASE RENT over {il['truck_weeks']} company-driver truck-weeks")
            print(f"      charged in the sheet              {il['charged']:>12,.0f}")
            print(f"      due under the rate card           {il['contract']:>12,.0f}")
            print(f"      gap                               {il['gap']:>+12,.0f}"
                  f"   {100 * il['gap'] / il['contract']:+.1f}%")

    if len(cos) > 1:
        cross_authority(cos)

    print("\n" + "=" * 78)
    print("HOW TO CHECK A SHEET LIKE THIS, IN ORDER OF WHAT IT PROVES")
    print("=" * 78)
    print("""
  1. AGAINST A FILING. IFTA, 2290, a tax return: signed, sent outside, and
     penalised if wrong. Nothing in-house is as strong.
  2. AGAINST A COUNTERPARTY. An invoice or a policy the other side wrote --
     Iron Lease's bills, the insurance schedule, a factoring statement.
  3. AGAINST CASH. The bank cannot be miscoded the way a manual entry can. But
     it is not line-comparable: factoring, netting and timing all sit between
     the sheet and the statement, so this proves TOTALS, not entries.
  4. AGAINST A MEASURING DEVICE. Samsara or QuickManage odometers, fuel-card
     gallons. Machine-recorded, and the only thing that settles a mileage
     dispute.
  5. AGAINST ITSELF. Free, and the weakest -- a hand-kept sheet is perfectly
     capable of being internally consistent and wrong.

  What is still missing to finish this: the factoring statements (to price the
  gap between gross and deposits), the ADP register split by employee (to test
  driver pay), and Samsara odometer history (to settle the mileage
  independently of both the sheet and the return).""")


if __name__ == "__main__":
    main()
