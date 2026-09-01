"""
Categorization + unit-tagging rules for transactions.

This is the company's real taxonomy. Every ingest path depends on it, so the
ordering and matching rules below are load-bearing — read the notes before
editing.

THREE THINGS THAT ARE EASY TO GET WRONG
---------------------------------------
1. `intercompany` is evaluated FIRST. Entity names collide with generic
   keywords and lose otherwise: "Iron Lease LLC" literally contains "lease",
   so it categorized as lease_rent and never reached the intercompany matcher,
   leaving an internal transfer in the P&L as a real expense forever.

2. Patterns must match PLURALS. Accounting and P&L line labels are almost
   always plural. `\btoll\b` does not match "Tolls" — the word boundary
   requires a non-word character after "toll", and "s" is a word character.
   Every rule here is written with explicit plural handling and the test suite
   asserts both forms.

3. Sign disambiguates revenue from expense. Money arriving from Triumph is a
   factoring advance (revenue); money leaving to Triumph is a fee. Pass
   `amount` and the classifier can tell them apart. Without it, a trucking
   company's entire revenue line categorizes as factoring fees.

Rule order is first-match-wins. Adding a rule near the top can silently steal
matches from every rule below it — run the tests after any edit:
    python tests/test_categorize.py
"""
import re
from collections import namedtuple

Classification = namedtuple("Classification", "category confidence rule")

# ---------------------------------------------------------------------------
# Intercompany — evaluated before everything else
# ---------------------------------------------------------------------------

# Each entity as it appears in a bank memo. Kept specific enough not to catch
# an unrelated third party: "Zone LLC" requires the LLC so it will not match a
# customer called "Zone Logistics Inc".
# A related party that is NOT in the declared entity list and is paid by
# INTERNATIONAL wire. It shares the ZONEOH name with Zone OH LLC and lines up
# with the "Salaries uzbekistan" line in the weekly P&L panel, so it is almost
# certainly the offshore back office -- but "almost certainly" is not a basis
# for folding $965,204 into intercompany, where it would vanish into a
# $32M pile that nets to zero. It gets its own category so it stays visible
# until someone confirms what it is.
RELATED_PARTY_REVIEW_PATTERNS = [
    r"\bzoneoh\s+freight\s+insights\b",
    r"\bzone\s*oh\s+freight\b",
]

INTERCOMPANY_PATTERNS = [
    r"\bzone\s+llc\b",
    r"\bxtrack\b",
    r"\bafg\s+transportco\b",
    # Inbound wires name the sender as ORIG:, not BNF:. Anchored to those two
    # fields ON PURPOSE: an ACH memo also carries INDN:, the name of the
    # account being debited, so a bare entity-name rule turns AFG's OWN ADP
    # payroll draft ("ADP DES:PAYROLL ... INDN:AFG TRANSPORT CO") into an
    # intercompany transfer. That regression moved $289,000 out of
    # driver_settlement before this anchor was added.
    r"(?:BNF|ORIG):(?:\d/)?\s*afg\s+transport\s+co\b",
    r"\biron\s+lease\b",
    r"\btruck\s+max\s+usa\b",
    r"\bshaeffer\b",
    r"\brunstar\b",
]

# An entity name plus one of these is unambiguously a transfer between our own
# companies. An entity name alone is still intercompany, but flagged medium
# confidence — it could be a third party paying a policy or invoice that merely
# carries our entity name in the reference line.
TRANSFER_TOKENS = r"(transfer|xfer|wire|ach|funding|fund|intercompany|inter-?co\b|repay|reimb|advance|loan|capital|contribution|due\s+to|due\s+from)"

# ---------------------------------------------------------------------------
# Movement that is NOT spend — evaluated before the expense rules
# ---------------------------------------------------------------------------

# Money moving between accounts WE hold. Not a cost to anyone: it nets to zero
# across the group and, left uncategorized, it is the single largest pile in
# the corpus and outranks every real leak. BofA writes these as CHK-to-CHK or
# CHK-to-SAV movements with no counterparty name at all, which is exactly why
# they never matched an entity-name rule.
INTERNAL_TRANSFER_PATTERNS = [
    r"\bonline\s+(banking\s+)?transfer\s+(to|from)\s+(chk|sav|checking|savings)\b",
    r"\btransfer\s+(to|from)\s+chk\s*\d{4}\b",
    r"\bfunds\s+transfer\s+(debit|credit)\b",
    r"\bbkofamerica\s+bc\b",
]

