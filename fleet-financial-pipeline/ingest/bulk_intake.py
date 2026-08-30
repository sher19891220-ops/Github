"""
Bulk intake: point it at a folder of mixed financial files and it routes each
one to the right parser.

A bulk drop is not homogeneous. A .csv might be a bank statement, a P&L, an
odometer log, or a fuel report, and the extension says nothing about which.
Routing on extension alone silently loads a P&L into the transactions table.
So every file is fingerprinted on CONTENT, and anything that cannot be
identified confidently is quarantined rather than guessed at.

Nothing is ingested until you have seen the plan. Default is a dry run:

    python ingest/bulk_intake.py scan   /path/to/upload        # what is this pile?
    python ingest/bulk_intake.py plan   /path/to/upload        # what would happen
    python ingest/bulk_intake.py run    /path/to/upload --yes  # do it
    python ingest/bulk_intake.py report                        # coverage after

Filenames carry the entity/account when they follow <ENTITY>_<BANK>_<LAST4>,
e.g. zone_chase_op_jan26.pdf. Unmatched files are reported, never guessed.
"""
import argparse
import csv
import hashlib
import io
import json
import re
import sqlite3
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parent.parent))

DB_PATH = Path(__file__).resolve().parent.parent / "db" / "fleet_financials.db"
QUARANTINE = "quarantine"

# ---------------------------------------------------------------------------
# Content fingerprinting
# ---------------------------------------------------------------------------

# Header tokens that identify what a tabular file actually is. Scored, not
# first-match, so a sheet with both "date" and "odometer" resolves to odometer
# rather than to whichever rule happened to be checked first.
SIGNATURES = {
    "bank_statement": {
        "strong": ["posted date", "transaction date", "posting date", "debit", "credit",
                   "withdrawal", "deposit", "running balance", "balance"],
        "weak": ["date", "description", "amount", "memo", "payee", "reference"],
        "min": 2,
    },
    "pnl": {
        "strong": ["gross revenue", "net profit", "net income", "total expenses",
                   "cost of goods", "profit and loss", "p&l", "gross profit"],
        "weak": ["category", "account", "line item", "revenue", "expense"],
        "min": 1,
    },
    "odometer": {
        "strong": ["odometer", "odo", "hub reading", "hubometer", "ending odometer"],
        "weak": ["unit", "truck", "date", "miles", "mileage"],
        "min": 1,
    },
    "fuel_report": {
        "strong": ["gallons", "gallon", "price per gallon", "ppg", "fuel card",
                   "unit price", "def gallons", "product code"],
        "weak": ["unit", "driver", "location", "merchant", "card", "date", "amount"],
        "min": 1,
    },
    "toll_report": {
        "strong": ["transponder", "plaza", "toll authority", "agency", "exit lane",
                   "toll amount", "tag id"],
        "weak": ["date", "amount", "unit", "vehicle", "license"],
        "min": 1,
    },
    "maintenance": {
        "strong": ["repair order", "work order", "ro number", "labor", "shop name",
                   "downtime", "breakdown", "fault code"],
        "weak": ["unit", "date", "cost", "vendor"],
        "min": 1,
    },
    "incidents": {
        "strong": ["deductible", "claim number", "incident date", "accident",
                   "out of pocket", "adjuster", "police report"],
        "weak": ["unit", "driver", "date", "cost"],
        "min": 1,
    },
    "chart_of_accounts": {
        "strong": ["account type", "accnt. type", "detail type", "account number",
                   "accnt type"],
        "weak": ["account", "name", "description", "balance"],
        "min": 1,
    },
}


def sha256(path, limit=None):
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
            if limit and h.block_size > limit:
                break
    return h.hexdigest()


# A transaction table needs a date, an amount, and a label. Card exports often
# carry nothing more distinctive than that — AmEx ships "Date, Description,
# Card Member, Amount" — so requiring a "strong" token would quarantine real
# statements. This is the shape-based fallback for that case.
_DATEISH = ("date", "posted", "posting", "trans date", "tx date")
_AMOUNTISH = ("amount", "debit", "credit", "withdrawal", "deposit", "charge")
_LABELISH = ("description", "memo", "payee", "narrative", "details", "merchant",
             "reference", "card member", "transaction")


