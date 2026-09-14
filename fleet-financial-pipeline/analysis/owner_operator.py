"""What an owner-operator truck is worth to the company. A different machine.

THE COMPANY-DRIVER MODEL DOES NOT APPLY HERE AND MUST NOT BE REUSED. The two
kinds of truck sit in DIFFERENT BLOCK LAYOUTS in the same weekly tab, with
different columns, because they are different businesses:

    company driver   Unit | Driver | Gross | Mileage | Driver Salary |
                     Insur/Admin/Trl | DEF/Fuel/Fee | Truck Rental |
                     Toll/Scale | Additional | Subtotal | Other | Total
    owner operator   Unit | Driver | Gross | COMPANY CHARGE | Driver Salary |
                     DEDUCTIONS | Mileage | Truck Rental | Fuel | Toll/Scale |
                     FUEL DISCOUNT | Other | DRIVER PAY | PROFIT | RPM

WHERE THE COMPANY'S MONEY COMES FROM. On a company-driver truck the company
takes the whole gross and pays every cost. On an owner-operator truck it takes a
PERCENTAGE and the driver pays. Read the sheet's own arithmetic on one block:

    gross 4,400 - company charge 660 = driver salary 3,740
    less the driver's deductions:  785 + rent 1,146.60 + fuel 1,713.96
                                 + toll 350.62 - fuel discount 66.28 + other 65
    = DRIVER PAY -254.90        <- the driver's week, not the company's
    = PROFIT      726.28 = company charge 660 + fuel discount 66.28

**The company's profit on an owner-operator is the company charge plus the fuel
discount margin, and nothing else.** Rent, fuel and tolls are not company costs
here -- they are recovered in full from the settlement. That is why an OO truck
looks like pure margin and why a break-even in MILES is the wrong question for
it: the company cannot lose money on the miles, only on the truck.

WHAT THE SHEET STILL DOES NOT CHARGE THEM. An owner-operator truck is on the
group auto liability policy, carries occupational accident cover, holds an IRP
plate and pays HVUT, and absorbs a share of company overhead exactly like any
other truck. None of that appears in its block. So the P&L's "profit" on an OO
is a GROSS margin, and this module takes those four off it to get a net.

A NEGATIVE DRIVER PAY IS NOT A COMPANY LOSS. It means the week's deductions
exceeded the settlement and the balance carries to the driver. Reading that
column as the company's result inverts the sign of the whole business.
"""
import argparse
import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
sys.path.insert(0, str(ROOT / "ingest"))
warnings.filterwarnings("ignore")

import cost_structure as CS      # noqa: E402
import insurance_cost as INS     # noqa: E402
import truck_breakeven as B      # noqa: E402
import truck_weeks as T          # noqa: E402
from xtrack_trend import load as load_weeks   # noqa: E402

COMPANIES = ("ZONE", "XTRACK", "AFG")
WEEKS_PER_YEAR = 52.0


def block(company, weeks=13):
    """Owner-operator truck-weeks over the same window as the CD model."""
    tw = T.truck_weeks(company)
    ks = sorted(load_weeks(ROOT / B.WORKBOOK[company]))[-weeks:]
    oo = tw[tw.week.isin(ks) & (tw.kind == "owner_operator")]
    return oo, len(ks)


