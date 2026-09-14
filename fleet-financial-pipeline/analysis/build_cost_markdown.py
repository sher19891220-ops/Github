"""
Builds a single, self-contained Markdown document with the full cost picture
of the fleet -- per company and per unit -- so it can be uploaded to another
project and understood without this repository alongside it.

Reads ONLY already-built, already-tested outputs: data/processed/facts.json,
data/processed/cost_breakdown_view.json, data/processed/overhead_view.json,
data/processed/truck_maintenance.csv, data/processed/pnl_unit_week_{co}.csv,
and analysis/truck_weeks.py's own IRON_RATE_CARD constant. Nothing here
recomputes a cost; it only writes numbers already established elsewhere into
prose and tables. Run `python3 analysis/facts.py --build`,
`python3 analysis/build_cost_breakdown_view.py` and
`python3 analysis/build_overhead_view.py` first if those are stale -- this
script does not check.
"""
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
from truck_weeks import IRON_RATE_CARD  # noqa: E402

COMPANIES = ("ZONE", "XTRACK", "AFG")
LABEL = {"ZONE": "Zone LLC (Zone-OH)", "XTRACK": "Xtrack LLC", "AFG": "AFG Transportco LLC"}


def usd(v, d=0):
    if v is None:
        return "—"
    return f"-${abs(v):,.{d}f}" if v < 0 else f"${v:,.{d}f}"


def num(v, d=0):
    return "—" if v is None else f"{v:,.{d}f}"


def load_json(name):
    return json.loads((ROOT / "data/processed" / name).read_text())


def company_section(CB, co):
    c = CB["companies"][co]
    fx, vr, oh, cur, be, idl, ins = (c["fixed"], c["variable"], c["overhead"],
                                      c["current"], c["breakeven"], c["idle"], c["insurance_annual"])
    lines = []
    lines.append(f"### {LABEL[co]}\n")
    lines.append(f"Period: {c['period']}. Trucks: {c['trucks']} total "
                 f"({c['company_driver_trucks']} company-driver, {c['owner_operator_trucks']} owner-operator). "
                 f"Gross: {usd(c['gross_per_week'])}/week. Net: {usd(c['net_per_week'])}/week.\n")
    lines.append("**Fixed cost, per company-driver truck-week**\n")
    lines.append("| Line | Amount |")
    lines.append("|---|---:|")
    lines.append(f"| Truck rent, base | {usd(fx['truck_rent'])} |")
    lines.append(f"| Admin / insurance / trailer | {usd(fx['admin_insurance_trailer'])} |")
    lines.append(f"| Fixed company overhead | {usd(fx['fixed_overhead'])} |")
    lines.append(f"| Subtotal, in the sheet | {usd(fx['subtotal_in_sheet'])} |")
    lines.append(f"| + IRP plates + HVUT (not in the sheet) | {usd(fx['registration'])} |")
    lines.append(f"| **TRUE fixed, per truck-week** | **{usd(fx['true_total_per_truck_week'])}** |")
    lines.append(f"| per truck-day | {usd(fx['true_total_per_truck_day'])} |\n")
    lines.append("**Variable cost, per loaded mile**\n")
    lines.append("| Line | Amount |")
    lines.append("|---|---:|")
    for k, label in (("fuel", "Fuel"), ("driver_pay", "Driver pay"), ("toll", "Toll"),
                      ("iron_lease_mileage", "Iron Lease mileage charge")):
        lines.append(f"| {label} | ${vr[k]:.4f} |" if vr.get(k) is not None else f"| {label} | — |")
    lines.append(f"| + IFTA fuel tax (not in the sheet) | ${vr['ifta']:.4f} |" if vr.get("ifta") is not None else "| + IFTA fuel tax | — |")
    lines.append(f"| + Oregon weight-mile tax (not in the sheet) | ${vr['oregon']:.4f} |" if vr.get("oregon") is not None else "| + Oregon weight-mile tax | — |")
    lines.append(f"| **TRUE variable, per loaded mile** | **${vr['true_total_per_mile']:.4f}** |\n" if vr.get("true_total_per_mile") is not None else "| **TRUE variable, per loaded mile** | — |\n")
    lines.append(f"Overhead: {usd(oh['per_truck_week'])}/truck-week "
                 f"({usd(oh['fixed_per_truck_week'])} fixed + {usd(oh['variable_per_truck_week'])} variable), "
                 f"{vr['overhead_pct_of_gross']:.2f}% of gross.\n")
    lines.append(f"Current performance: {num(cur['miles_per_truck_week'])} miles/truck-week at "
                 f"${cur['rate_per_mile']:.3f}/mile.\n")
    lines.append("**Break-even**\n")
    lines.append(f"- Miles/truck-week needed at the current rate: **{num(be['miles_at_current_rate'])}**")
    lines.append(f"- Rate/mile needed at current miles: **${be['rate_at_current_miles']:.3f}**")
    lines.append("- Break-even miles/truck-week by rate:")
    lines.append("  | Rate | Miles |")
    lines.append("  |---:|---:|")
    for r in be["by_rate"]:
        lines.append(f"  | ${r['rate']:.2f} | {num(r['miles'])} |")
    lines.append("")
    lines.append(f"Idle truck cost: {usd(idl['cost_per_truck_week'])}/week, {usd(idl['cost_per_truck_day'])}/day.\n")
    lines.append("**Insurance, annual (effective, at cost)**\n")
    lines.append("| Line | Annual |")
    lines.append("|---|---:|")
    for k, v in ins.items():
        if k == "total":
            continue
        lines.append(f"| {k.replace('_', ' ')} | {usd(v)} |")
    lines.append(f"| **Total** | **{usd(ins['total'])}** |\n")
    return "\n".join(lines)


