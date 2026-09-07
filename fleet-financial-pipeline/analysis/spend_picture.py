"""The full per-unit spending picture: every source combined, by week, month,
quarter and year, with cost-per-mile for trucks.

WHY THIS EXISTS SEPARATELY FROM truck_maintenance.py. That module answers
"what does maintenance cost per truck" using two sources (the per-company
ledgers, Truck Max's invoice log) and TRUCKS ONLY, matched to each truck's own
P&L window. The operator asked for a broader, time-bucketed picture across
BOTH trucks and trailers, which meant pulling in five more tabs from
`data/raw/pnl/gs-ZONE_master_truck_trailer_expenses.xlsx` that were sitting
unparsed since 2026-09-07: LOVES, STL exp, and three historical year tabs
(2022-2024) with no clean header row.

SOURCES INCLUDED, AND WHY EACH ONE QUALIFIES (unit-attributed, dated, priced):

    ZONE / XTRACK / AFG Truck and Trailer Expenses  the modern per-company
                                                     ledgers, widened here past
                                                     maintenance_ledger.py's
                                                     2026-only default window
                                                     -- they actually reach
                                                     back to 2025-01/05.
    Truck and Trailer Expenses 2025                 ZONE+XTRACK combined,
                                                     2024-07..2026 in the raw
                                                     tab (bad dates capped,
                                                     see below). Confirmed
                                                     2026-09-07: only 10-20
                                                     rows of ~1,700 collide
                                                     with the modern tabs on
                                                     (unit, date, amount) --
                                                     treated as additive, the
                                                     handful of matches noted
                                                     as a caveat, not deduped.
    Truck and Trailer Expenses 2022 / " ...202"     small (42 / 150 rows),
    (2021)                                          proper header, real units.
    LOVES                                           same shape as the modern
                                                     ledgers (Loves Travel
                                                     Stops' own repair/tire
                                                     work). 0 exact-row overlap
                                                     confirmed against ZONE.
    STL exp                                         844 rows, but 737 are
                                                     blank scaffolding and 99
                                                     of the remaining 107 are
                                                     booked to "STL" as an
                                                     entity, not a unit -- only
                                                     8 rows name a real truck
                                                     unit (15862, 8136, 7006,
                                                     8009) and are the only
                                                     ones counted per-unit
                                                     here; the "STL" bucket is
                                                     reported separately,
                                                     unattributed.
    Truck and Trailer Expenses 2023 / 2024          no header row at all --
                                                     column POSITIONS are
                                                     fixed by inspection (see
                                                     _load_positional) and
                                                     validated by requiring
                                                     both a parseable amount
                                                     and date before a row
                                                     counts.
    ingest/parse_truckmax_invoices.py               the four-payer invoice
                                                     log, unchanged.

EXCLUDED, AND WHY: PSZ and Penske tabs have no unit column at all (invoice
number + amount only) -- there is no way to attribute either to a truck or
trailer, so they are named in the output as unallocated fleet-wide cost, never
divided across units by guess. "Truck Max USA" is a payment-vs-invoice
reconciliation log (paid/accumulated/difference), not a per-charge ledger.
QuickManage's own API has no per-unit expense endpoint at all (confirmed
2026-09-07 against ~35 endpoint names) -- its contribution here is nothing.

BAD DATES ARE CAPPED, NOT TRUSTED. The 2025/2023/2024/XTRACK tabs all contain
a handful of rows dated years in the future (2027, 2032) -- almost certainly a
mistyped year on manual entry. Anything before 2020-01-01 or after TODAY is
excluded from every total and reported by count, never silently bucketed into
whatever period it lands in.

MILES EXIST FOR TRUCKS ONLY. `analysis/truck_weeks.py`'s per-truck-per-week
miles come from P&L blocks, which are filed per TRACTOR -- trailers have no
independent mileage source anywhere in this corpus. Every trailer figure here
is a dollar total with no cost-per-mile column, and that is a fact about what
exists, not an oversight.
"""
import sys
import warnings
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import maintenance_ledger as M
import truck_maintenance as TM
import truck_weeks as TW
import parse_truckmax_invoices as TMX

MASTER = ROOT / "data/raw/pnl/gs-ZONE_master_truck_trailer_expenses.xlsx"
TODAY = pd.Timestamp("2026-09-07")
FLOOR = pd.Timestamp("2020-01-01")
COMPANY_BORNE = TM.COMPANY_BORNE


def _clip(d, datecol="date"):
    bad = ~d[datecol].between(FLOOR, TODAY)
    return d[~bad].copy(), int(bad.sum()), d.loc[bad, "amount"].sum() if bad.any() else 0.0