# Paying the credit card is not spending money — the CHARGES on that card are
# the spend, and they are already ingested from the card export. Count both and
# every dollar on the card is booked twice: once where it was spent, once again
# as a lump payment to AmEx. This is the single most dangerous double-count in
# a dual-source model, because both numbers are individually correct.
CARD_PAYMENT_PATTERNS = [
    r"\b(online|mobile)\s+banking\s+payment\s+to\s+crd\b",
    r"\bamerican\s+express\s+des:\s*(ach\s+pmt|retry\s+pymt)\b",
    r"\b(mobile|autopay)\s+payment\s*-?\s*thank\s+you\b",
    r"\bpayment\s+thank\s+you\b",
]

# ---------------------------------------------------------------------------
# Revenue — only considered on inflows
# ---------------------------------------------------------------------------

# How money actually arrives at a trucking company: factoring advances, direct
# broker/shipper payments, and load settlements.
REVENUE_PATTERNS = [
    r"\bfactoring\s+advance\b", r"\bfunding\s+advance\b", r"\bpurchase\s+of\s+invoice\b",
    r"\btriumph\b", r"\brts\s+financial\b", r"\bapex\s+capital\b", r"\bota\s+franchise\b",
    r"\bload\s+payments?\b", r"\bfreight\s+payments?\b", r"\bbroker\s+payments?\b",
    r"\binvoice\s+payments?\b", r"\bcustomer\s+payments?\b", r"\bremittance\b",
    r"\bach\s+credit\b", r"\bincoming\s+wire\b", r"\bdeposit\b",
    # The customers this fleet actually hauls for. FedEx arrives under four
    # different ACH originator names for what is one shipper relationship;
    # without all four, $4.2M of revenue reads as unexplained inflow.
    r"\bfedex\b", r"\bfederal\s+express\b", r"\bfedex\s+supply\s+cha\b",
    r"\bfedex\s+office\b", r"\bfedex\s+corporatio\b",
    r"\bcounter\s+credit\b",
]