def model(company, weeks=13):
    oo, n = block(company, weeks)
    run = oo[oo.gross > 0]
    idle = oo[oo.gross <= 0]
    m = CS.structure(company, weeks)["m"]

    d = {"company": company, "weeks": n,
         "oo_truck_weeks": len(oo), "running": len(run), "idle": len(idle),
         "trucks": len(oo) / n,
         "gross": run.gross.mean(), "miles": run.miles.mean(),
         "rpm": run.gross.sum() / run.miles.sum(),
         "company_charge": run.company_charge.mean(),
         "charge_pct": run.company_charge.sum() / run.gross.sum(),
         "result": run.result.mean(),
         "margin_pct": run.result.sum() / run.gross.sum(),
         "rent_recovered": run.rent.mean(),
         "fuel_recovered": run.fuel.mean(),
         }
    # The other margin: result above the company charge is the fuel discount --
    # diesel bought at the fleet's negotiated price and settled at the driver's.
    d["fuel_discount_margin"] = d["result"] - d["company_charge"]

    # What the block never charges an owner-operator truck.
    ins = insurance_per_truck_week(company)
    reg = CS.registration_per_truck_week(company)
    d["insurance"] = ins
    d["registration"] = reg["per_truck_week"] if reg else None
    d["overhead"] = m["overhead_per_truck_week"]
    d["not_charged"] = sum(x for x in (ins, d["registration"], d["overhead"]) if x)
    d["net"] = d["result"] - d["not_charged"]
    # A percentage business has no break-even in MILES -- the company cannot
    # lose on a mile it does not pay for. It breaks even on GROSS.
    d["breakeven_gross"] = (d["not_charged"] / d["margin_pct"]
                            if d["margin_pct"] > 0 else float("inf"))
    d["breakeven_miles"] = d["breakeven_gross"] / d["rpm"] if d["rpm"] else None
    return d


def insurance_per_truck_week(company):
    """Insurance an OO truck really costs the company, from the policies.

    Auto liability and physical damage are per SCHEDULED UNIT and an
    owner-operator truck is on the schedule like any other. The mileage- and
    revenue-rated cargo layers are excluded: those scale with the freight, and
    the freight is already counted in the company charge.
    """
    reg = INS.load()
    by = INS.per_company(reg)
    if company not in by:
        return None
    per_unit = {k: v for k, v in by[company].items()
                if "cargo" not in k and "occupational" not in k}
    pdal = reg["allocation"]["physical_damage"]["from_the_submitted_schedule"]
    units = pdal[company]["units"]
    return sum(per_unit.values()) / units / WEEKS_PER_YEAR if units else None


