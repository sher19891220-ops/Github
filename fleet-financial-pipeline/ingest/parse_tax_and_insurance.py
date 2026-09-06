"""IFTA returns, state weight-distance returns, and the insurance policies.

Two sources the corpus had no equivalent of. Both are FILED or SIGNED documents,
which makes them the first outside check on numbers the sheets have been
asserting on their own.

IFTA IS AN INDEPENDENT MILEAGE AND FUEL RECORD. A quarterly return states total
miles and total gallons for the whole fleet under an authority, and divides them
to get fleet MPG. That is the same quantity the weekly P&L computes from
hand-keyed odometer readings, arrived at by a completely different route, so the
two can be compared -- and where they disagree the return is the one that was
filed with a state.

    THE CONTROL THAT MATTERS: a Class-8 dry van fleet does not do 8.76 mpg.
    XTRACK's Q2 2026 return divides 1,727,001 miles by 197,081 gallons and gets
    exactly that, against 6.89 on its own Q1 return and 6.68 in its own P&L for
    the same quarter. Either the miles are overstated or the gallons are
    understated, and because IFTA tax is (taxable miles / fleet mpg) - tax-paid
    gallons, an overstated mpg shrinks the taxable gallons and therefore the tax.
    check_ifta_plausibility() flags any return outside a stated band.

THE INSURANCE FILES ANSWER "WHO IS ACTUALLY INSURED", which the bank cannot:
98% of the group's insurance spend leaves ZONE's account, and the policies show
why -- ZONE-OH carries a 68-unit master auto liability policy for the group,
while XTRACK's own policy covers THREE power units.

WHAT CANNOT BE DONE YET. The policy schedules identify units by VIN; the P&Ls,
the driver roster and the Iron Lease register identify them by fleet number. Only
5 of the 68 insured VINs contain a fleet number anywhere in them (4851, 8671,
2703, 9859, 2743), so the two cannot be joined. A unit-to-VIN table would let
every question about which trucks are insured, and whether idle ones still are,
be answered directly.
"""
import argparse
import glob
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IFTA_DIR = ROOT / "data/raw/ifta"
INSURANCE_DIR = ROOT / "data/raw/insurance"
# A loaded Class-8 tractor. Outside this band the return's own arithmetic is
# saying something the equipment cannot do.
PLAUSIBLE_MPG = (5.0, 7.6)

IFTA_FIELDS = {
    "confirmation": re.compile(r"Confirmation Number:\s*(\S+)"),
    "submitted": re.compile(r"Date Submitted:\s*(\S+)"),
    "legal_name": re.compile(r"Legal Name:\s*l?(.+)"),
    "account_id": re.compile(r"Account\w*\s*ID:\s*(\d+)"),
    "period_end": re.compile(r"Filing Period:\s*(\S+)"),
}
# 'D <miles> ÷ <gallons> = <mpg>' -- Step 2 of the return.
IFTA_STEP2 = re.compile(r"\b([\d,]{5,})\s*÷\s*([\d,]{4,})\s*=\s*([\d.]+)")
IFTA_TAX = re.compile(r"cumulative total due or refund claimed\.\s*\d*\s*\$\s*([\d,]+\.\d{2})")
NY_MILES = re.compile(r"total miles.*?traveled in New York State.*?([\d,]+\.\d)", re.S)
PAYMENT = re.compile(r"Payment amount:\s*([\d,]+\.\d{2})")


def rel(path):
    """Relative to the repo root when it is under it, otherwise as given.
    A relative argument raised ValueError here and the caller's except swallowed
    it, so every return silently parsed to nothing."""
    p = Path(path)
    try:
        return str((p if p.is_absolute() else ROOT / p).relative_to(ROOT))
    except ValueError:
        return str(p)


def text(path):
    import pdfplumber
    with pdfplumber.open(path) as pdf:
        return "\n".join((p.extract_text() or "") for p in pdf.pages)


def num(s):
    return float(str(s).replace(",", "").replace("$", "").strip())


