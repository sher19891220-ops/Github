"""
Pull period and balances off the face of each bank-statement PDF.

The statement-total control needs four numbers per statement — period start,
period end, beginning balance, ending balance. Keying those by hand for 147
statements is slow and error-prone, and Bank of America prints all four on
page 1 in a stable form:

    for January 1, 2024 to January 31, 2024   Account number: 4350 4996 0271
    Beginning balance on January 1, 2024   $399,199.73
    Ending balance on January 31, 2024     $226,783.03

The account number is a bonus: it ties each statement to the account ids that
appear in the QuickBooks-linked CSV exports ("Business Adv Fundamentals - 0271").

Anything not extracted is REPORTED, never guessed. A statement with no balances
cannot be checked, and pretending otherwise defeats the control.

Usage:
    python ingest/extract_statement_meta.py <folder> --out statements.csv
"""
import argparse
import csv
import re
import sys
import warnings
from datetime import datetime
from pathlib import Path

warnings.filterwarnings("ignore")

MONEY = r"\$?\(?-?[\d,]+\.\d{2}\)?-?"

PERIOD = re.compile(
    r"for\s+([A-Z][a-z]+\s+\d{1,2},\s*\d{4})\s+to\s+([A-Z][a-z]+\s+\d{1,2},\s*\d{4})", re.I)
PERIOD_ALT = re.compile(
    r"(\d{2}/\d{2}/\d{2,4})\s*(?:-|through|to)\s*(\d{2}/\d{2}/\d{2,4})")
ACCOUNT = re.compile(r"[Aa]ccount\s+number:?\s*([\d\s\-Xx*]{6,})")
BEGIN = re.compile(rf"Beginning\s+balance[^$\n]*?({MONEY})", re.I)
END = re.compile(rf"Ending\s+balance[^$\n]*?({MONEY})", re.I)
# Credit-card statements word it differently
PREV = re.compile(rf"Previous\s+[Bb]alance[^$\n]*?({MONEY})", re.I)
NEW = re.compile(rf"New\s+[Bb]alance[^$\n]*?({MONEY})", re.I)


def money(raw):
    if raw is None:
        return None
    s = str(raw).strip()
    neg = s.startswith("(") and s.endswith(")") or s.endswith("-") or s.startswith("-")
    s = s.strip("()").replace("$", "").replace(",", "").replace("-", "").strip()
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def to_iso(raw):
    raw = raw.strip()
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def extract(path: Path, pages=2):
    import pdfplumber
    text = ""
    try:
        with pdfplumber.open(path) as pdf:
            for pg in pdf.pages[:pages]:
                text += (pg.extract_text() or "") + "\n"
    except Exception as e:
        return {"file": path.name, "path": str(path), "error": f"unreadable: {e}"}

    if not text.strip():
        return {"file": path.name, "path": str(path),
                "error": "no extractable text (scanned image — needs OCR)"}

    out = {"file": path.name, "path": str(path), "error": ""}

    m = PERIOD.search(text) or PERIOD_ALT.search(text)
    if m:
        out["period_start"], out["period_end"] = to_iso(m.group(1)), to_iso(m.group(2))

    m = ACCOUNT.search(text)
    if m:
        digits = re.sub(r"\D", "", m.group(1))
        if len(digits) >= 4:
            out["account_last4"] = digits[-4:]

    b = BEGIN.search(text) or PREV.search(text)
    e = END.search(text) or NEW.search(text)
    if b:
        out["beginning_balance"] = money(b.group(1))
    if e:
        out["ending_balance"] = money(e.group(1))

    missing = [k for k in ("period_start", "period_end", "beginning_balance", "ending_balance")
               if out.get(k) in (None, "")]
    if missing:
        out["error"] = "missing: " + ",".join(missing)
    else:
        out["balance_delta"] = round(out["ending_balance"] - out["beginning_balance"], 2)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("--out", default="data/processed/statement_meta.csv")
    args = ap.parse_args()

    pdfs = sorted(Path(args.folder).rglob("*.pdf"))
    if not pdfs:
        raise SystemExit(f"no PDFs under {args.folder}")

    rows = []
    for i, p in enumerate(pdfs, 1):
        rows.append(extract(p))
        if i % 25 == 0:
            print(f"  ...{i}/{len(pdfs)}", flush=True)

    cols = ["file", "path", "account_last4", "period_start", "period_end",
            "beginning_balance", "ending_balance", "balance_delta", "error"]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)

    ok = [r for r in rows if not r["error"]]
    bad = [r for r in rows if r["error"]]
    print(f"\n{len(ok)}/{len(rows)} statements yielded all four control numbers.")
    if bad:
        import collections
        reasons = collections.Counter(r["error"].split(":")[0] for r in bad)
        print(f"\n{len(bad)} incomplete:")
        for reason, n in reasons.most_common():
            print(f"   {n:>4}  {reason}")
        for r in bad[:10]:
            print(f"      {r['file'][:40]:<42} {r['error'][:50]}")
    print(f"\nWritten: {out}")


if __name__ == "__main__":
    main()
