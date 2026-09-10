"""Every established number in one place, so a question is a lookup, not a build.

WHERE THE TIME ACTUALLY WENT, MEASURED. Answering from a module that already
exists takes 23 seconds. Eight questions in one session produced 3,605 lines of
Python, 20 test modules and a 4m40 suite run after nearly every change. The cost
of a question was never the reading -- it was that each one BUILT something.

So the fix is not more speed, it is a different default. Most questions are
"what does the data say", and the data has already said it. This module runs
every built model ONCE and writes the answers to data/processed/facts.json, and
then a question is a grep against a file instead of an analysis.

    python3 analysis/facts.py --build         # ~1 minute, all models
    python3 analysis/facts.py --find rent     # instant
    python3 analysis/facts.py --stale         # is any of it out of date?

WHEN TO BUILD A MODULE INSTEAD. When the answer needs a control -- a figure that
has to reconcile to something, a parse that can silently return nothing, a
comparison that will be rerun as new documents arrive. Those earned their code.
"What is XTRACK's fixed cost per truck" did not; it was already computed.

STALENESS IS THE ONLY THING THAT MAKES THIS DANGEROUS. A facts file is a cache
of conclusions, and a conclusion that outlives its evidence is exactly the kind
of error this pipeline exists to catch. So every fact carries the fingerprint of
the documents behind it, `--stale` compares that against the corpus as it stands
now, and a stale fact is REPORTED rather than served quietly.
"""
import argparse
import json
import sys
import time
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import cache  # noqa: E402

FACTS = ROOT / "data/processed/facts.json"
COMPANIES = ("ZONE", "XTRACK", "AFG")
# The documents behind the facts. A fact is stale when any of these moves.
SOURCES = lambda: (                                    # noqa: E731
    sorted(str(p) for p in (ROOT / "data/raw/pnl").glob("*.xlsx"))
    + sorted(str(p) for p in (ROOT / "data/raw/ifta").rglob("*.pdf"))
    + sorted(str(p) for p in (ROOT / "data/raw/permits").glob("*.xlsx"))
    + sorted(str(p) for p in (ROOT / "data/raw/xtrack").glob("Invoice*.xlsx"))
    + [str(ROOT / "config/insurance.json")])


def build():
    """Run every model once and flatten what they produce.

    Each fact is (key, value, unit, source module). The key is a path, so
    `--find` on a word matches everything about it across all three companies
    without anybody maintaining a list of question phrasings.
    """
    import cost_structure as CS
    import truck_breakeven as B
    import insurance_cost as INS
    import oregon_gap as OG
    import parse_factoring as PF
    import factoring as FA

    out, t0 = {}, time.time()

    def put(key, value, unit, src):
        out[key] = {"value": value, "unit": unit, "source": src}

    ss = {c: CS.structure(c, 13) for c in COMPANIES}
    for c, s in ss.items():
        m = s["m"]
        put(f"{c}/period", f"{m['from']}..{m['to']}", "13 weeks", "cost_structure")
        for name, v in (("gross", m["gross"]), ("net", m["net"]),
                        ("overhead", m["overhead"])):
            put(f"{c}/{name}_per_week", round(v), "$/wk", "cost_structure")
        put(f"{c}/trucks", round(m["trucks"], 1), "trucks", "cost_structure")
        put(f"{c}/company_driver_trucks", round(m["cd_trucks"], 1), "trucks", "cost_structure")
        put(f"{c}/owner_operator_trucks", round(m["oo_trucks"], 1), "trucks", "cost_structure")
        for name, v in s["fixed"].items():
            put(f"{c}/fixed/{name}", round(v), "$/truck-week", "cost_structure")
        put(f"{c}/fixed/subtotal_in_the_sheet", round(s["fixed_total"]),
            "$/truck-week", "cost_structure")
        put(f"{c}/fixed/registration_not_in_the_sheet",
            round(s["outside_fixed_total"], 2), "$/truck-week", "cost_structure")
        put(f"{c}/fixed/TRUE_TOTAL",
            round(s["fixed_total"] + s["outside_fixed_total"]), "$/truck-week",
            "cost_structure")
        put(f"{c}/fixed/per_truck_day",
            round((s["fixed_total"] + s["outside_fixed_total"]) / 7), "$/truck-day",
            "cost_structure")
        for name, v in s["variable"].items():
            put(f"{c}/variable/{name}", round(v, 4), "$/loaded mile", "cost_structure")
        for name, v in s["outside_variable"].items():
            if v is not None:
                put(f"{c}/variable/{name}_not_in_the_sheet", round(v, 4),
                    "$/loaded mile", "cost_structure")
        put(f"{c}/variable/TRUE_TOTAL",
            round(s["variable_total"] + s["outside_variable_total"], 4),
            "$/loaded mile", "cost_structure")
        put(f"{c}/variable/overhead_pct_of_gross",
            round(100 * s["overhead_pct_of_gross"], 2), "% of gross", "cost_structure")
        put(f"{c}/overhead/per_truck_week", round(m["overhead_per_truck_week"]),
            "$/truck-week", "cost_structure")
        put(f"{c}/overhead/fixed_per_truck_week",
            round(m["fixed_overhead_per_truck_week"]), "$/truck-week", "cost_structure")
        put(f"{c}/breakeven/miles_at_current_rate",
            round(CS.true_breakeven(s, m["rpm"])), "loaded miles/wk", "cost_structure")
        put(f"{c}/breakeven/rate_at_current_miles",
            round(B.breakeven_rpm(m, m["miles_per_truck"]), 3), "$/mile", "truck_breakeven")
        put(f"{c}/current/miles_per_truck", round(m["miles_per_truck"]),
            "loaded miles/wk", "truck_breakeven")
        put(f"{c}/current/rate_per_mile", round(m["rpm"], 3), "$/mile", "truck_breakeven")
        put(f"{c}/idle/cost_per_truck_week",
            round(m["parked_cost"] + m["fixed_overhead_per_truck_week"]),
            "$/truck-week", "truck_breakeven")
        put(f"{c}/idle/cost_per_truck_day", round(m["idle_day_cost"]),
            "$/truck-day", "truck_breakeven")
        for rate in (2.40, 2.60, 2.80, 3.00, 3.20):
            put(f"{c}/breakeven/miles_at_{rate:.2f}",
                round(B.breakeven_miles(m, rate)), "loaded miles/wk", "truck_breakeven")

    # group
    put("GROUP/gross_per_week", round(sum(s["m"]["gross"] for s in ss.values())),
        "$/wk", "cost_structure")
    put("GROUP/overhead_per_week", round(sum(s["m"]["overhead"] for s in ss.values())),
        "$/wk", "cost_structure")
    put("GROUP/trucks", round(sum(s["m"]["trucks"] for s in ss.values()), 1),
        "trucks", "cost_structure")
    outside = sum(s["outside_fixed_total"] * s["m"]["cd_trucks"]
                  + s["outside_variable_total"] * s["m"]["cd_miles"] for s in ss.values())
    put("GROUP/cost_the_sheets_do_not_carry", round(outside), "$/wk", "cost_structure")
    put("GROUP/cost_the_sheets_do_not_carry_annual", round(outside * 52), "$/yr",
        "cost_structure")

    # insurance, priced from the policies
    reg = INS.load()
    by = INS.per_company(reg)
    for c, lines in by.items():
        for k, v in lines.items():
            put(f"{c}/insurance/{k}", round(v), "$/yr", "insurance_cost")
        put(f"{c}/insurance/TOTAL_annual", round(sum(lines.values())), "$/yr",
            "insurance_cost")

    # oregon exposure
    rows, rt = OG.gaps()
    put("GROUP/oregon/weight_mile_rate", rt, "$/mile", "oregon_gap")
    for r in rows:
        if r["gap_miles"] > OG.MATERIAL_MILES:
            put(f"{r['company']}/oregon/{r['quarter']}_unfiled_miles",
                round(r["gap_miles"]), "miles", "oregon_gap")
            put(f"{r['company']}/oregon/{r['quarter']}_tax_at_risk",
                round(r["tax_at_risk"], 2), "$", "oregon_gap")

    # factoring
    inv, _ = PF.load()
    st = PF.by_status(inv)
    for s_name, (n, amt) in st.items():
        put(f"GROUP/factoring/{s_name.lower().replace(' ', '_')}", round(amt), "$",
            "factoring")
    risky = PF.at_risk(inv)
    put("GROUP/factoring/AT_RISK", round(sum(r["amount"] or 0 for r in risky)), "$",
        "factoring")
    top = FA.concentration(inv)
    if top:
        put("GROUP/factoring/largest_credit_denial_customer", top[0][0], "", "factoring")
        put("GROUP/factoring/largest_credit_denial_amount", round(top[0][1][1]), "$",
            "factoring")

    return {"built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "build_seconds": round(time.time() - t0, 1),
            "source_fingerprint": cache.fingerprint(SOURCES()),
            "source_files": len(SOURCES()),
            "facts": out}


