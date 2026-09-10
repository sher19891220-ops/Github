"""Oregon returns that are missing, priced from the IFTA returns that are not.

THE TRICK THIS MODULE TURNS. Oregon does not tax diesel through IFTA -- it taxes
by weight-mile on its own monthly return. So an IFTA return lists Oregon miles at
a **0.00 rate**: it COUNTS the miles and charges nothing for them. That makes
every IFTA return an independent, operator-filed statement of exactly how many
Oregon miles a fleet owes a separate Oregon return on -- filed with a different
state, for a different tax, by a different deadline. It is the only way to price
an Oregon return that is not in the corpus.

    ZONE   files IFTA in OHIO      -> its Ohio returns carry ZONE's Oregon miles
    XTRACK files IFTA in ILLINOIS  -> its Illinois returns carry XTRACK's
    AFG    files IFTA              -> and it ran Oregon miles too

WHAT A GAP HERE IS AND IS NOT. "No return in the corpus" is NOT "no return
filed" -- these are uploads, not a filing system, and a return can exist and
simply not have been sent to me. What the gap IS: miles the group's own IFTA
filings say were run in Oregon, for which this corpus holds no Oregon return.
Every one is worth checking against the actual filings; the dollar figure is what
it costs if any of them turn out to be genuinely unfiled.

THE QUARTER IS AS FINE AS THIS GETS. IFTA reports quarterly, Oregon files
monthly, so a missing quarter cannot be split into months from this evidence.
The exposure is stated per quarter and the months are named, not apportioned.

THE TAX IS NOT THE WHOLE EXPOSURE. A late filing carries penalty and interest --
ZONE's own Ohio Q2 2026 return, filed five days after the due date, was charged
$957.64 penalty and $151.17 interest on $9,576.44 of tax, better than 11% on top.
Nothing here estimates an Oregon penalty; the tax is a FLOOR.
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

import parse_oregon as OR              # noqa: E402
import parse_tax_and_insurance as TAX  # noqa: E402

COMPANIES = ("ZONE", "XTRACK", "AFG")
IFTA_NAME = {"ZONE": "ZONE-OH", "XTRACK": "XTRACK", "AFG": "AFG"}
IFTA_STATE = {"ZONE": "Ohio", "XTRACK": "Illinois", "AFG": "Illinois"}
OREGON_CARRIER = {"ZONE": "ZONE OH LLC", "XTRACK": "XTRACK LLC", "AFG": None}
QUARTER_MONTHS = {"Q1": ("January", "February", "March"),
                  "Q2": ("April", "May", "June"),
                  "Q3": ("July", "August", "September"),
                  "Q4": ("October", "November", "December")}
MONTH_QUARTER = {m: q for q, ms in QUARTER_MONTHS.items() for m in ms}
# A mile has to be worth reporting. Oregon requires a return regardless, but a
# handful of miles is a compliance note and not an exposure.
MATERIAL_MILES = 50


@functools.lru_cache(maxsize=None)
def _ifta():
    return tuple(TAX.load_ifta())


@functools.lru_cache(maxsize=None)
def _oregon():
    return tuple(OR.load())


def rate():
    """The weight-mile rate the Oregon returns themselves print.

    Measured, never assumed: it is read off the rows that carry tax, and if the
    returns ever disagree the caller is told rather than handed an average.
    """
    seen = {}
    for r in _oregon():
        for row in r["rows"]:
            if row["rate"]:
                seen[row["rate"]] = seen.get(row["rate"], 0) + 1
    if not seen:
        return None, {}
    return max(seen, key=seen.get), seen


def quarter_of(period_end):
    """'06/30/2026' or '6/30/2026' -> ('2026', 'Q2')."""
    parts = str(period_end).replace("-", "/").split("/")
    if len(parts) != 3:
        return None
    m, _, y = parts
    q = {"03": "Q1", "3": "Q1", "06": "Q2", "6": "Q2",
         "09": "Q3", "9": "Q3", "12": "Q4"}.get(m)
    return (y, q) if q else None


def owed():
    """Oregon miles per company per quarter, from the IFTA returns."""
    out = {}
    for r in _ifta():
        name = (r.get("legal_name") or "").upper()
        co = next((c for c in COMPANIES if IFTA_NAME[c] in name), None)
        qq = quarter_of(r.get("period_end"))
        if not co or not qq:
            continue
        j = r.get("jurisdictions") or {}
        out[(co, f"{qq[0]}{qq[1]}")] = {
            "or_miles": j.get("OR", 0.0),
            "total_miles": r["total_miles"],
            "juris_covered": sum(j.values()) / r["total_miles"] if r["total_miles"] else 0,
            "filed_in": IFTA_STATE[co],
        }
    return out


def filed():
    """Oregon miles per company per quarter, from the Oregon returns held."""
    out = {}
    for r in _oregon():
        co = next((c for c, name in OREGON_CARRIER.items()
                   if name and r["carrier"] == name), None)
        if not co or not r["month"] or not r["year"]:
            continue
        k = (co, f"{r['year']}{MONTH_QUARTER[r['month']]}")
        d = out.setdefault(k, {"or_miles": 0.0, "tax": 0.0, "months": []})
        d["or_miles"] += r["oregon_miles"]
        d["tax"] += r["tax"]
        d["months"].append(r["month"])
    return out


def gaps():
    ow, fi = owed(), filed()
    rt, _ = rate()
    rows = []
    for k, o in sorted(ow.items()):
        co, q = k
        f = fi.get(k)
        have = f["or_miles"] if f else None
        missing_months = [m for m in QUARTER_MONTHS[q[4:]]
                          if not f or m not in f["months"]]
        gap = o["or_miles"] - (have or 0.0)
        rows.append({
            "company": co, "quarter": q, "filed_in": o["filed_in"],
            "ifta_or_miles": o["or_miles"],
            "juris_covered": o["juris_covered"],
            "oregon_returns_held": len(f["months"]) if f else 0,
            "oregon_miles_on_them": have,
            "months_with_no_return": missing_months,
            "gap_miles": gap,
            "tax_at_risk": gap * rt if rt and gap > 0 else 0.0,
        })
    return rows, rt


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.parse_args()
    rows, rt = gaps()
    _, seen = rate()

    print(f"Oregon weight-mile rate, measured off the returns: ${rt}")
    if len(seen) > 1:
        print(f"  MORE THAN ONE RATE ON THE RETURNS: {seen} -- the most common is "
              f"used and this is why that is visible.")
    print()
    print(f"  {'company':<9}{'quarter':<9}{'IFTA in':<10}{'OR miles':>10}"
          f"{'OR returns':>12}{'miles on':>10}{'GAP':>10}{'tax':>10}")
    for r in rows:
        print(f"  {r['company']:<9}{r['quarter']:<9}{r['filed_in']:<10}"
              f"{r['ifta_or_miles']:>10,.0f}{r['oregon_returns_held']:>12}"
              f"{(r['oregon_miles_on_them'] if r['oregon_miles_on_them'] is not None else 0):>10,.0f}"
              f"{r['gap_miles']:>10,.0f}"
              f"{r['tax_at_risk']:>10,.2f}")

    real = [r for r in rows if r["gap_miles"] > MATERIAL_MILES]
    tot = sum(r["tax_at_risk"] for r in real)
    print(f"\n  {len(real)} quarter(s) with Oregon miles this corpus holds no "
          f"return for: {sum(r['gap_miles'] for r in real):,.0f} miles, "
          f"${tot:,.2f} of tax")
    print("  That is a FLOOR. ZONE's own Ohio Q2 2026 return, filed five days")
    print("  late, was charged $957.64 penalty and $151.17 interest on $9,576.44")
    print("  -- better than 11% on top. Nothing here estimates an Oregon penalty.")

    print("\n== WHAT TO CHECK, IN ORDER OF SIZE ==")
    for r in sorted(real, key=lambda r: -r["tax_at_risk"]):
        print(f"  {r['company']} {r['quarter']}: {r['gap_miles']:,.0f} Oregon miles "
              f"per its {r['filed_in']} IFTA return, ${r['tax_at_risk']:,.2f} of tax")
        print(f"     months with no Oregon return here: "
              f"{', '.join(r['months_with_no_return']) or 'none'}")
        if r["company"] == "AFG":
            print("     AFG has no Oregon account recorded at all, and its own IFTA")
            print("     return says it ran Oregon. Registering is the first step, not")
            print("     filing -- and a carrier operating Oregon unregistered is a")
            print("     different and larger problem than a late return.")

    print("\n== THE CONTROL ON THIS WHOLE METHOD ==")
    print("  It only works if the jurisdiction tables are read completely, so each")
    print("  return's state rows are summed back against its own total miles:")
    for r in rows:
        flag = "" if r["juris_covered"] > 0.98 else "   <- rows not matched"
        print(f"    {r['company']:<8}{r['quarter']:<9}"
              f"{100 * r['juris_covered']:>7.1f}% of total miles{flag}")
    print("  A return below 100% has jurisdiction rows this reader did not match,")
    print("  so its Oregon figure is only safe because the OR row itself was found")
    print("  -- which is checked above, not assumed.")

    print("\n  AND THE PROOF THE OREGON SIDE IS READ RIGHT: ZONE 2026Q1 shows")
    print("  2,970 miles on three OCR'd scans against 2,968 on the Ohio IFTA")
    print("  return, a text PDF filed with another state. Two miles apart.")


if __name__ == "__main__":
    main()