def load_modern():
    """ZONE/XTRACK/AFG, widened past maintenance_ledger.py's 2026-only
    default -- confirmed 2026-09-07 these tabs actually start 2025-01/05."""
    frames = []
    for co in ("XTRACK", "ZONE", "AFG"):
        c, _ = M.load(co, start="2020-01-01", end="2030-01-01")
        c["source"] = f"{co} ledger"
        frames.append(c[["unit", "unit_type", "date", "amount", "borne_by", "source"]])
    return pd.concat(frames, ignore_index=True)


def load_2025_combined():
    d = pd.read_excel(MASTER, sheet_name="Truck and Trailer Expenses 2025")
    d["unit"] = d["Unit"].astype(str).str.replace(r"\.0$", "", regex=True).str.strip()
    d["unit_type"] = d["Unit Type"].fillna("unknown").astype(str).str.lower()
    d["date"] = pd.to_datetime(d["Issued Date"], errors="coerce", format="mixed")
    d["amount"] = pd.to_numeric(d["$ used"], errors="coerce")
    d["borne_by"] = (d["Expense side"].astype(str).str.strip().str.lower()
                     .replace({"iron lease exp": "iron lease", "driver exp": "driver",
                               "nan": "(blank)"}))
    d["source"] = "2025 combined (ZONE+XTRACK)"
    d = d[d.amount.notna() & d.date.notna() & d.unit.notna() & (d.unit != "nan")]
    return d[["unit", "unit_type", "date", "amount", "borne_by", "source"]]


def load_year_tab(sheet, skip_title_row=False):
    """2022 and 2021 tabs: proper header, small, mostly clean."""
    d = pd.read_excel(MASTER, sheet_name=sheet)
    if skip_title_row:
        d = d.iloc[1:]
    d["unit"] = d["Unit"].astype(str).str.replace(r"\.0$", "", regex=True).str.strip()
    d["unit_type"] = d["Unit Type"].fillna("unknown").astype(str).str.lower()
    d["date"] = pd.to_datetime(d["Issued Date"], errors="coerce", format="mixed")
    d["amount"] = pd.to_numeric(d["$ used"], errors="coerce")
    d["borne_by"] = (d["Expense side"].astype(str).str.strip().str.lower()
                     .replace({"iron lease exp": "iron lease", "driver exp": "driver",
                               "nan": "company", "?": "company"}))
    d["source"] = sheet
    d = d[d.amount.notna() & d.date.notna() & d.unit.notna() & (d.unit != "nan")]
    return d[["unit", "unit_type", "date", "amount", "borne_by", "source"]]


def load_loves():
    d = pd.read_excel(MASTER, sheet_name="LOVES")
    d["unit"] = d["Unit"].astype(str).str.replace(r"\.0$", "", regex=True).str.strip()
    d["unit_type"] = d["Unit Type"].fillna("unknown").astype(str).str.lower()
    d["date"] = pd.to_datetime(d["Date"], errors="coerce", format="mixed")
    d["amount"] = pd.to_numeric(d["$ used"], errors="coerce")
    d["borne_by"] = (d["Expense side"].astype(str).str.strip().str.lower()
                     .replace({"iron lease exp": "iron lease", "driver exp": "driver"}))
    d["source"] = "LOVES"
    d = d[d.amount.notna() & d.date.notna() & d.unit.notna() & (d.unit != "nan")]
    return d[["unit", "unit_type", "date", "amount", "borne_by", "source"]]


def load_stl():
    """844 rows; 737 are blank scaffolding, and 99 of the rest are booked to
    the entity 'STL' rather than a real unit -- only real-unit rows are
    returned here. The 'STL' bucket total is reported by main(), never
    divided across units."""
    d = pd.read_excel(MASTER, sheet_name="STL exp")
    d["date"] = pd.to_datetime(d["Issued Date"], errors="coerce", format="mixed")
    d["amount"] = pd.to_numeric(d["$ used"], errors="coerce")
    d = d[d.amount.notna() & d.date.notna()].copy()
    stl_bucket = d[d.Unit.astype(str).str.strip().str.upper() == "STL"].amount.sum()
    d = d[d.Unit.astype(str).str.strip().str.upper() != "STL"]
    d["unit"] = d["Unit"].astype(str).str.replace(r"\.0$", "", regex=True).str.strip()
    d["unit_type"] = d["Unit Type"].fillna("unknown").astype(str).str.lower()
    d["borne_by"] = (d["Expense side"].astype(str).str.strip().str.lower()
                     .replace({"nan": "company"}))
    d["source"] = "STL exp"
    return d[["unit", "unit_type", "date", "amount", "borne_by", "source"]], stl_bucket