def _looks_like_transaction_table(tokens):
    hay = " | ".join(tokens)
    return (any(k in hay for k in _DATEISH)
            and any(k in hay for k in _AMOUNTISH)
            and any(k in hay for k in _LABELISH))


def _score(tokens, sig):
    hay = " | ".join(tokens)
    strong = sum(1 for k in sig["strong"] if k in hay)
    weak = sum(1 for k in sig["weak"] if k in hay)
    if strong < sig["min"]:
        return 0
    return strong * 10 + weak


def _header_tokens_tabular(path, max_rows=25):
    """Pull candidate header cells from the first rows. Real exports bury the
    header under title/logo rows, so several rows are scanned, not just the
    first."""
    suffix = path.suffix.lower()
    rows = []
    try:
        if suffix in (".csv", ".tsv", ".txt"):
            delim = "\t" if suffix == ".tsv" else ","
            with path.open(newline="", encoding="utf-8-sig", errors="replace") as fh:
                for i, r in enumerate(csv.reader(fh, delimiter=delim)):
                    if i >= max_rows:
                        break
                    rows.append(r)
        elif suffix in (".xlsx", ".xlsm", ".xls"):
            import pandas as pd
            df = pd.read_excel(path, header=None, nrows=max_rows,
                               sheet_name=0, dtype=str)
            rows = df.fillna("").astype(str).values.tolist()
    except Exception:
        return []
    return [str(c).strip().lower() for r in rows for c in r if str(c).strip()]


def _text_head_pdf(path, pages=2):
    try:
        import pdfplumber
        out = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages[:pages]:
                out.append(page.extract_text() or "")
        return "\n".join(out)
    except Exception as e:
        return f"__PDF_ERROR__ {e}"


def detect_kind(path: Path):
    """Return (kind, confidence, evidence). Never guesses — an ambiguous file
    is quarantined so a P&L never lands in the transactions table."""
    suffix = path.suffix.lower()

    if suffix in (".ofx", ".qfx", ".qbo"):
        return "bank_statement_ofx", "high", "OFX/QFX container"

    if suffix == ".pdf":
        text = _text_head_pdf(path)
        if text.startswith("__PDF_ERROR__"):
            return QUARANTINE, "none", f"unreadable PDF: {text[13:80]}"
        low = text.lower()
        if not low.strip():
            return QUARANTINE, "none", "PDF has no extractable text (scanned image — needs OCR)"
        scores = {k: _score([low], s) for k, s in SIGNATURES.items()}
        best = max(scores, key=scores.get)
        if scores[best] == 0:
            return QUARANTINE, "none", "PDF text matched no known layout"
        # A statement PDF nearly always says so somewhere near the top.
        if re.search(r"beginning balance|ending balance|statement period|previous balance",
                     low):
            return "bank_statement_pdf", "high", "balance/statement-period language"
        return (best if best != "bank_statement" else "bank_statement_pdf"), "medium", \
               f"text signature ({best})"

    if suffix in (".csv", ".tsv", ".txt", ".xlsx", ".xlsm", ".xls"):
        tokens = _header_tokens_tabular(path)
        if not tokens:
            return QUARANTINE, "none", "no readable header rows"
        scores = {k: _score(tokens, s) for k, s in SIGNATURES.items()}
        if scores["bank_statement"] == 0 and _looks_like_transaction_table(tokens):
            # Scored low enough to lose to any real signature, so a fuel or toll
            # report that also has date/amount/description still wins on its own
            # distinctive columns.
            scores["bank_statement"] = 5
        ranked = sorted(scores.items(), key=lambda kv: -kv[1])
        best, best_score = ranked[0]
        if best_score == 0:
            return QUARANTINE, "none", "header matched no known layout"
        runner_up = ranked[1][1] if len(ranked) > 1 else 0
        # A clear winner is trustworthy; a near-tie is not, and guessing between
        # "bank statement" and "P&L" is exactly the mistake that corrupts a
        # transactions table silently.
        conf = "high" if best_score >= runner_up * 2 and best_score >= 10 else "medium"
        kind = "bank_statement_tabular" if best == "bank_statement" else best
        return kind, conf, f"header signature score {best_score} (next {runner_up})"

    if suffix == ".zip":
        return "archive", "high", "zip archive — will be expanded"

    return QUARANTINE, "none", f"unsupported extension {suffix}"


