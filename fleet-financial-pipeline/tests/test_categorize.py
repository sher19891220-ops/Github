"""
Taxonomy tests. Run after ANY edit to taxonomy/categorize.py:

    python tests/test_categorize.py

Rule order is first-match-wins, so a new rule near the top can silently steal
matches from every rule below it. These cases are the ones that were actually
observed to be wrong, plus the neighbours most likely to break when they are
fixed.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from taxonomy.categorize import categorize, classify, extract_unit_number

CASES = [
    # (memo, amount, expected_category, why)

    # --- intercompany must beat generic keywords -------------------------
    ("TRANSFER TO IRON LEASE LLC", -25000, "intercompany",
     "entity name contains 'lease'; previously lost to lease_rent"),
    ("ACH XTRACK LLC LOAN REPAYMENT", -12000, "intercompany",
     "previously lost to loan_finance"),
    ("WIRE TO ZONE LLC INSURANCE REIMB", -8000, "intercompany",
     "previously lost to insurance_premium"),
    ("TRUCK MAX USA LLC RENT", -4000, "intercompany",
     "previously lost to lease_rent"),
    ("PAYMENT SHAEFFER TECHNOLOGIES", -3000, "intercompany", ""),
    ("RUNSTAR LLC TRANSFER", -5000, "intercompany", ""),
    ("AFG TRANSPORTCO FUNDING", -9000, "intercompany", ""),
    # a third party that merely looks similar must NOT be intercompany
    ("ZONE LOGISTICS INC PAYMENT", -1200, "uncategorized",
     "'Zone LLC' pattern requires the LLC, so a lookalike third party is safe"),

    # --- plurals: every one of these previously fell to uncategorized ----
    ("Tolls", -2100, "tolls", "plural"),
    ("Toll", -50, "tolls", "singular still works"),
    ("Repairs", -3800, "maintenance", "plural"),
    ("Truck Repairs & Maintenance", -12000, "maintenance", "the usual P&L line label"),
    ("Repairs and Maintenance", -9000, "maintenance", ""),
    ("Maintenance", -5000, "maintenance", "no maintenance keyword existed at all"),
    ("Permits", -450, "permits", "plural"),
    ("Settlements", -70000, "driver_settlement", "plural"),
    ("Subscriptions", -240, "subscriptions_saas", "plural"),
    ("Plates", -1800, "registration", ""),
    ("Tires", -2400, "maintenance", ""),
    ("Deductibles", -2500, "insurance_deductible", ""),
    ("Claims", -4000, "accident_incident", ""),
    ("Leases", -18900, "lease_rent", ""),
    ("Loans", -6000, "loan_finance", ""),

    # --- revenue, via sign ------------------------------------------------
    ("TRIUMPH FACTORING ADVANCE", 42000, "revenue",
     "inflow from the factor is revenue"),
    ("TRIUMPH FACTORING FEE", -840, "factoring_fees",
     "same counterparty, outflow, is a fee"),
    ("ACH CREDIT LOAD PAYMENT 8821", 3200, "revenue", ""),
    ("BROKER PAYMENT - CH ROBINSON", 5400, "revenue", ""),
    ("DEPOSIT", 18000, "revenue", ""),
    ("WIRE OUT DEPOSIT REF 5521", -18000, "uncategorized",
     "the word deposit on an OUTFLOW must not book as income"),

    # --- sheet/GL labels arrive with no amount ---------------------------
    ("Revenue", None, "revenue", "P&L sheet row, no amount available"),
    ("Gross Revenue", None, "revenue", ""),
    ("Linehaul Revenue", None, "revenue", ""),
    ("SHOP SUPPLIES", -320, "maintenance", "regression: bare 'shop' was tightened too far"),

    # --- owner draw is not an operating expense --------------------------
    ("OWNER DRAW", -15000, "owner_draw", ""),
    ("MEMBER DISTRIBUTION", -20000, "owner_draw", ""),
    ("Owner Draw", -15000, "owner_draw", "sheet label casing"),

    # --- apostrophe variants ---------------------------------------------
    ("LOVE'S TRAVEL STOP #318", -880, "fuel", "apostrophe previously missed"),
    ("LOVES TRAVEL STOP 318", -880, "fuel", ""),
    ("PILOT TRAVEL CTR 442", -1240, "fuel", ""),
    ("FLYING J 618", -910, "fuel", ""),
    ("TA TRAVEL CENTER 042", -1050, "fuel", ""),
    ("TSA PRECHECK ENROLLMENT", -85, "uncategorized",
     "bare \\bts?a\\b previously matched TSA airport charges as fuel"),

    # --- dealer names are service, not capex ------------------------------
    ("FREIGHTLINER OF COLUMBUS INV 8821", -4200, "maintenance",
     "a dealer invoice is a repair far more often than a truck purchase"),
    ("TRUCK PURCHASE - PETERBILT 579", -142000, "capex_truck_trailer",
     "explicit purchase language is what makes it capex"),
    ("DOWN PAYMENT NEW TRAILER", -25000, "capex_truck_trailer", ""),
    ("GREAT DANE TRAILERS", -38000, "capex_truck_trailer", ""),

    # --- ordering neighbours that must not regress ------------------------
    ("INSURANCE DEDUCTIBLE PAID CLAIM 4471", -2500, "insurance_deductible",
     "deductible must beat both accident and insurance_premium"),
    ("PROGRESSIVE INSURANCE PREMIUM", -9800, "insurance_premium", ""),
    ("IFTA Q1 FILING", -3100, "ifta", ""),
    ("FUEL TAX PAYMENT OHIO", -1200, "ifta", "must not fall to fuel"),
    ("SAMSARA SUBSCRIPTION", -450, "subscriptions_saas", ""),
    ("PREPASS TOLL CHARGES", -286, "tolls", ""),
    ("DRIVER PAYROLL 03/15", -72000, "driver_settlement", ""),
]


def main():
    failures = []
    for memo, amount, expected, why in CASES:
        got = categorize(memo, amount)
        if got != expected:
            failures.append((memo, amount, expected, got, why))

    # unit extraction
    unit_cases = [("PILOT FUEL UNIT 214", "214"), ("REPAIR TRUCK #318", "318"),
                  ("TRAILER 4471 TIRES", "4471"), ("NO UNIT HERE", None)]
    for memo, expected in unit_cases:
        got = extract_unit_number(memo)
        if got != expected:
            failures.append((memo, None, expected, got, "extract_unit_number"))

    # confidence signalling
    conf = classify("ZONE LLC", -5000)
    if conf.confidence != "medium":
        failures.append(("ZONE LLC", -5000, "medium confidence", conf.confidence,
                         "entity name with no transfer verb should be flagged"))
    conf2 = classify("WIRE TRANSFER TO ZONE LLC", -5000)
    if conf2.confidence != "high":
        failures.append(("WIRE TRANSFER TO ZONE LLC", -5000, "high confidence",
                         conf2.confidence, "entity + transfer verb is unambiguous"))

    total = len(CASES) + len(unit_cases) + 2
    if failures:
        print(f"FAILED {len(failures)}/{total}\n")
        for memo, amount, expected, got, why in failures:
            amt = f" [{amount:,.2f}]" if isinstance(amount, (int, float)) else ""
            print(f"  {memo!r}{amt}")
            print(f"      expected {expected!r}, got {got!r}")
            if why:
                print(f"      {why}")
        return 1
    print(f"PASSED {total}/{total} taxonomy cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