def parse_ifta(path, body=None):
    # `body` lets a caller that already has the text pass it in. Extracting a
    # PDF is the expensive step and there are three readers over 177 files;
    # re-reading for each of them turned a 40-second pass into a timeout.
    t = body if body is not None else text(path)
    # Identify the form by its STRUCTURE, not by a keyword. These PDFs extract
    # with stray characters dropped into the headings ("Accounti ID",
    # "gallotn"), so a literal "IFTA" or "Average Fuel Consumption" is present
    # in some returns and absent in others that are plainly the same form -- and
    # rejecting on that silently threw away four of seven valid returns. The
    # Step 2 division line is the form.
    step2 = IFTA_STEP2.search(t)
    if not step2:
        return None
    rec = {"source": rel(path)}
    for k, pat in IFTA_FIELDS.items():
        hit = pat.search(t)
        if hit:
            rec[k] = hit.group(1).strip()
    rec["total_miles"], rec["total_gallons"] = num(step2.group(1)), num(step2.group(2))
    rec["stated_mpg"] = num(step2.group(3))
    rec["computed_mpg"] = rec["total_miles"] / rec["total_gallons"]
    tax = IFTA_TAX.search(t)
    if tax:
        rec["tax_due"] = num(tax.group(1))
    return rec


def parse_state_return(path):
    t = text(path)
    rec = {"source": rel(path)}
    m = PAYMENT.search(t)
    if m:
        rec["payment"] = num(m.group(1))
    m = NY_MILES.search(t)
    if m:
        rec["state_miles"] = num(m.group(1))
    for k, pat in (("state", re.compile(r"\b(New York|Kentucky|New Mexico)\b")),
                   ("period", re.compile(r"(\d{2}/\d{2}/\d{2})\s+(\d{2}/\d{2}/\d{2})"))):
        m = pat.search(t)
        if m:
            rec[k] = m.group(0)
    return rec if rec.get("payment") else None


def check_ifta_plausibility(returns, band=PLAUSIBLE_MPG):
    """Any return whose own arithmetic gives an impossible fleet mpg."""
    bad = []
    for r in returns:
        mpg = r.get("computed_mpg")
        if mpg is None:
            bad.append((r["source"], "no miles/gallons line", None))
        elif not band[0] <= mpg <= band[1]:
            bad.append((r["source"], f"fleet mpg {mpg:.2f} outside {band}",
                        round(mpg, 2)))
        elif r.get("stated_mpg") and abs(r["stated_mpg"] - mpg) > 0.02:
            bad.append((r["source"], "stated mpg differs from miles/gallons",
                        round(r["stated_mpg"] - mpg, 3)))
    return bad


# ---------------------------------------------------------------------------
# OHIO IS A SECOND FORM, NOT A VARIANT OF THE FIRST.
#
# ZONE files through OH|TAX eServices, which prints a summary table
# ("Diesel 1,509,945 207,885 0 7.26") and no Step 2 division line at all. The
# Step-2 reader returns an empty dict on these, and because an empty dict is
# falsy they dropped out of load_ifta() silently -- ZONE, the largest company,
# had NO external mileage check for that reason alone. A parser that returns
# nothing is worse than one that raises.
OH_PERIOD = re.compile(r"Reporting Period: *([\d/]+) *- *([\d/]+)")
OH_NAME = re.compile(r"Company Name: *(.+)")
OH_CONF = re.compile(r"Confirmation Code: *(\S+)")
OH_TYPE = re.compile(r"Return Type: *(\w+)")
OH_ACCT = re.compile(r"Account Number: *(\S+)")
# Total distance, tax-paid volume, untaxed volume, average miles per gallon.
OH_SUMMARY = re.compile(r"Diesel\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)")
OH_VEHICLES = re.compile(r"Total Vehicles Reported\s+(\d+)")
OH_TAX = re.compile(r"Tax Due \$([\d,]+\.\d{2})")
OH_BALANCE = re.compile(r"Balance Due \$([\d,]+\.\d{2})")


def parse_ohio_return(path, body=None):
    """The OH|TAX eServices IFTA return. Same facts, different form."""
    t = body if body is not None else text(path)
    m = OH_SUMMARY.search(t)
    if not m or "IFTA" not in t.upper():
        return {}
    per = OH_PERIOD.search(t)
    r = {"source": rel(path), "form": "OH|TAX eServices",
         "legal_name": (OH_NAME.search(t).group(1).strip() if OH_NAME.search(t) else None),
         "account_id": (OH_ACCT.search(t).group(1) if OH_ACCT.search(t) else None),
         "confirmation": (OH_CONF.search(t).group(1) if OH_CONF.search(t) else None),
         "return_type": (OH_TYPE.search(t).group(1) if OH_TYPE.search(t) else None),
         "period_start": per.group(1) if per else None,
         "period_end": per.group(2) if per else None,
         "total_miles": num(m.group(1)),
         "total_gallons": num(m.group(2)),
         "untaxed_gallons": num(m.group(3)),
         "stated_mpg": float(m.group(4))}
    for key, rx in (("vehicles", OH_VEHICLES), ("tax_due", OH_TAX),
                    ("balance_due", OH_BALANCE)):
        g = rx.search(t)
        if g:
            r[key] = num(g.group(1))
    # The form prints the mpg; recomputing it is the control that the two
    # numbers scraped off the same line are the ones meant.
    if r["total_gallons"]:
        r["computed_mpg"] = r["total_miles"] / r["total_gallons"]
    return r


