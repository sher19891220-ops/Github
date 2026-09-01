"""
Bank of America business-statement parser.

The generic regex approach in ingest_pdf.py does not work on these, for three
reasons that are only visible once you read a real statement:

1. AMOUNTS SOMETIMES CARRY A SIGN AND SOMETIMES DO NOT. Across this corpus
   both layouts appear: older statements print a withdrawal as "16,107.20",
   identical to a deposit, and the SECTION HEADING is the only thing that
   makes it negative; newer ones print "-16,107.20" outright. Applying the
   section sign unconditionally turns the signed ones back into income --
   -1 x -804.38 = +804.38, a self-consistent, silent inversion. So: trust a
   printed sign when there is one, fall back to the section sign when there
   is not.

2. "Daily ledger balances" is a table of dates and amounts that looks exactly
   like a transaction table. Parsing it adds a phantom transaction per day and
   roughly doubles the statement.

3. Descriptions wrap. "ID:9000012712 CCD" on its own line belongs to the
   transaction above it, not to a new one.

Also: extract_tables() returns NOTHING on these statements, so the table pass
in ingest_pdf.py contributes nothing here and the text pass is the only one
that matters.

Sections and their signs:
    Deposits and other credits      ->  +
    Withdrawals and other debits    ->  -
    Service fees                    ->  -
    Checks                          ->  -   (two column-pairs per line)
    Daily ledger balances           ->  SKIPPED, not transactions

Usage:
    python ingest/parse_boa_statement.py <folder> --meta statement_meta.csv --out txns.csv
"""
import argparse
import csv
import re
import warnings
from datetime import date, datetime
from pathlib import Path

warnings.filterwarnings("ignore")

SECTION_SIGNS = {
    "deposits and other credits": 1,
    "withdrawals and other debits": -1,
    "service fees": -1,
    "checks": -1,
}
# Look like transaction tables, are not.
SKIP_SECTIONS = {
    "daily ledger balances", "account summary", "daily balances",
}

AMT = r"-?[\d,]+\.\d{2}"
TXN = re.compile(rf"^(\d{{1,2}}/\d{{1,2}}/\d{{2,4}})\s+(.+?)\s+({AMT})$")
CHECK_PAIR = re.compile(rf"(\d{{1,2}}/\d{{1,2}}/\d{{2,4}})\s+(\d+)\*?\s+({AMT})")
RULER = re.compile(r"^(Date\s+(Description|Transaction description|Check\s*#|Balance)|Check number:)", re.I)
NOISE = re.compile(r"^(Page \d|Your checking account|Account summary|continued|"
                   r"Total\b|Subtotal\b|"
                   r"[A-Z][A-Za-z ]+ ! Account # )", re.I)


def money(raw):
    return float(str(raw).replace(",", "").replace("$", ""))


def signed(raw, section_sign):
    """The printed sign wins; the section sign only fills in when the statement
    prints the amount bare. Never multiply the two."""
    v = money(raw)
    return v if "-" in str(raw) else section_sign * abs(v)


def resolve_year(mmdd, p_start, p_end):
    """Statements print 01/02/24. Trust the statement period for the year, and
    handle a period that straddles a year boundary by month."""
    m, d = int(mmdd.split("/")[0]), int(mmdd.split("/")[1])
    for anchor in (p_start, p_end):
        if anchor and anchor.month == m:
            return date(anchor.year, m, min(d, 28) if m == 2 and d > 28 else d)
    y = (p_start or p_end).year if (p_start or p_end) else date.today().year
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _d(s):
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def parse(path: Path, meta: dict):
    import pdfplumber
    p_start, p_end = _d(meta.get("period_start")), _d(meta.get("period_end"))
    acct = meta.get("account_last4") or ""
    rows, section, sign = [], None, 0
    skipped_sections = set()
    cont_idx = -99   # index of the last line that may still be continued

    with pdfplumber.open(path) as pdf:
        for pg in pdf.pages:
            lines = [l.rstrip() for l in (pg.extract_text() or "").split("\n")]
            cont_idx = -99   # continuations never cross a page break
            for i, raw in enumerate(lines):
                line = raw.strip()
                if not line:
                    continue

                # section heading = the line above a ruler
                if RULER.match(line):
                    prev = re.sub(r"\s*-\s*continued$", "", lines[i - 1].strip(), flags=re.I).lower() if i else ""
                    if prev in SECTION_SIGNS:
                        section, sign = prev, SECTION_SIGNS[prev]
                    elif prev in SKIP_SECTIONS:
                        section, sign = prev, 0
                        skipped_sections.add(prev)
                    continue

                low = line.lower()
                if low in SECTION_SIGNS:
                    section, sign = low, SECTION_SIGNS[low]
                    continue
                if low in SKIP_SECTIONS:
                    section, sign = low, 0
                    skipped_sections.add(low)
                    continue
                if sign == 0 or section is None or NOISE.match(line):
                    continue

                if section == "checks":
                    for dt, num, amt in CHECK_PAIR.findall(line):
                        d = resolve_year(dt, p_start, p_end)
                        if d:
                            rows.append({"txn_date": d.isoformat(), "amount": signed(amt, -1),
                                         "description": f"Check {num}", "section": section,
                                         "account_last4": acct, "source_file": path.name,
                                         "source_path": str(path)})
                    continue

                m = TXN.match(line)
                if m:
                    dt, desc, amt = m.groups()
                    d = resolve_year(dt, p_start, p_end)
                    if d:
                        rows.append({"txn_date": d.isoformat(), "amount": signed(amt, sign),
                                     "description": desc.strip(), "section": section,
                                     "account_last4": acct, "source_file": path.name,
                                     "source_path": str(path)})
                        cont_idx = i
                elif rows and i == cont_idx + 1 and not re.search(AMT, line) and len(line) < 90:
                    # continuation of the previous description -- only when it
                    # physically follows that line
                    rows[-1]["description"] = (rows[-1]["description"] + " " + line)[:300]
                    cont_idx = i
    return rows, skipped_sections


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("--meta", required=True)
    ap.add_argument("--out", default="data/processed/boa_transactions.csv")
    args = ap.parse_args()

    # Keyed by full path. Basename collides across accounts and silently
    # assigns one account's period and last-4 to another account's statement.
    meta = {r["path"]: r for r in csv.DictReader(open(args.meta))
            if not r["error"] and r["beginning_balance"] and r["ending_balance"]}
    pdfs = [p for p in sorted(Path(args.folder).rglob("*.pdf")) if str(p) in meta]
    print(f"parsing {len(pdfs)} statements that have control numbers...")

    allrows, per_file, skipped = [], {}, set()
    for i, p in enumerate(pdfs, 1):
        rows, sk = parse(p, meta[str(p)])
        allrows += rows
        per_file[str(p)] = rows
        skipped |= sk
        if i % 25 == 0:
            print(f"  ...{i}/{len(pdfs)}", flush=True)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cols = ["source_path", "source_file", "account_last4", "txn_date", "amount", "section", "description"]
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(allrows)
    print(f"\n{len(allrows):,} transactions from {len(pdfs)} statements -> {out}")
    print(f"sections deliberately skipped: {', '.join(sorted(skipped)) or 'none'}")
    return per_file, meta


if __name__ == "__main__":
    main()
