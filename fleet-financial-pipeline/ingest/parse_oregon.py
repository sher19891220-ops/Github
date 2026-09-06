"""Oregon weight-mile tax returns -- the one filing that is a SCANNED IMAGE.

Oregon does not tax diesel through IFTA. It taxes by WEIGHT-MILE on its own
monthly return, which is why ZONE's Ohio IFTA returns report Oregon miles at a
0.00 rate and why the Oregon money was invisible to every other reader here.

THESE PDFs HAVE NO TEXT LAYER AT ALL. One full-page image per page, zero
extractable characters. Every text-based reader in this pipeline returns nothing
on them and raises no error -- the same silent failure that hid ZONE's Ohio
returns behind a form layout. So this module OCRs them, and because OCR invents
digits, nothing it reads is trusted until it ties.

THREE READINGS OF THE SAME NUMBER, AND THEY MUST AGREE. The form states its tax
three times over, in three different places and typefaces:

    1. the machine stamp across the header      068825 XTRACOS042666067 312.74
    2. per vehicle, as miles x rate             1,245 x 0.2512 = 312.74
    3. the box total, 'TOTAL FROM COLUMN L'     312 74

An OCR error hits one of the three and not the others, so agreement between them
is the control. A return where they disagree is REPORTED, never averaged or
quietly preferred -- see `disagreements` in the result.

OCR MANGLES ZERO WORST OF ALL. An empty odometer cell comes back as `Lt)`, `is)`,
`it)`, `ft)` or a bare `)` at least as often as `0`. Since most rows on most of
these returns ARE zero -- the fleet barely runs Oregon -- a reader that treats an
unparseable cell as missing rather than as zero drops nearly every row and then
"ties" against a zero total by accident. Empty is zero here, and the row count is
carried so that a return which parsed nothing cannot masquerade as a nil return.
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OREGON_DIR = ROOT / "data/raw/ifta/oregon"
DPI = 200          # 150 loses the rate column's fourth decimal; 300 is no better
MONTHS = ("January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December")
# Oregon's weight-mile rate at 80,000 lb. Rows are checked against the rate the
# form itself prints, never against this -- it is here only to flag a rate that
# is not a plausible Oregon rate at all.
PLAUSIBLE_RATE = (0.05, 0.50)
TIE = 0.02         # two readings of a dollar figure, so cents

CARRIER = re.compile(r"\b(ZONE OH LLC|XTRACK LLC|AFG[A-Z .]*)\b", re.I)
ACCOUNT = re.compile(r"\b(\d{6})\b")
# The header stamp: account, a carrier code, then the tax. The code runs into
# the account number in the OCR ("068825 XTRACOS042666067 312.74"), so the
# amount is taken as the last field and the code is not parsed at all.
STAMP = re.compile(r"\b(\d{6})\s+([A-Z0-9]{6,})\s+([\d,]+\.\d{2})\s*$", re.M)
BOX_TOTAL = re.compile(r"TOTAL\s+FROM\s+COLUMN\s+L\s+([\d,]+)\s+(\d{2})\b", re.I)
# A vehicle row: plate, state, unit, make, weight, two odometers, miles, rate,
# then the tax as dollars and cents split by the column rule.
ROW = re.compile(
    r"^\s*(?P<plate>[A-Z0-9]{5,9})\s*[|\-—]?\s*(?P<st>[A-Z]{2})\s*[|\-—]?\s*"
    r"\(?(?P<unit>\d{1,6})\s*[|\-—]?\s*(?P<make>[A-Za-z._]{2,6})\s*[|\-—]?\s*"
    # The gross-weight cell picks up whichever bracket the column rule became:
    # `(80000`, `{80000`, `|80000`. Requiring one shape drops every row that
    # got another, and XTRACK's only taxable row of July 2026 was a `{`.
    r"[\(\{\[|]?(?P<gvw>\d{5})\s+(?P<rest>.+)$")
ZERO_TOKENS = {"0", ")", "()", "Lt)", "is)", "it)", "ft)", "o", "O", "|"}


def money(dollars, cents):
    return float(str(dollars).replace(",", "")) + float(cents) / 100.0


def cell(tok):
    """A number out of an OCR cell. An unreadable cell is ZERO, not missing.

    Most rows on these returns are genuinely zero, and OCR renders a blank cell
    as punctuation far more often than as '0'. Treating those as missing drops
    the row, and a return that dropped every row still ties against a nil total.
    """
    t = str(tok).strip()
    if t in ZERO_TOKENS or not re.search(r"\d", t):
        return 0.0
    return float(re.sub(r"[^\d.]", "", t) or 0)


def ocr(pdf, dpi=DPI):
    """Page text via pdftoppm + tesseract. Raises rather than returning ''."""
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["pdftoppm", "-r", str(dpi), "-png", str(pdf), f"{d}/p"],
                       check=True, capture_output=True)
        pages = sorted(Path(d).glob("p-*.png"))
        if not pages:
            raise RuntimeError(f"pdftoppm produced no pages for {pdf}")
        return [subprocess.run(["tesseract", str(p), "-"], check=True,
                               capture_output=True, text=True).stdout
                for p in pages]


def parse_rows(text):
    """Vehicle rows, with miles, rate and tax read independently."""
    out = []
    for line in text.splitlines():
        m = ROW.match(line)
        if not m:
            continue
        # The tail holds: begin odo, end odo, total miles, Oregon miles, axles,
        # rate, tax dollars, tax cents -- with an unpredictable number of the
        # leading ones rendered as punctuation. Anchor on the RATE, which is the
        # only field with four decimals, and read outward from it.
        tail = m.group("rest")
        rate_m = re.search(r"(\d\.\d{4})", tail)
        if not rate_m:
            continue
        rate = float(rate_m.group(1))
        # The column rules survive OCR as loose punctuation, so a field can be
        # preceded by a bare `)` or `;` token: `0.2512) 359 47`. Positional
        # reading then took `)` as the tax dollars and `359` as the cents, and
        # reported $359.47 as $0.35 -- a hundredfold understatement that still
        # looked like a plausible small number. Keep only tokens with digits.
        before = [t for t in tail[:rate_m.start()].split() if re.search(r"\d", t)]
        after = [t for t in tail[rate_m.end():].split() if re.search(r"\d", t)]
        # Oregon miles are the last numeric field before the rate.
        miles = cell(before[-1]) if before else 0.0
        d = cell(after[0]) if after else 0.0
        c = cell(after[1]) if len(after) > 1 else 0.0
        out.append({"plate": m.group("plate"), "state": m.group("st"),
                    "unit": m.group("unit"), "make": m.group("make"),
                    "gvw": int(m.group("gvw")), "miles": miles, "rate": rate,
                    "tax": money(d, f"{int(c):02d}"[:2])})
    return out


def parse_return(pdf):
    pages = ocr(pdf)
    text = "\n".join(pages)
    carrier = CARRIER.search(text)
    month = next((mo for mo in MONTHS if re.search(rf"\b{mo}\b", text)), None)
    year = re.search(r"\b(20[12][0-9])\b", text)
    stamp = STAMP.search(text)
    box = BOX_TOTAL.search(text)
    rows = parse_rows(text)

    rec = {
        "source": str(Path(pdf).relative_to(ROOT)) if ROOT in Path(pdf).parents
                  else str(pdf),
        "carrier": (carrier.group(1).upper().strip() if carrier else None),
        "account": (stamp.group(1) if stamp else
                    (ACCOUNT.search(text).group(1) if ACCOUNT.search(text) else None)),
        "month": month, "year": int(year.group(1)) if year else None,
        "pages": len(pages), "vehicle_rows": len(rows),
        "stamp_tax": float(stamp.group(3).replace(",", "")) if stamp else None,
        "box_tax": money(*box.groups()) if box else None,
        "rows_tax": round(sum(r["tax"] for r in rows), 2),
        "oregon_miles": round(sum(r["miles"] for r in rows), 1),
        "rows": rows,
    }
    # Preference is a statement about EVIDENCE, not a fallback chain: the stamp
    # and the box are printed by Oregon, the row sum is reconstructed by this
    # reader out of an image. Where a continuation sheet OCRs badly the rows
    # UNDERSTATE and the box does not, so the box wins and the reader says so.
    for src in ("stamp_tax", "box_tax", "rows_tax"):
        if rec[src] is not None:
            rec["tax"], rec["tax_from"] = rec[src], src
            break
    rec["disagreements"] = check(rec)
    return rec


def check(rec):
    """The three readings against each other, plus miles x rate per row."""
    bad = []
    seen = {k: rec[k] for k in ("stamp_tax", "box_tax", "rows_tax")
            if rec[k] is not None}
    if len(seen) > 1 and max(seen.values()) - min(seen.values()) > TIE:
        bad.append(("the form states its tax three times and they differ", seen))
    for r in rec["rows"]:
        if not (PLAUSIBLE_RATE[0] <= r["rate"] <= PLAUSIBLE_RATE[1]) and r["rate"]:
            bad.append((f"unit {r['unit']}: rate {r['rate']} is not an Oregon rate",
                        r["rate"]))
        implied = round(r["miles"] * r["rate"], 2)
        if abs(implied - r["tax"]) > TIE:
            bad.append((f"unit {r['unit']}: {r['miles']:,.0f} mi x {r['rate']} "
                        f"= {implied:,.2f}, form says {r['tax']:,.2f}", None))
    if rec["vehicle_rows"] == 0:
        bad.append(("no vehicle rows read -- a nil return and a failed OCR look "
                    "identical, so this is not treated as zero", None))
    return bad


# Oregon miles as reported on ZONE's OHIO IFTA returns, which are text PDFs and
# cannot have been mis-read by OCR. An independent check on both the returns and
# the reading of them.
OHIO_OREGON_MILES = {"2026Q1": 2968, "2026Q2": 436}
QUARTER_OF = {"January": "Q1", "February": "Q1", "March": "Q1",
              "April": "Q2", "May": "Q2", "June": "Q2",
              "July": "Q3", "August": "Q3", "September": "Q3",
              "October": "Q4", "November": "Q4", "December": "Q4"}


def quarter_miles(returns, carrier="ZONE OH LLC"):
    """These returns' Oregon miles per quarter, against the Ohio IFTA figure."""
    got, months = {}, {}
    for r in returns:
        if r["carrier"] != carrier or not r["month"] or not r["year"]:
            continue
        q = f"{r['year']}{QUARTER_OF[r['month']]}"
        got[q] = got.get(q, 0) + r["oregon_miles"]
        months[q] = months.get(q, 0) + 1
    return {q: (got[q], OHIO_OREGON_MILES[q], f"{months[q]} month(s)")
            for q in got if q in OHIO_OREGON_MILES}