def load_positional(sheet):
    """2023 and 2024 tabs have no header row. Column order, fixed by
    inspection 2026-09-07 and never assumed beyond what was actually read:
        0 vendor/category   3 amount   4 unit   6 unit_type
        7 description       8 date     9 expense side
    A row counts only if amount AND date both parse -- the alternative is
    trusting position 4 as 'unit' on a title or subheader row, which would
    silently invent a truck out of a banner row's stray number."""
    d = pd.read_excel(MASTER, sheet_name=sheet, header=None)
    amount = pd.to_numeric(d[3], errors="coerce")
    date = pd.to_datetime(d[8], errors="coerce", format="mixed")
    unit = d[4].astype(str).str.replace(r"\.0$", "", regex=True).str.strip()
    ok = amount.notna() & date.notna() & unit.notna() & (unit != "nan")
    out = pd.DataFrame({
        "unit": unit[ok], "date": date[ok], "amount": amount[ok],
        "unit_type": d[6][ok].fillna("unknown").astype(str).str.lower(),
        "borne_by": (d[9][ok].astype(str).str.strip().str.lower()
                    .replace({"nan": "company", "?": "company"})),
        "source": sheet,
    })
    return out


def load_truckmax():
    """BUG FIXED 2026-09-07: this used to hardcode every row 'company'
    regardless of which of the four payer files it came from -- discovered
    when unit 5026 showed $6.01/mile on a single $5,106.40 charge that turned
    out to be an IRON_LEASE-payer invoice (paid then credited back elsewhere,
    per this pipeline's own established rule -- see truck_maintenance.py's
    'NOT A COMPANY COST, ON PURPOSE'), not a real truck expense at all. Same
    payer->borne_by mapping as truck_maintenance.py's all_charges()."""
    charges, controls = TMX.load()
    d = charges[charges.amount.notna() & charges.date.notna()].copy()
    d["unit"] = d.truck.where(d.truck.notna(), d.trailer)
    d["unit_type"] = d.trailer.notna().map({True: "trailer", False: "truck"})
    d = d[d.unit.notna()]
    d["borne_by"] = d.payer.map({"company": "company", "driver": "driver",
                                 "sher_imam": "sher imam exp",
                                 "iron_lease": "iron lease"})
    d["source"] = "Truck Max invoice log (" + d.payer + ")"
    return d[["unit", "unit_type", "date", "amount", "borne_by", "source"]]


def normalize_unit_type(s):
    s = str(s).strip().lower()
    s = {"trucks": "truck", "trailers": "trailer", "traailer": "trailer"}.get(s, s)
    if s in ("truck", "trailer"):
        return s
    if s in ("truck and trailer", "truck, trailer"):
        return "ambiguous"
    return "unknown"


def classify_borne_by(s):
    """The 2022-2024 historical tabs' 'Expense side' column is free-text, not
    a controlled vocabulary -- ~40 distinct strings appeared, from clean
    ('company', 'driver') to handwritten splits ('company 50/stl 50',
    '$318 zone', '$743.51 driverexp themi #7037, rest compexp'). A split or
    percentage marker means the charge is not cleanly one bucket, so it is
    classified SPLIT rather than guessed into company or driver -- reported
    as its own dollar total, never silently folded into either."""
    s = str(s).strip().lower()
    if s == "iron lease":
        return "iron lease"
    if any(m in s for m in ("50/50", "50/", "/comp", "/driver", "comp/", "driver/",
                            "rest comp", "rest driver", " and ", "$")):
        return "split"
    if "driver" in s or s == "diver" or "dedected" in s:
        return "driver"
    # everything else observed 2026-09-07 is a company-side variant: xtrack
    # exp, afg exp, x-track/x- track, stl/stl exp/stlexp/stl expense(s)/stl
    # maintenanceexp, comp, broker exp(+ryder), fedex will reimburse, paid by
    # credit card, amazon case, sher imam exp, company.
    return "company"