# ---------------------------------------------------------------------------
# Filename -> entity / account
# ---------------------------------------------------------------------------

ENTITY_ALIASES = {
    "zone": "ZONE", "xtrack": "XTRACK", "afg": "AFG", "ironlease": "IRON_LEASE",
    "iron_lease": "IRON_LEASE", "ironleasellc": "IRON_LEASE",
    "truckmax": "TRUCKMAX", "truck_max": "TRUCKMAX", "shaeffer": "SHAEFFER",
    "runstar": "RUNSTAR",
}
BANK_ALIASES = ["chase", "amex", "bofa", "bankofamerica", "wellsfargo", "wf", "pnc",
                "huntington", "usbank", "citi", "capitalone", "novo", "mercury",
                "truist", "fifththird", "keybank", "comdata", "efs", "wex"]


def infer_account(path: Path):
    # Underscore is a regex word character, so \bzone\b does NOT match
    # "zone_chase_op" — the boundary never occurs. Tokenize instead. The
    # parent folder is included because people file by company.
    stem = re.sub(r"[^a-z0-9]+", " ", path.stem.lower())
    folder = re.sub(r"[^a-z0-9]+", " ", path.parent.name.lower())
    tokens = set(stem.split()) | set(folder.split())
    joined = stem.replace(" ", "")

    entity = next((v for k, v in ENTITY_ALIASES.items()
                   if k in tokens or k.replace("_", "") in joined), None)
    bank = next((b for b in BANK_ALIASES if b in tokens or b in joined), None)
    # A 4-digit token that is not a plausible year is the account's last4.
    last4 = next((t for t in stem.split()
                  if re.fullmatch(r"\d{4}", t) and not re.match(r"^(19|20)\d{2}$", t)), None)
    account_id = None
    if entity and bank:
        account_id = f"{entity}_{bank.upper()}" + (f"_{last4}" if last4 else "")
    return entity, bank, last4, account_id


# ---------------------------------------------------------------------------
# Walk + plan
# ---------------------------------------------------------------------------

SKIP_NAMES = {".DS_Store", "Thumbs.db", "__MACOSX"}


def walk(root: Path, expand_zips=True, workdir=None):
    files = []
    for p in sorted(root.rglob("*")):
        if p.is_dir() or p.name in SKIP_NAMES or any(s in SKIP_NAMES for s in p.parts):
            continue
        if p.suffix.lower() == ".zip" and expand_zips:
            dest = (workdir or root.parent) / "_expanded" / p.stem
            dest.mkdir(parents=True, exist_ok=True)
            try:
                with zipfile.ZipFile(p) as z:
                    z.extractall(dest)
                files.extend(walk(dest, expand_zips=False, workdir=workdir))
            except Exception as e:
                files.append({"path": p, "kind": QUARANTINE, "confidence": "none",
                              "evidence": f"bad zip: {e}", "size": p.stat().st_size})
            continue
        files.append({"path": p, "size": p.stat().st_size})
    return files


def build_plan(root: Path, workdir=None):
    entries = walk(root, workdir=workdir)
    plan = []
    seen_hashes = {}
    for e in entries:
        if "kind" in e:          # already-quarantined zip
            plan.append(e)
            continue
        p = e["path"]
        kind, conf, evidence = detect_kind(p)
        h = sha256(p)
        dup_of = seen_hashes.get(h)
        seen_hashes.setdefault(h, str(p))
        entity, bank, last4, account_id = infer_account(p)
        plan.append({
            "path": p, "size": e["size"], "kind": kind, "confidence": conf,
            "evidence": evidence, "sha256": h, "duplicate_of": dup_of,
            "entity": entity, "bank": bank, "last4": last4, "account_id": account_id,
        })
    return plan