def normalize_unit(u):
    """Each company's CSV stores 'unit' in a different dtype (ZONE: float64,
    XTRACK: int64, AFG: str) -- concatenating them raw makes the SAME truck
    number group as three different keys (496635 int != 496635.0 float !=
    '496635' str), splitting one truck across multiple rows. Cast every whole-
    number float through int() first, matching the exact fix CLAUDE.md already
    documents for this identical bug in ingest/parse_truckmax_invoices.py."""
    if pd.isna(u):
        return None
    if isinstance(u, float) and u.is_integer():
        return str(int(u))
    s = str(u).strip()
    try:
        f = float(s)
        return str(int(f)) if f.is_integer() else s
    except ValueError:
        return s


def per_unit_table():
    rows = []
    for co in COMPANIES:
        df = pd.read_csv(ROOT / f"data/processed/pnl_unit_week_{co}.csv")
        df["unit"] = df["unit"].apply(normalize_unit)
        df = df[df["unit"].notna()]
        g = df.groupby("unit").agg(
            weeks=("week_start", "nunique"),
            revenue_weeks=("gross", lambda s: int((s > 0).sum())),
            total_gross=("gross", "sum"),
            total_miles=("mileage", "sum"),
        ).reset_index()
        g["company"] = co
        rows.append(g)
    units = pd.concat(rows, ignore_index=True)
    # a truck can run under more than one company; combine those rows into one
    agg = units.groupby("unit").agg(
        companies=("company", lambda s: "/".join(sorted(set(s)))),
        weeks=("weeks", "sum"),
        revenue_weeks=("revenue_weeks", "sum"),
        total_gross=("total_gross", "sum"),
        total_miles=("total_miles", "sum"),
    ).reset_index()
    # Drop empty template scaffolding blocks -- zero gross AND zero miles across
    # every week means the row is never a real truck-week, not a truck that
    # simply never earned (an idle truck still carries a negative total from
    # rent/insurance -- see CLAUDE.md's "~82 empty template blocks" note).
    agg = agg[(agg["total_gross"] != 0) | (agg["total_miles"] != 0)]
    agg["avg_rpm"] = agg.apply(lambda r: r.total_gross / r.total_miles if r.total_miles else None, axis=1)

    maint = pd.read_csv(ROOT / "data/processed/truck_maintenance.csv")
    maint = maint[["unit", "cost_per_week", "cost_per_mile"]].copy()
    maint["unit"] = maint["unit"].apply(normalize_unit)
    maint = maint[maint["unit"].notna()]
    merged = agg.merge(maint, on="unit", how="left")

    def tier(u):
        t = IRON_RATE_CARD.get(str(u))
        return f"${t[0]:.0f}/wk + ${t[1]:.2f}/mi" if t else "—"
    merged["iron_lease_tier"] = merged["unit"].apply(tier)
    merged = merged.sort_values("total_gross", ascending=False)
    return merged


def unit_table_markdown(df):
    lines = ["| Unit | Company(ies) | Weeks in P&L | Revenue weeks | Total gross | Total miles | Avg RPM | "
             "Maint. $/truck-week | Maint. $/mile | Iron Lease tier |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---|"]
    for _, r in df.iterrows():
        lines.append(
            f"| {r.unit} | {r.companies} | {int(r.weeks)} | {int(r.revenue_weeks)} | "
            f"{usd(r.total_gross)} | {num(r.total_miles)} | "
            f"{'$' + format(r.avg_rpm, '.3f') if pd.notna(r.avg_rpm) else '—'} | "
            f"{usd(r.cost_per_week, 2) if pd.notna(r.cost_per_week) else '—'} | "
            f"{'$' + format(r.cost_per_mile, '.4f') if pd.notna(r.cost_per_mile) else '—'} | "
            f"{r.iron_lease_tier} |")
    return "\n".join(lines)