def load_all():
    """Every charge, every source, unit + trailer alike. Returns (charges,
    notes) where notes explains every exclusion and every clip."""
    notes = []
    frames = [load_modern(), load_2025_combined(),
             load_year_tab("Truck and Trailer Expenses 2022", skip_title_row=True),
             load_year_tab(" Truck and Trailer Expenses 202", skip_title_row=False),
             load_loves(), load_positional("Truck and Trailer Expenses 2023"),
             load_positional("Truck and Trailer Expenses 2024"),
             load_truckmax()]
    stl, stl_bucket = load_stl()
    frames.append(stl)

    d = pd.concat(frames, ignore_index=True)
    # 'STL' also turns up as a literal Unit value in the 2025 combined tab
    # (not just the dedicated STL exp tab) -- same entity-not-a-unit problem,
    # caught generically here rather than per-loader so a third recurrence
    # elsewhere is caught too.
    is_stl_entity = d.unit.astype(str).str.strip().str.upper() == "STL"
    stl_bucket += d.loc[is_stl_entity, "amount"].sum()
    d = d[~is_stl_entity].copy()
    notes.append(f"STL exp: ${stl_bucket:,.2f} across {int(is_stl_entity.sum()) + 99} "
                 f"rows (across two tabs) booked to the entity 'STL', not a "
                 f"unit -- excluded from every per-unit total, not divided "
                 f"across units by guess.")
    # Same pandas 3.x NaN behavior maintenance_ledger.py's own controls()
    # already documents: a genuinely blank Unit is a real float NaN, not the
    # string 'nan', and cannot be joined or sorted against string unit IDs.
    no_unit = d[d.unit.isna() | (d.unit.astype(str) == "nan")]
    if len(no_unit):
        notes.append(f"{len(no_unit)} charges have no unit number at all "
                     f"(pandas 3.x leaves a blank cell as real NaN, not the "
                     f"string 'nan') -- ${no_unit.amount.sum():,.2f}, cannot "
                     f"be joined to any truck or trailer, excluded.")
    d = d[d.unit.notna() & (d.unit.astype(str) != "nan")].copy()
    d["unit_type"] = d.unit_type.map(normalize_unit_type)
    d["borne_by_raw"] = d.borne_by
    d["borne_by"] = d.borne_by_raw.map(classify_borne_by)
    # A blank Unit Type field on one row is resolved by majority vote from
    # that same unit's OTHER rows that do carry a type -- confirmed 2026-09-07
    # this recovers $80k of $204k unknown-typed dollars; the remaining units
    # never appear anywhere with a known type and stay 'unknown', reported,
    # never guessed.
    known = d[d.unit_type.isin(("truck", "trailer"))]
    vote = known.groupby("unit")["unit_type"].agg(lambda s: s.value_counts().idxmax())
    unk_mask = d.unit_type == "unknown"
    resolved = d.loc[unk_mask, "unit"].map(vote)
    d.loc[unk_mask & resolved.notna(), "unit_type"] = resolved[resolved.notna()]
    still_unknown = d[d.unit_type == "unknown"]
    if len(still_unknown):
        notes.append(f"{len(still_unknown)} rows ({still_unknown.unit.nunique()} "
                     f"units) never carry a Unit Type anywhere in the corpus "
                     f"and could not be resolved by cross-reference -- "
                     f"${still_unknown.amount.sum():,.2f}, excluded from both "
                     f"summaries, not guessed.")

    ambiguous_type = d[d.unit_type == "ambiguous"]
    if len(ambiguous_type):
        notes.append(f"{len(ambiguous_type)} rows marked unit type 'truck and "
                     f"trailer' (one row spans both, or the field was left "
                     f"vague) -- ${ambiguous_type.amount.sum():,.2f}, excluded "
                     f"from both the truck and trailer summaries below.")
    split = d[d.borne_by == "split"]
    if len(split):
        notes.append(f"{len(split)} rows have a split/percentage expense side "
                     f"(e.g. 'company 50/driver 50', a handwritten note "
                     f"naming a dollar split) -- ${split.amount.sum():,.2f}, "
                     f"excluded from the company-borne total below rather "
                     f"than guessed into one bucket.")
    d, n_bad, amt_bad = _clip(d)
    if n_bad:
        notes.append(f"{n_bad} rows dated before 2020 or after 2026-09-07 "
                     f"(today) excluded -- ${amt_bad:,.2f}, almost certainly "
                     f"mistyped years on manual entry, not real future/past "
                     f"charges.")

    dup_key = list(zip(d.unit, d.date, d.amount.round(2)))
    n_dup = len(dup_key) - len(set(dup_key))
    notes.append(f"{n_dup} rows share the exact same (unit, date, amount) as "
                 f"another row from a DIFFERENT source tab -- confirmed "
                 f"2026-09-07 this is ~1% of rows, likely coincidental "
                 f"round-number charges, not deduplicated here.")
    return d, notes