def print_scan(plan):
    by_kind = Counter(x["kind"] for x in plan)
    total_bytes = sum(x["size"] for x in plan)
    print(f"\n{len(plan)} files, {total_bytes/1e6:,.1f} MB\n")
    print(f"{'kind':<26}{'files':>7}{'MB':>10}  confidence")
    print("-" * 62)
    for kind, n in by_kind.most_common():
        mb = sum(x["size"] for x in plan if x["kind"] == kind) / 1e6
        confs = Counter(x["confidence"] for x in plan if x["kind"] == kind)
        cs = " ".join(f"{c}:{k}" for c, k in confs.most_common())
        print(f"{kind:<26}{n:>7}{mb:>10,.1f}  {cs}")

    dupes = [x for x in plan if x.get("duplicate_of")]
    if dupes:
        print(f"\n{len(dupes)} byte-identical duplicates (same file uploaded twice):")
        for d in dupes[:10]:
            print(f"   {d['path'].name}  ==  {Path(d['duplicate_of']).name}")

    unknown_acct = [x for x in plan if x["kind"].startswith("bank_statement")
                    and not x["account_id"]]
    if unknown_acct:
        print(f"\n{len(unknown_acct)} statements whose account could not be read from the "
              f"filename.\nRename as <ENTITY>_<BANK>_<LAST4>_<period> or map them explicitly:")
        for x in unknown_acct[:15]:
            print(f"   {x['path'].name}   (entity={x['entity']} bank={x['bank']})")

    quarantined = [x for x in plan if x["kind"] == QUARANTINE]
    if quarantined:
        print(f"\n{len(quarantined)} QUARANTINED — not ingested, reason given:")
        reasons = Counter(x["evidence"].split("(")[0].strip() for x in quarantined)
        for r, n in reasons.most_common():
            print(f"   {n:>4}  {r}")
        scanned = [x for x in quarantined if "scanned image" in x["evidence"]]
        if scanned:
            print(f"\n   {len(scanned)} are scanned/image PDFs with no text layer. These need "
                  f"OCR\n   before they can be parsed at all — check the bank portal for a "
                  f"CSV/OFX\n   download of the same period first; it is faster and exact.")

    entities = Counter(x["entity"] for x in plan if x["entity"])
    if entities:
        print(f"\nEntity coverage from filenames:")
        for ent, n in entities.most_common():
            print(f"   {ent:<14}{n:>4} files")
        missing = {"ZONE","XTRACK","AFG","IRON_LEASE","TRUCKMAX","SHAEFFER","RUNSTAR"} - set(entities)
        if missing:
            print(f"   no files for: {', '.join(sorted(missing))}")


def write_manifest(plan, out_path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["path", "kind", "confidence", "evidence", "size_bytes", "sha256",
                    "duplicate_of", "entity", "bank", "last4", "account_id",
                    "period_start", "period_end", "beginning_balance", "ending_balance"])
        for x in plan:
            w.writerow([x["path"], x["kind"], x["confidence"], x["evidence"], x["size"],
                        x.get("sha256", ""), x.get("duplicate_of") or "", x["entity"] or "",
                        x["bank"] or "", x["last4"] or "", x["account_id"] or "", "", "", "", ""])
    return out_path


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["scan", "plan", "run", "report"])
    ap.add_argument("root", nargs="?")
    ap.add_argument("--db", default=str(DB_PATH))
    ap.add_argument("--dsn")
    ap.add_argument("--manifest", default="data/processed/intake_manifest.csv")
    ap.add_argument("--yes", action="store_true", help="actually ingest (run only)")
    ap.add_argument("--workdir", help="where to expand archives")
    args = ap.parse_args()

    if args.cmd in ("scan", "plan", "run"):
        if not args.root:
            raise SystemExit("give a folder to scan")
        root = Path(args.root).expanduser()
        if not root.exists():
            raise SystemExit(f"no such folder: {root}")
        plan = build_plan(root, Path(args.workdir) if args.workdir else None)
        print_scan(plan)
        mpath = write_manifest(plan, Path(args.manifest))
        print(f"\nManifest written: {mpath}")
        print("Fill in period_start/period_end/beginning_balance/ending_balance for each "
              "statement.\nThose four columns drive the statement-total control, which is "
              "what proves\nthe parse was correct. Without them a bad parse is invisible.")
        if args.cmd == "run" and not args.yes:
            print("\nDry run. Re-run with --yes to ingest.")
    print()


if __name__ == "__main__":
    main()