# ---------------------------------------------------------------------------
# Main rules. First match wins, so order matters.
# ---------------------------------------------------------------------------
CATEGORY_RULES = [
    # Deductible before accident, and both before insurance_premium, so a
    # deductible payment is not swallowed by the generic word "insurance".
    ("insurance_deductible", [r"\bdeductibles?\b"]),
    ("accident_incident",    [r"\baccidents?\b", r"\bcrash(es)?\b", r"\bcollisions?\b",
                              r"\bclaims?\b", r"\bbody\s+shop\b", r"\btow(ing)?\b",
                              r"\bwreck(er)?\b"]),

    # Not an operating expense. Kept out of the P&L expense lines entirely.
    ("owner_draw",           [r"\bowners?\s+draws?\b", r"\bowner\s+distribution\b",
                              r"\bmember\s+draws?\b", r"\bmember\s+distributions?\b",
                              r"\bshareholder\s+distributions?\b", r"\bdistributions?\b",
                              r"\bowner\s+withdrawal\b"]),

    # Capex before fuel/maintenance: dealer names live in the maintenance rule,
    # and "TRUCK PURCHASE - PETERBILT 579" would otherwise book a $142k tractor
    # as a repair. Explicit purchase language is what makes it capex — a brand
    # name alone stays maintenance, because most dealer charges are service.
    ("capex_truck_trailer",  [r"\btrucks?\s+purchases?\b", r"\btrailers?\s+purchases?\b",
                              r"\bequipment\s+purchases?\b", r"\bvehicles?\s+purchases?\b",
                              r"\bdown\s*payments?\b", r"\bpurchase\s+of\s+(truck|trailer|tractor)\b",
                              r"\bwabash\b", r"\bgreat\s+dane\b", r"\butility\s+trailers?\b",
                              r"\bhyundai\s+translead\b",
                              r"\bright\s+truck\s+deal\b",
                              # Iron Lease BUYS trucks from these and places them
                              # with drivers on lease-purchase. Their payment
                              # shape says asset, not rent: four and six
                              # irregular lump wires ($100,400 / $421,200 /
                              # $81,800 / $208,000) out of the leasing entity,
                              # alongside a truck auction house. A rental would
                              # be a repeating amount on a monthly cycle.
                              r"\bfleet\s+advantage\b", r"\bequiplinc\b",
                              r"\britchie\s+bros\b"]),

    # IFTA before fuel: "FUEL TAX PAYMENT" is a quarterly tax filing, not diesel.
    ("ifta",                 [r"\bifta\b", r"\bfuel\s+tax(es)?\b", r"\bmileage\s+tax\b",
                              # State road-tax filings arrive as opaque ACH names.
                              r"ifta\s*tax", r"ohio-?ifta", r"oh-?iftatx", r"ohiftatx", r"\bnys\s+dtf\s+hut\b",
                              r"\bhighway\s+use\s+tax\b", r"\bstate\s+of\s+ct\s+drs\b",
                              r"\bky\s+weight\s+distance\b", r"\bnm\s+trip\b"]),

    ("fuel",                 [r"\bfuels?\b", r"\bdiesel\b", r"\bgasoline\b", r"\bdef\b",
                              r"\bpilot\b", r"\bflying\s*j\b", r"\blove'?s\b",
                              # TA/Petro travel centers. NOT a bare \bts?a\b — that
                              # also matched TSA airport charges as fuel.
                              r"\bta\s+travel\b", r"\bta\s*#\s*\d", r"\btravelcenters\b",
                              r"\bpetro\s+(stopping|travel)\b",
                              r"\bcomdata\b", r"\befs\s+llc\b", r"\bwex\s+(fuel|inc)\b",
                              r"\bspeedway\b", r"\bsapp\s+bros\b", r"\broadys\b",
                              # Payment RAILS, not merchants. The rail is never the
                              # category by itself, but on this fleet Relay and EFS
                              # carry fuel and are drafted as consolidated lumps.
                              r"\brelay\s+payments?\b",
                              r"\belectronic\s+funds\s+source\b"]),

    ("maintenance",          [r"\brepairs?\b", r"\bmaintenance\b", r"\bmainten\b",
                              r"\bpreventive\s+maint\w*\b", r"\bpm\s+service\b",
                              r"\btires?\b", r"\bretread\b", r"\bparts?\b",
                              r"\boil\s+changes?\b", r"\blube\b", r"\bbrakes?\b",
                              r"\balignment\b", r"\bdiagnostics?\b", r"\bdot\s+inspections?\b",
                              r"\bshops?\b", r"\bshop\s+supplies\b", r"\bgarage\b",
                              # Dealer names are SERVICE far more often than a purchase.
                              # Capex requires explicit purchase language below.
                              r"\bfreightliner\b", r"\bpeterbilt\b", r"\bkenworth\b",
                              r"\bvolvo\s+truck\b", r"\bmack\s+truck\b", r"\btruck\s+center\b",
                              r"\bcit\s+trucks\b", r"\btranschicago\b",
                              r"\bfleetpride\b", r"\bbf\s+tire\b", r"\btcs\s+truck\b"]),

    ("insurance_premium",    [r"\binsurances?\b", r"\bpremiums?\b", r"\bprogressive\b",
                              r"\bprime\s+insurance\b", r"\bgreat\s+west\b", r"\bnorthland\b",
                              r"\bcanal\s+insurance\b", r"\bbaldwin\s+&?\s*lyons\b",
                              r"\byourcomminspmt\b", r"\binsuremart\b",
                              r"\bassuredpartners\b", r"\bsafe\s+route\s+risk\b",
                              r"\boccupational\s+accident\b"]),

    ("registration",         [r"\bregistrations?\b", r"\bplates?\b", r"\btitle\s+fees?\b",
                              r"\bapportioned\b", r"\birp\b", r"\bbmv\b", r"\bdmv\b",
                              r"\bucr\b", r"\bheavy\s+(vehicle\s+)?use\s+tax\b", r"\b2290\b"]),

    ("permits",              [r"\bpermits?\b", r"\boversize\b", r"\boverweight\b",
                              r"\btrip\s+permits?\b", r"\bdot\s+numbers?\b", r"\bmc\s+number\b"]),

    ("lease_rent",           [r"\bleases?\b", r"\bleasing\b", r"\brentals?\b", r"\brent\b",
                              r"\bpaccar\s+financial\b", r"\bdaimler\s+truck\s+financial\b",
                              r"\bttl\s+financial\b", r"\bryder\b", r"\bpenske\b",
                              r"\bstl\s+truckers?\b", r"\btransport\s+enterp\w*\b",
                              r"\bbowman\s+sales\b", r"\bten\s+leasing\b",
                              r"\btel\s+leasing\b"]),

    # Equipment finance on trucks the group OWNS. $14,443.50 seventeen times
    # on a monthly cycle is an amortisation schedule; the truck is an asset and
    # this is debt service on it, not rent for someone else's equipment.
    ("loan_finance",         [r"\btbk\s+bank\b",
                              r"\bloans?\b", r"\bfinanc(e|ing)\b", r"\bnote\s+payments?\b",
                              r"\binterest\s+(charge|payment|expense)\b", r"\bprincipal\s+payment\b"]),

    ("driver_settlement",    [r"\bsettlements?\b", r"\bpayrolls?\b", r"\bdrivers?\s+pay\b",
                              r"\bdrivers?\s+settlements?\b", r"\bwages?\b", r"\bper\s+diem\b",
                              r"\bescrow\b", r"\bgusto\b", r"\badp\b"]),

    # Loading/unloading fees paid at the dock, usually through a payment rail
    # (Relay Payments) rather than a card. Distinct from driver pay and from
    # platform fees — it is a cost of the load, not of the driver or the board.
    ("lumper_fees",          [r"\blumpers?\b", r"\blumper\s+fees?\b",
                              r"\bunload(ing)?\s+fees?\b", r"\bdetention\b"]),

    ("tolls",                [r"\btolls?\b", r"\bprepass\b", r"\bbestpass\b",
                              r"\bez\s*-?\s*pass\b", r"\bi\s*-?\s*pass\b", r"\btoll\s*tags?\b",
                              r"\bturnpike\b", r"\bpike\s+pass\b",
                              r"\bcat\s+scale\b", r"\bscale\s+fees?\b"]),

    ("factoring_fees",       [r"\bfactoring\s+fees?\b", r"\bfactoring\b", r"\badvance\s+fees?\b",
                              r"\btriumph\b", r"\brts\s+financial\b", r"\bapex\s+capital\b"]),

    ("platform_fees",        [r"\bload\s*boards?\b", r"\bbrokers?\s+fees?\b",
                              r"\bplatform\s+fees?\b", r"\btruckstop\b", r"\bdat\b",
                              r"\b123loadboard\b", r"\bamazon\s+relay\b", r"\buber\s+freight\b"]),

    ("subscriptions_saas",   [r"\bsubscriptions?\b", r"\bsamsara\b", r"\bmotive\b",
                              r"\bkeeptruckin\b", r"\bquickmanage\b", r"\bquickbooks\b",
                              r"\bintuit\b", r"\beld\b", r"\bgreen\s*light\b", r"\bsoftware\b",
                              r"\bpedigree\s+technolog\w*\b", r"\btrippak\b", r"\bvzwrlss\b",
                              r"\bbestpass\b", r"\bverizon\b", r"\bmicrosoft\b"]),

    # Bank's own charges and reversals. Small individually, and a returned item
    # is not a payment: counting the original and the return as two outflows
    # doubles a bounced charge.
    ("bank_fees",            [r"\breturn\s+item\s+chargeback\b",
                              r"\breturn\s+of\s+posted\s+check\b",
                              r"\badjustment/correction\b",
                              r"\bwire\s+transfer\s+fees?\b", r"\boverdraft\b",
                              r"\bmonthly\s+fee\b", r"\bservice\s+charge\b",
                              r"\bnsf\b", r"\breturned\s+item\b"]),
]