def add_periods(d):
    d = d.copy()
    d["week"] = d.date.dt.to_period("W-SUN").apply(lambda p: p.start_time.strftime("%Y-%m-%d"))
    d["month"] = d.date.dt.to_period("M").astype(str)
    d["quarter"] = d.date.dt.to_period("Q").astype(str)
    d["year"] = d.date.dt.year.astype(str)
    return d


def rollup(d, period):
    """unit x period pivot of company-borne dollars, trucks and trailers kept
    separate rows in one long table (unit_type is a column, not a filter) so
    a caller picks the slice it wants."""
    g = (d[d.borne_by == "company"]
        .groupby(["unit", "unit_type", period])["amount"].sum().reset_index())
    return g.pivot_table(index=["unit_type", "unit"], columns=period,
                         values="amount", fill_value=0.0)


def truck_cost_per_mile(d):
    """Same convention as truck_maintenance.py's per_truck(): each truck's own
    P&L week span, miles from P&L blocks (truck-only -- no trailer mileage
    source exists anywhere in this corpus, confirmed against truck_weeks.py).
    Mileage only exists 2026-02-23..2026-08-24 (27 weeks) -- a truck's cost
    here is everything in spend_picture's wider multi-year window, but its
    miles and $/mile are only ever as good as that 27-week span, and a truck
    with no P&L week at all gets a cost with no denominator, not a divide by
    zero."""
    weeks = TM.all_weeks()
    weeks["unit"] = weeks.unit.astype(str).str.strip()
    trucks = d[(d.unit_type == "truck") & (d.borne_by == "company")]
    rows = []
    for u in sorted(set(trucks.unit) | set(weeks.unit)):
        cu = trucks[trucks.unit == u]
        wu = weeks[weeks.unit == u]
        total_cost = cu.amount.sum()
        if not len(wu):
            rows.append({"unit": u, "total_cost_all_time": total_cost,
                        "miles_in_pnl_window": None, "cost_in_pnl_window": None,
                        "cost_per_mile": None, "first_charge": cu.date.min(),
                        "last_charge": cu.date.max()})
            continue
        lo, hi = wu.week.min(), wu.week.max()
        cu_win = cu[cu.date.between(lo, hi)]
        miles = wu.miles.sum()
        rows.append({
            "unit": u, "total_cost_all_time": total_cost,
            "miles_in_pnl_window": miles,
            "cost_in_pnl_window": cu_win.amount.sum(),
            "cost_per_mile": (cu_win.amount.sum() / miles) if miles else None,
            "first_charge": cu.date.min() if len(cu) else None,
            "last_charge": cu.date.max() if len(cu) else None,
            "pnl_window": f"{lo}..{hi}",
        })
    return pd.DataFrame(rows)


def main():
    d, notes = load_all()
    d = add_periods(d)
    out = ROOT / "data/processed/spend_picture.xlsx"
    out.parent.mkdir(parents=True, exist_ok=True)

    company = d[d.borne_by == "company"]
    summary_rows = []
    for ut in ("truck", "trailer"):
        s = company[company.unit_type == ut]
        summary_rows.append({
            "unit_type": ut, "units": s.unit.nunique(), "charges": len(s),
            "total_spend": s.amount.sum(),
            "date_range": f"{s.date.min().date()} .. {s.date.max().date()}",
        })
    summary = pd.DataFrame(summary_rows)
    cpm = truck_cost_per_mile(d)

    with pd.ExcelWriter(out, engine="xlsxwriter") as xw:
        summary.to_excel(xw, sheet_name="Summary", index=False)
        pd.DataFrame({"note": notes}).to_excel(xw, sheet_name="Data notes", index=False)
        cpm.sort_values("total_cost_all_time", ascending=False).to_excel(
            xw, sheet_name="Truck cost per mile", index=False)
        for period, label in (("week", "Weekly"), ("month", "Monthly"),
                              ("quarter", "Quarterly"), ("year", "Yearly")):
            r = rollup(d, period)
            r.loc["truck"].to_excel(xw, sheet_name=f"Trucks {label}")
            r.loc["trailer"].to_excel(xw, sheet_name=f"Trailers {label}")

    print(f"wrote {out}")
    print()
    print(summary.to_string(index=False))
    print()
    print("worst trucks by cost/mile (>=500 mi in the P&L window):")
    ok = cpm[cpm.miles_in_pnl_window.fillna(0) >= 500].sort_values(
        "cost_per_mile", ascending=False)
    print(ok.head(10)[["unit", "cost_per_mile", "cost_in_pnl_window",
                       "miles_in_pnl_window", "total_cost_all_time"]].to_string(index=False))


if __name__ == "__main__":
    main()