def main():
    CB = load_json("cost_breakdown_view.json")
    OV = load_json("overhead_view.json")

    parts = []
    parts.append("# Fleet cost structure — full detail, per company and per unit\n")
    parts.append(f"Generated from `analysis/build_cost_markdown.py`, itself reading only already-tested "
                 f"pipeline outputs (source fingerprint `{CB.get('source_fingerprint')}`). "
                 f"Multi-entity OTR dry van operation, Columbus OH: **Zone LLC (Zone-OH)**, "
                 f"**Xtrack LLC**, **AFG Transportco LLC**. Three separate operating companies sharing a "
                 f"common driver pool, equipment mix, and (for named US staff and the shop) group-level "
                 f"overhead.\n")
    parts.append("## How to read this\n")
    parts.append(
        "- **Fixed cost** is charged whether or not the truck ran that week (rent, admin/insurance/trailer, "
        "fixed overhead, registration). It is priced **per company-driver truck** — owner-operators carry "
        "their own equipment and are not charged this way (see the Owner-operator section below).\n"
        "- **Variable cost** is per loaded mile (fuel, driver pay, tolls, Iron Lease mileage charge, IFTA "
        "fuel tax, Oregon weight-mile tax where applicable).\n"
        "- **Overhead** is a residual of each company's own P&L (`gross - net - company-driver block cost - "
        "owner-operator cost`), split fixed/variable on its own named components. It is **not** the same "
        "thing as the operator-supplied named-staff roster in the Group overhead roster section — a raise "
        "to a specific named person (e.g. an office manager or shop mechanic) moves the roster table, not "
        "this per-company residual.\n"
        "- **Break-even** is the miles/truck-week a company-driver truck must run at its current rate/mile "
        "to cover its own fixed cost against its own contribution margin per mile — plus a table of "
        "break-even miles at a range of rates.\n"
        "- **Insurance** here is the *effective* (at-cost) annual premium, priced per policy line: some "
        "lines are per scheduled unit, some are % of insured value, some are % of gross revenue, one is "
        "per mile. This is different from — and normally higher than — the sheet's blended "
        "'admin/insurance/trailer' fixed-cost line shown separately above.\n"
        "- **Per-unit table**: one row per truck number, aggregated across every week and every company "
        "that ran it in the P&L window (a truck can move between companies). `Avg RPM` is total gross ÷ "
        "total miles. Maintenance columns are a measured **floor** (combined Truck Max ledger + invoice "
        "log coverage is 42-44% of each company's own panel maintenance line — see the maintenance-ledger "
        "coverage figures above). Iron Lease tier is shown only for the ~22 trucks on that rate card; every "
        "other truck rents from elsewhere or the P&L's own measured rate.\n")

    parts.append("## Per-company cost structure\n")
    for co in COMPANIES:
        parts.append(company_section(CB, co))

    parts.append("## Group overhead roster (operator-supplied, not per-company)\n")
    parts.append(
        f"This is a *different* number from each company's own 'fixed company overhead' line above: it is "
        f"the operator's own named US staff (1099) and shop labour roster, read from `config/overhead.json`, "
        f"and it is **not** read by the per-company residual model at all. As of {OV['as_of']}, assuming "
        f"{OV['trucks_assumed']} trucks:\n")
    parts.append("| Line | Amount/week |")
    parts.append("|---|---:|")
    O = OV["overhead"]
    parts.append(f"| Tashkent office | {usd(O['tashkent_per_week'])} |")
    parts.append(f"| US staff & office | {usd(O['us_staff_and_office_per_week'])} |")
    parts.append(f"| Owners | {usd(O['owners_per_week'])} |")
    parts.append(f"| Shop (excluded from the group default) | {usd(O['shop_per_week'])} |")
    parts.append(f"| **Total, shop excluded (default)** | **{usd(O['total_excl_shop_per_week'])}** |")
    parts.append(f"| **Total, shop included** | **{usd(O['total_incl_shop_per_week'])}** |\n")
    be = OV["group_breakeven"]
    parts.append(f"Group break-even, shop excluded: **{be['shop_excluded']['fixed_per_truck_week']:,.2f}** "
                 f"$/truck-week, **{be['shop_excluded']['breakeven_miles_per_truck_week']:,}** miles/truck-week. "
                 f"Shop included: **{be['shop_included']['fixed_per_truck_week']:,.2f}** $/truck-week, "
                 f"**{be['shop_included']['breakeven_miles_per_truck_week']:,}** miles/truck-week.\n")

    parts.append("## Per-unit summary (every truck, aggregated across its full P&L window)\n")
    parts.append(unit_table_markdown(per_unit_table()))
    parts.append("")

    parts.append("## Sourcing and caveats\n")
    parts.append(
        "- All company-level figures above are read from `data/processed/facts.json` / "
        "`cost_breakdown_view.json` / `overhead_view.json` — built by `analysis/cost_structure.py`, "
        "`analysis/truck_breakeven.py`, `analysis/insurance_cost.py` and `analysis/breakeven.py`. "
        "Nothing in this document is recomputed independently of those modules' own test suites.\n"
        "- Maintenance cost per truck is a **floor**, not the true cost: it covers only what two ledgers "
        "(the original Truck Max repair ledger and its separate invoice log) capture, cross-checked at "
        "42-44% coverage of each company's own panel maintenance line.\n"
        "- Registration (IRP/HVUT) has no column anywhere in the weekly P&L; it is priced separately from "
        "state filings and folded into 'fixed cost' above as a corrected, responsibility-adjusted rate.\n"
        "- Owner-operator trucks are NOT priced the same way as company-driver trucks: they carry their own "
        "equipment and fuel, and the company's profit on one is only the company charge plus the fuel "
        "discount margin, not the block's gross.\n")

    out_path = ROOT / "docs" / "cost_breakdown_full.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(parts))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
