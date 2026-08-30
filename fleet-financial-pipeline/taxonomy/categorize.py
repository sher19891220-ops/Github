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
INTERCOMPANY_PATTERNS = [
    r"\bzone\s+llc\b",
    r"\bxtrack\b",
    r"\bafg\s+transportco\b",
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
                              r"\bhyundai\s+translead\b"]),

    # IFTA before fuel: "FUEL TAX PAYMENT" is a quarterly tax filing, not diesel.
    ("ifta",                 [r"\bifta\b", r"\bfuel\s+tax(es)?\b", r"\bmileage\s+tax\b"]),

    ("fuel",                 [r"\bfuels?\b", r"\bdiesel\b", r"\bgasoline\b", r"\bdef\b",
                              r"\bpilot\b", r"\bflying\s*j\b", r"\blove'?s\b",
                              # TA/Petro travel centers. NOT a bare \bts?a\b — that
                              # also matched TSA airport charges as fuel.
                              r"\bta\s+travel\b", r"\bta\s*#\s*\d", r"\btravelcenters\b",
                              r"\bpetro\s+(stopping|travel)\b",
                              r"\bcomdata\b", r"\befs\s+llc\b", r"\bwex\s+(fuel|inc)\b",
                              r"\bspeedway\b", r"\bsapp\s+bros\b", r"\broadys\b"]),

    ("maintenance",          [r"\brepairs?\b", r"\bmaintenance\b", r"\bmainten\b",
                              r"\bpreventive\s+maint\w*\b", r"\bpm\s+service\b",
                              r"\btires?\b", r"\bretread\b", r"\bparts?\b",
                              r"\boil\s+changes?\b", r"\blube\b", r"\bbrakes?\b",
                              r"\balignment\b", r"\bdiagnostics?\b", r"\bdot\s+inspections?\b",
                              r"\bshops?\b", r"\bshop\s+supplies\b", r"\bgarage\b",
                              # Dealer names are SERVICE far more often than a purchase.
                              # Capex requires explicit purchase language below.
                              r"\bfreightliner\b", r"\bpeterbilt\b", r"\bkenworth\b",
                              r"\bvolvo\s+truck\b", r"\bmack\s+truck\b", r"\btruck\s+center\b"]),

    ("insurance_premium",    [r"\binsurances?\b", r"\bpremiums?\b", r"\bprogressive\b",
                              r"\bprime\s+insurance\b", r"\bgreat\s+west\b", r"\bnorthland\b",
                              r"\bcanal\s+insurance\b", r"\bbaldwin\s+&?\s*lyons\b"]),

    ("registration",         [r"\bregistrations?\b", r"\bplates?\b", r"\btitle\s+fees?\b",
                              r"\bapportioned\b", r"\birp\b", r"\bbmv\b", r"\bdmv\b",
                              r"\bucr\b", r"\bheavy\s+(vehicle\s+)?use\s+tax\b", r"\b2290\b"]),

    ("permits",              [r"\bpermits?\b", r"\boversize\b", r"\boverweight\b",
                              r"\btrip\s+permits?\b", r"\bdot\s+numbers?\b", r"\bmc\s+number\b"]),

    ("lease_rent",           [r"\bleases?\b", r"\bleasing\b", r"\brentals?\b", r"\brent\b",
                              r"\bpaccar\s+financial\b", r"\bdaimler\s+truck\s+financial\b",
                              r"\bttl\s+financial\b", r"\bryder\b", r"\bpenske\b"]),

    ("loan_finance",         [r"\bloans?\b", r"\bfinanc(e|ing)\b", r"\bnote\s+payments?\b",
                              r"\binterest\s+(charge|payment|expense)\b", r"\bprincipal\s+payment\b"]),

    ("driver_settlement",    [r"\bsettlements?\b", r"\bpayrolls?\b", r"\bdrivers?\s+pay\b",
                              r"\bdrivers?\s+settlements?\b", r"\bwages?\b", r"\bper\s+diem\b",
                              r"\bescrow\b", r"\bgusto\b", r"\badp\b"]),

    ("tolls",                [r"\btolls?\b", r"\bprepass\b", r"\bbestpass\b",
                              r"\bez\s*-?\s*pass\b", r"\bi\s*-?\s*pass\b", r"\btoll\s*tags?\b",
                              r"\bturnpike\b", r"\bpike\s+pass\b"]),

    ("factoring_fees",       [r"\bfactoring\s+fees?\b", r"\bfactoring\b", r"\badvance\s+fees?\b",
                              r"\btriumph\b", r"\brts\s+financial\b", r"\bapex\s+capital\b"]),

    ("platform_fees",        [r"\bload\s*boards?\b", r"\bbrokers?\s+fees?\b",
                              r"\bplatform\s+fees?\b", r"\btruckstop\b", r"\bdat\b",
                              r"\b123loadboard\b", r"\bamazon\s+relay\b", r"\buber\s+freight\b"]),

    ("subscriptions_saas",   [r"\bsubscriptions?\b", r"\bsamsara\b", r"\bmotive\b",
                              r"\bkeeptruckin\b", r"\bquickmanage\b", r"\bquickbooks\b",
                              r"\bintuit\b", r"\beld\b", r"\bgreen\s*light\b", r"\bsoftware\b"]),
]

UNIT_NUMBER_PATTERN = re.compile(r"\b(?:unit|truck|trailer|tractor|#)\s*[-#]?\s*(\d{2,5})\b",
                                 re.IGNORECASE)

_COMPILED = [(cat, [re.compile(p, re.IGNORECASE) for p in pats]) for cat, pats in CATEGORY_RULES]
_INTERCOMPANY = [re.compile(p, re.IGNORECASE) for p in INTERCOMPANY_PATTERNS]
_TRANSFER = re.compile(TRANSFER_TOKENS, re.IGNORECASE)
_REVENUE = [re.compile(p, re.IGNORECASE) for p in REVENUE_PATTERNS]


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

    # 1. Intercompany, before anything else.
    for pat in _INTERCOMPANY:
        if pat.search(memo):
            if _TRANSFER.search(memo):
                return Classification("intercompany", "high", pat.pattern)
            return Classification("intercompany", "medium", pat.pattern)

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