def load_ifta(pattern=None):
    files = sorted(glob.glob(pattern or str(IFTA_DIR / "**/*.pdf"), recursive=True))
    out, failed, unread = [], [], []
    for f in files:
        try:
            body = text(f)
            # Two forms in the corpus. Try both before giving up on a file --
            # the Ohio returns carry no Step 2 line and were being dropped.
            r = parse_ifta(f, body) or parse_ohio_return(f, body)
        except Exception as exc:                       # never silent
            failed.append((rel(f), f"{type(exc).__name__}: {exc}"))
            continue
        if r and "total_miles" in r:
            out.append(r)
        elif _looks_like_a_return(body):
            unread.append(rel(f))
    # THE SAME RETURN IS FILED UNDER SEVERAL PATHS. ZONE's Ohio returns appear
    # both in data/raw/ifta/ohio/ and inside the CT Reports archive, so a naive
    # list held each quarter three times and any total built by summing it
    # tripled ZONE's miles. Key on the FACTS of the return, the way the file
    # catalog keys on content hash -- never on the path.
    seen, unique = set(), []
    for r in out:
        k = (r.get("legal_name"), str(r.get("period_end")), r.get("total_miles"))
        if k in seen:
            r["_duplicate_of"] = k
            continue
        seen.add(k)
        unique.append(r)
    dropped = len(out) - len(unique)
    out = unique
    if dropped:
        print(f"{dropped} duplicate return(s) filed under more than one path, "
              f"counted once", file=sys.stderr)
    if failed:
        print(f"{len(failed)} file(s) raised while parsing:", file=sys.stderr)
        for f, e in failed[:10]:
            print(f"  {f}: {e}", file=sys.stderr)
    # A return that reads as nothing is the dangerous case: it removes a whole
    # company from the comparison without anybody noticing. Say so, loudly.
    if unread:
        print(f"{len(unread)} file(s) LOOK like IFTA returns and read as nothing "
              f"-- a form this parser does not know:", file=sys.stderr)
        for f in unread[:10]:
            print(f"  {f}", file=sys.stderr)
    return out


def _looks_like_a_return(body):
    """Does this text claim to be an IFTA return, whatever form it is in?

    Used only to complain about files the readers could not parse. Deliberately
    keyword-based, which is exactly what the readers must NOT be: these PDFs
    extract with characters dropped ('Accounti ID', 'gallotn'), so a keyword is
    fine for raising a hand and useless for identifying a form.
    """
    t = (body or "").upper()
    return ("INTERNATIONAL FUEL TAX" in t or "IFTA RETURN" in t) and "TOTAL" in t


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json")
    a = ap.parse_args()
    rs = load_ifta()
    print(f"{len(rs)} IFTA returns parsed")
    print(f"  {'entity':<14}{'period':>10}{'miles':>12}{'gallons':>10}{'mpg':>7}{'tax due':>11}")
    for r in sorted(rs, key=lambda x: (x.get("legal_name", ""), x.get("period_end", ""))):
        print(f"  {r.get('legal_name', '?')[:13]:<14}{r.get('period_end', '?'):>10}"
              f"{r['total_miles']:>12,.0f}{r['total_gallons']:>10,.0f}"
              f"{r['computed_mpg']:>7.2f}{r.get('tax_due', 0):>11,.2f}")
    bad = check_ifta_plausibility(rs)
    if bad:
        print(f"\nIMPLAUSIBLE ({len(bad)}):")
        for src, what, v in bad:
            print(f"  {Path(src).name}: {what}")
    else:
        print("\nall returns give a plausible fleet mpg")
    if a.json:
        json.dump(rs, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    sys.exit(main())