def load():
    if not FACTS.exists():
        return None
    return json.loads(FACTS.read_text())


_UNSET = object()


def stale(doc=_UNSET):
    """Has the corpus moved since these facts were built?

    The only thing that makes a facts file dangerous is a conclusion outliving
    its evidence, so this is checked and reported rather than assumed.

    `doc` omitted means "load whatever is on disk"; `doc=None` means "there is
    no document", which is a DIFFERENT question. Collapsing the two with
    `doc = doc or load()` made a caller asking about an absent facts file get an
    answer about the present one.
    """
    if doc is _UNSET:
        doc = load()
    if not doc:
        return True, "no facts file -- run --build"
    now = cache.fingerprint(SOURCES())
    if now != doc["source_fingerprint"]:
        return True, (f"the corpus changed since {doc['built_at']} "
                      f"({doc['source_files']} files then, {len(SOURCES())} now)")
    return False, f"current as of {doc['built_at']}"


def find(term, doc=_UNSET):
    if doc is _UNSET:
        doc = load()
    if not doc:
        return []
    t = term.lower().replace(" ", "_")
    return [(k, v) for k, v in doc["facts"].items()
            if t in k.lower() or t in str(v["value"]).lower()]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--find", metavar="TERM")
    ap.add_argument("--stale", action="store_true")
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()

    if a.build:
        doc = build()
        FACTS.parent.mkdir(parents=True, exist_ok=True)
        FACTS.write_text(json.dumps(doc, indent=1))
        print(f"{len(doc['facts'])} facts from {doc['source_files']} source files "
              f"in {doc['build_seconds']}s -> {FACTS.relative_to(ROOT)}")
        return

    doc = load()
    if not doc:
        print("no facts file yet. run: python3 analysis/facts.py --build")
        return
    is_stale, why = stale(doc)
    print(("STALE: " if is_stale else "") + why)
    if is_stale:
        print("  rebuild with --build before quoting anything below.")

    if a.stale:
        return
    rows = list(doc["facts"].items()) if a.all else (find(a.find, doc) if a.find else [])
    if a.find and not rows:
        print(f"\nnothing matches '{a.find}'. Try --all to see every key.")
    for k, v in rows:
        val = v["value"]
        val = f"{val:,}" if isinstance(val, (int, float)) else val
        print(f"  {k:<52}{str(val):>14} {v['unit']:<16}{v['source']}")
    if rows:
        print(f"\n  {len(rows)} fact(s)")


if __name__ == "__main__":
    main()