def controls(d):
    fails = []
    # The sheet's own identity: profit = company charge + fuel discount.
    if d["result"] < d["company_charge"] * 0.9:
        fails.append("result is below the company charge -- the profit column is "
                     "not what this model thinks it is")
    if not 0.05 < d["charge_pct"] < 0.30:
        fails.append(f"company charge {100 * d['charge_pct']:.1f}% of gross is "
                     "outside any plausible percentage deal")
    if d["margin_pct"] < d["charge_pct"]:
        fails.append("margin below the charge -- the fuel discount cannot be negative")
    return fails


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weeks", type=int, default=13)
    a = ap.parse_args()
    ms = {c: model(c, a.weeks) for c in COMPANIES}
    W = 13
    bad = {c: controls(m) for c, m in ms.items()}
    print("controls: all pass" if not any(bad.values()) else "CONTROLS FAILED:")
    for c, f in bad.items():
        for x in f:
            print(f"  {c}: {x}")

    def row(label, key, fmt=",.0f", pct=False, indent=2):
        cells = []
        for c in COMPANIES:
            v = ms[c].get(key)
            if v is None:
                cells.append(f"{'--':>{W}}")
            else:
                cells.append(f"{100 * v:>{W}{fmt}}" if pct else f"{v:>{W}{fmt}}")
        print(" " * indent + f"{label:<40}" + "".join(cells))

    print(f"\n{'=' * 82}\nOWNER-OPERATOR ECONOMICS, PER TRUCK-WEEK, {a.weeks} WEEKS"
          f"\n{'=' * 82}")
    print(f"  {'':<40}" + "".join(f"{c:>{W}}" for c in COMPANIES))
    row("owner-operator trucks", "trucks", ",.1f")
    row("running truck-weeks", "running")
    print()
    print("  WHAT THE TRUCK PRODUCES")
    row("gross", "gross")
    row("miles", "miles")
    row("rate per mile", "rpm", ",.3f")
    print()
    print("  WHAT THE COMPANY KEEPS  (the driver pays the rest)")
    row("company charge", "company_charge")
    row("  as % of gross", "charge_pct", ",.2f", pct=True)
    row("fuel discount margin", "fuel_discount_margin")
    row("= P&L PROFIT ON THE TRUCK", "result")
    row("  as % of gross", "margin_pct", ",.2f", pct=True)
    print()
    print("  RECOVERED FROM THE DRIVER, NOT A COMPANY COST")
    row("truck rental", "rent_recovered")
    row("fuel", "fuel_recovered")
    print("    These sit in the driver's deductions. Counting them as company")
    print("    costs -- or the negative Driver Pay as a company loss -- inverts")
    print("    the sign of the whole business.")
    print()
    print("  WHAT THE BLOCK NEVER CHARGES THIS TRUCK")
    row("insurance (per scheduled unit)", "insurance", ",.2f")
    row("IRP plates + HVUT", "registration", ",.2f")
    row("share of company overhead", "overhead")
    row("= TOTAL NOT CHARGED", "not_charged")
    print()
    row("NET TO THE COMPANY PER TRUCK-WEEK", "net")
    print()
    print("  BREAK-EVEN IS ON GROSS, NOT MILES -- the company cannot lose money")
    print("  on a mile it does not pay for, only on a truck it carries costs for.")
    row("gross needed to cover those costs", "breakeven_gross")
    row("  = miles at the current rate", "breakeven_miles")
    row("actual gross now", "gross")
    print(f"  {'headroom, $ of gross a week':<40}" + "".join(
        f"{ms[c]['gross'] - ms[c]['breakeven_gross']:>{W},.0f}" for c in COMPANIES))

    print(f"\n{'=' * 82}\nTHE ANSWER TURNS ENTIRELY ON ONE ASSUMPTION\n{'=' * 82}")
    print("  Above, an owner-operator truck is charged a FULL share of company")
    print("  overhead -- the same as a company-driver truck. That single choice is")
    print("  the difference between 'owner-operators earn nothing' and 'they earn")
    print("  well', and the sheets contain no evidence either way, so it is shown")
    print("  as a range rather than settled by preference.")
    print(f"\n  {'share of overhead charged to an OO truck':<40}"
          + "".join(f"{c:>{W}}" for c in COMPANIES))
    for share in (1.0, 0.75, 0.5, 0.25, 0.0):
        cells = []
        for c in COMPANIES:
            m = ms[c]
            net = m["result"] - (m["insurance"] or 0) - (m["registration"] or 0) \
                - m["overhead"] * share
            cells.append(f"{net:>{W},.0f}")
        print(f"  {f'{100 * share:.0f}% -> net per truck-week':<40}" + "".join(cells))
    print("\n  WHAT WOULD SETTLE IT: an owner-operator uses dispatch and the fuel")
    print("  card but no payroll run, no recruiting spend, no company insurance on")
    print("  the driver, and no idle-truck carry. Splitting the overhead components")
    print("  by which of them an OO truck actually consumes is the measurement --")
    print("  the components are already named in truck_breakeven.model()['named'].")

    print(f"\n{'=' * 82}\nAGAINST A COMPANY-DRIVER TRUCK\n{'=' * 82}")
    print(f"  {'':<40}" + "".join(f"{c:>{W}}" for c in COMPANIES))
    for c in COMPANIES:
        pass
    cd = {c: CS.structure(c, a.weeks) for c in COMPANIES}
    def cdrow(label, fn, fmt=",.0f"):
        print(f"  {label:<40}" + "".join(f"{fn(cd[c], ms[c]):>{W}{fmt}}"
                                         for c in COMPANIES))
    cdrow("company-driver gross", lambda s, m: s["m"]["cd_gross"] / s["m"]["cd_trucks"])
    cdrow("owner-operator gross", lambda s, m: m["gross"])
    cdrow("CD result per truck-week",
          lambda s, m: (s["m"]["cd_gross"] - s["m"]["cd_block_cost"]) / s["m"]["cd_trucks"]
          - s["m"]["overhead_per_truck_week"])
    cdrow("OO net per truck-week", lambda s, m: m["net"])
    print("\n  An owner-operator truck earns the company less per week and risks it")
    print("  less: no fuel to fund, no wage to pay, no idle truck to carry. The")
    print("  comparison is a RISK trade, not a margin one -- which is why the two")
    print("  cannot be averaged into one 'cost per truck'.")


if __name__ == "__main__":
    main()
