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

    # --- ACH INDN: is the account being debited, not a counterparty -------
    ("ADP           DES:PAYROLL   ID:12345 INDN:AFG TRANSPORT CO CO ID:9591",
     -18865.00, "driver_settlement",
     "AFG's own payroll draft; an unanchored entity rule stole $289K of this "
     "into intercompany"),
    ("WIRE TYPE:BOOK IN ORIG:1/AFG TRANSPORT CO. ID:291043084504", 40312.33,
     "intercompany", "inbound wire really is from a sister company"),
    ("ZONE LLC DES:PAYROLL ID:618095317748NHB INDN:,TRUCK MAX USA LLC CO ID:X",
     -4917.21, "intercompany",
     "originator is Zone, before DES: -- still intercompany with INDN stripped"),

    # --- movement that is not spend --------------------------------------
    # These carry no counterparty name at all, which is why they sat in
    # uncategorized as the largest pile in the corpus.
    ("Online Banking transfer to CHK 1558 Confirmation# 5118961291", -60000,
     "internal_transfer", "our own account; not a cost to anyone"),
    ("Online Banking transfer from CHK 0271 Confirmation# 5376792643", 5000,
     "internal_transfer", "inbound leg of the same movement"),
    ("Online transfer to CHK 4504 Confirmation# 12345", -25000,
     "internal_transfer", "second BofA wording for the same thing"),
    ("FUNDS TRANSFER DEBIT", -82576, "internal_transfer",
     "third BofA wording; no counterparty at all"),
    ("Online Banking payment to CRD 2006 Confirmation# 99", -30000,
     "card_payment", "settling the card is not spending; the CHARGES are"),
    ("AMERICAN EXPRESS DES:ACH PMT ID:M9082 INDN:CHERYL CARTER", -409.98,
     "card_payment", "card settlement drafted from the bank"),
    ("MOBILE PAYMENT - THANK YOU", 44398.37, "card_payment",
     "same event seen from the card side"),
    ("AUTOPAY PAYMENT - THANK YOU", 39624.31, "card_payment",
     "autopay variant"),

    # --- the customers this fleet actually hauls for ----------------------
    ("FEDEX SUPPLY CHA DES:5802480 ID:8363462 INDN:ZONE-OH LLC", 13339.94,
     "revenue", "FedEx is the shipper; $4.2M arrived under four ACH names"),
    ("FEDERAL EXPRESS DES:5738489 ID:8322104 INDN:ZONE-OH LLC", 6669.97,
     "revenue", "second FedEx originator name"),
    ("Counter Credit", 7391.41, "revenue", "over-the-counter deposit"),

    # --- counterparties found in the verified statements ------------------
    ("WIRE TYPE:WIRE OUT BNF:STL TRUCKERS LLC ID", -68000, "lease_rent",
     "largest single outflow in the corpus at $4.77M"),
    ("TRANSPORT ENTERP DES:ePay ID:01010L INDN:ZONE-OH", -6195.00, "lease_rent",
     "TEL truck leasing, $700K"),
    ("BOWMAN SALES AND DES:Debits ID:C123", -17566.49, "lease_rent",
     "trailer lessor, $439K"),
    ("WIRE TYPE:WIRE OUT BNF:FLEET ADVANTAGE LLC ID", -421200,
     "capex_truck_trailer",
     "Iron Lease BUYING trucks -- four irregular lump wires out of the leasing "
     "entity, not a repeating monthly rent"),
    ("WIRE TYPE:WIRE OUT BNF:EQUIPLINC LLC ID", -208830, "capex_truck_trailer",
     "same purchase pattern, six irregular lumps"),
    ("WIRE TYPE:WIRE OUT BNF:RITCHIE BROS ID", -5124, "capex_truck_trailer",
     "truck auction house"),
    ("TBK BANK, SSB DES:ACH ID: INDN:IRON LEASE LLC", -14443.50, "loan_finance",
     "$14,443.50 x17 monthly is an amortisation schedule on an owned truck, "
     "not rent"),
    ("WIRE TYPE:WIRE OUT BNF:RIGHT TRUCK DEAL ID", -150000,
     "capex_truck_trailer", "buying trucks, not renting them"),
    ("RELAY PAYMENTS DES:AJ4NTKSURZ ID:XYZ INDN:ZONE", -50000, "fuel",
     "fuel payment rail drafted as a consolidated lump"),
    ("ELECTRONIC FUNDS SOURCE LLC", -22000, "fuel", "EFS fuel rail"),
    ("BT*CAT SCALE COMPANYWALCOTT IA", -14.75, "tolls",
     "scale fees ride the same rail as tolls; 6,818 card charges"),
    ("YOURCOMMINSPMT DES:PURCHASE ID:ZONEOHLLC", -69439.14, "insurance_premium",
     "commercial insurance under an opaque ACH name"),
    ("WIRE TYPE:WIRE OUT BNF:INSUREMART INC ID", -117782, "insurance_premium",
     "insurance broker"),
    ("WIRE TYPE:WIRE OUT BNF:ASSUREDPARTNERS OF NEW JER ID", -54220,
     "insurance_premium", "insurance broker"),
    ("4OHIO-IFTATX DES:ODTIFTATAX ID:123 INDN:SHERKHONKHUJA", -13585,
     "ifta", "state road-tax filing, opaque ACH name"),
    ("NYS DTF HUT DES:TAX PAYMNT", -1600.56, "ifta",
     "New York highway use tax"),
    ("PEDIGREE TECHNOLOGIEFARGO ND", -2861.71, "subscriptions_saas",
     "ELD vendor"),
    ("RETURN ITEM CHARGEBACK", -5246.78, "bank_fees",
     "a returned item is not a second payment"),
    ("Return of Posted Check / Item", -4114.15, "bank_fees",
     "reversal, not spend"),

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

    # --- over-the-road payment rails (Relay Payments) --------------------
    ("LUMPER FEE CHICAGO IL", -150, "lumper_fees", "paid at the dock, not driver pay"),
    ("Lumpers", None, "lumper_fees", "plural sheet label"),
    ("DETENTION PAYMENT", -220, "lumper_fees", ""),
    ("UNLOADING FEE", -180, "lumper_fees", ""),
    ("RELAY PAYMENTS FUEL PURCHASE", -640, "fuel", "rail is not the category — the charge is"),

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