UNIT_NUMBER_PATTERN = re.compile(r"\b(?:unit|truck|trailer|tractor|#)\s*[-#]?\s*(\d{2,5})\b",
                                 re.IGNORECASE)

_COMPILED = [(cat, [re.compile(p, re.IGNORECASE) for p in pats]) for cat, pats in CATEGORY_RULES]
_INTERCOMPANY = [re.compile(p, re.IGNORECASE) for p in INTERCOMPANY_PATTERNS]
_TRANSFER = re.compile(TRANSFER_TOKENS, re.IGNORECASE)
_REVENUE = [re.compile(p, re.IGNORECASE) for p in REVENUE_PATTERNS]
_INTERNAL = [re.compile(p, re.IGNORECASE) for p in INTERNAL_TRANSFER_PATTERNS]
_CARD_PAYMENT = [re.compile(p, re.IGNORECASE) for p in CARD_PAYMENT_PATTERNS]
# Unambiguous third-party vendors that carry one of our entity names in the
# ACH INDN: field -- which names the account being DEBITED, us, not the party
# being paid. Checked BEFORE intercompany, because "TBK BANK, SSB DES:ACH
# INDN:IRON LEASE LLC" is Iron Lease paying its truck loan, not a transfer
# between our companies. Kept as an explicit short list rather than stripping
# INDN wholesale: a blunt strip also removed the originator name from genuine
# intercompany ACH and moved $29M into the wrong buckets.
NAMED_VENDOR_PATTERNS = [
    (r"\btbk\s+bank\b", "loan_finance"),
    (r"\bfleet\s+advantage\b", "capex_truck_trailer"),
    (r"\bequiplinc\b", "capex_truck_trailer"),
    (r"\britchie\s+bros\b", "capex_truck_trailer"),
]