def load(directory=OREGON_DIR):
    out, failed = [], []
    for f in sorted(Path(directory).rglob("*.pdf")):
        try:
            r = parse_return(f)
        except Exception as exc:
            failed.append((str(f), f"{type(exc).__name__}: {exc}"))
            continue
        if r["month"] and r["carrier"]:
            out.append(r)
    for f, e in failed:
        print(f"  OCR FAILED {f}: {e}", file=sys.stderr)
    return out


def main():
    rs = load()
    print(f"{len(rs)} Oregon monthly mileage tax returns read by OCR\n")
    print(f"  {'carrier':<12}{'period':<16}{'acct':<9}{'units':>6}{'OR miles':>11}"
          f"{'tax':>10}{'  controls'}")
    for r in sorted(rs, key=lambda r: (r["carrier"] or "", r["year"] or 0,
                                       MONTHS.index(r["month"]) if r["month"] else 0)):
        tax, v = r["tax"], ("tie" if not r["disagreements"]
                            else f"{len(r['disagreements'])} ISSUE(S)")
        print(f"  {(r['carrier'] or '?')[:11]:<12}"
              f"{(r['month'] or '?') + ' ' + str(r['year'] or ''):<16}"
              f"{r['account'] or '?':<9}{r['vehicle_rows']:>6}"
              f"{r['oregon_miles']:>11,.0f}{tax:>10,.2f}  {v}")
    q = quarter_miles(rs)
    if q:
        print("\n  OREGON MILES AGAINST THE OHIO IFTA RETURN -- two filings, two")
        print("  states, one fleet. The Ohio return lists Oregon miles at a 0.00")
        print("  IFTA rate precisely because Oregon taxes them separately here.")
        print(f"    {'quarter':<10}{'these returns':>16}{'Ohio IFTA says':>17}{'gap':>8}")
        for qq, (mine, theirs, months) in sorted(q.items()):
            print(f"    {qq:<10}{mine:>16,.0f}{theirs:>17,.0f}{mine - theirs:>8,.0f}"
                  f"   from {months}")

    for r in rs:
        for what, detail in r["disagreements"]:
            print(f"    {r['carrier']} {r['month']} {r['year']}: {what}"
                  + (f"  {detail}" if detail else ""))
    tot = sum(r["tax"] for r in rs)
    mi = sum(r["oregon_miles"] for r in rs)
    print(f"\n  {len(rs)} returns, {mi:,.0f} Oregon miles, ${tot:,.2f} of weight-mile tax")


if __name__ == "__main__":
    main()