_RELATED_REVIEW = [re.compile(p, re.IGNORECASE) for p in RELATED_PARTY_REVIEW_PATTERNS]
_NAMED_VENDORS = [(re.compile(p, re.IGNORECASE), c) for p, c in NAMED_VENDOR_PATTERNS]




def classify(memo: str, amount: float | None = None) -> Classification:
    """Categorize a memo, optionally using the amount's sign.

    Returns (category, confidence, rule). `confidence` is 'high' unless the
    match is one that deserves a human look:
      - intercompany matched on an entity name with no transfer verb
      - a revenue-shaped inflow that could also be a refund
    Ingest writes medium-confidence rows to review_flag rather than trusting
    them silently.
    """
    memo = memo or ""

    # 0. A related party we cannot yet classify. Before intercompany so it
    #    cannot be absorbed into a pile that nets to zero.
    for pat in _RELATED_REVIEW:
        if pat.search(memo):
            return Classification("related_party_review", "medium", pat.pattern)

    # 0b. Named third-party vendors whose ACH memo carries one of our entity
    #     names in INDN:. Without this they read as intercompany.
    for pat, cat in _NAMED_VENDORS:
        if pat.search(memo):
            return Classification(cat, "high", pat.pattern)

    # 1. Intercompany, before anything else.
    for pat in _INTERCOMPANY:
        if pat.search(memo):
            if _TRANSFER.search(memo):
                return Classification("intercompany", "high", pat.pattern)
            return Classification("intercompany", "medium", pat.pattern)

    # 1b. Movement that is not spend. After intercompany, because a wire whose
    #     beneficiary is one of our own companies is intercompany and should be
    #     named as such; these two catch the movements that carry NO
    #     counterparty at all and so could never match an entity rule.
    for pat in _CARD_PAYMENT:
        if pat.search(memo):
            return Classification("card_payment", "high", pat.pattern)
    for pat in _INTERNAL:
        if pat.search(memo):
            return Classification("internal_transfer", "high", pat.pattern)

    # 2a. Wording that can only mean revenue classifies regardless of sign.
    #     P&L sheet rows and GL account names arrive with no amount at all, so
    #     a sign-gated rule alone would leave every "Revenue" line uncategorized.
    if _explicitly_revenue(memo):
        return Classification("revenue", "high", "explicit_revenue")

    # 2b. Ambiguous revenue wording needs a positive amount. "DEPOSIT" on an
    #     outgoing wire is not income, and money moving TO the factor is a fee,
    #     not an advance — same counterparty, opposite direction.
    if amount is not None and amount > 0:
        for pat in _REVENUE:
            if pat.search(memo):
                return Classification("revenue", "medium", pat.pattern)

    # 3. Everything else.
    for category, pats in _COMPILED:
        for pat in pats:
            if pat.search(memo):
                return Classification(category, "high", pat.pattern)

    return Classification("uncategorized", "high", None)


# Wording that cannot mean anything but income, usable without an amount.
_EXPLICIT_REVENUE = re.compile(
    r"\b(factoring\s+advances?|funding\s+advances?|load\s+payments?|freight\s+payments?|"
    r"broker\s+payments?|remittances?|purchase\s+of\s+invoice|gross\s+revenues?|"
    r"revenues?|gross\s+receipts?|line\s*haul|linehaul|sales\s+income)\b",
    re.IGNORECASE)


def _explicitly_revenue(memo):
    return bool(_EXPLICIT_REVENUE.search(memo or ""))


def categorize(memo: str, amount: float | None = None) -> str:
    """Category name only. Pass `amount` wherever it is available — without it
    inflows cannot be distinguished from outflows and revenue is unreachable."""
    return classify(memo, amount).category


def extract_unit_number(memo: str) -> str | None:
    """Pull a unit number out of a memo string. Returns None if not found —
    those rows fall to entity-level cost, not per-truck cost, until mapped
    manually."""
    match = UNIT_NUMBER_PATTERN.search(memo or "")
    return match.group(1) if match else None
