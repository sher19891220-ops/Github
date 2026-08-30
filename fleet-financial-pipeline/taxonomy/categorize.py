"""
Categorization + unit-tagging rules for transactions.
Edit CATEGORY_RULES and this becomes your company's real taxonomy —
start rough, tighten it as you see how your memos actually read.
"""
import re

# Order matters — first match wins. Keywords are matched case-insensitively.
CATEGORY_RULES = [
    ("insurance_deductible", [r"\bdeductible\b"]),
    ("accident_incident",     [r"\baccident\b", r"\bcrash\b", r"\bcollision\b", r"\bclaim\b"]),
    ("fuel",                   [r"\bfuel\b", r"\bpilot\b", r"\bflying j\b", r"\bloves\b", r"\bts?a\b", r"\bcomdata\b"]),
    ("maintenance",             [r"\brepair\b", r"\bshop\b", r"\btire", r"\bparts?\b", r"\boil change\b",
                                  r"\bpm service\b"]),
    ("insurance_premium",         [r"\binsurance\b", r"\bpremium\b", r"progressive|prime insurance|great west"]),
    ("registration",                [r"\bregistration\b", r"\bplates?\b", r"\btitle fee\b", r"\bapportioned\b"]),
    ("ifta",                          [r"\bifta\b"]),
    ("permits",                         [r"\bpermit\b", r"\boversize\b", r"\bdot number\b"]),
    ("capex_truck_trailer",        [r"\btruck purchase\b", r"\btrailer purchase\b", r"\bdown payment\b",
                                     r"\bfreightliner\b", r"\bpeterbilt\b", r"\bkenworth\b", r"\bvolvo trucks\b",
                                     r"\bwabash\b", r"\bgreat dane\b", r"\butility trailer\b"]),
    ("lease_rent",                  [r"\blease\b", r"\brent\b", r"\bpaccar financial\b", r"\bdaimler\b",
                                      r"\bttl financial\b"]),
    ("loan_finance",                  [r"\bloan\b", r"\bfinance\b", r"\bnote payment\b"]),
    ("driver_settlement",              [r"\bsettlement\b", r"\bpayroll\b", r"\bdriver pay\b"]),
    ("tolls",                            [r"\btoll\b", r"\bprepass\b", r"\bbestpass\b"]),
    ("factoring_fees",                    [r"\btriumph\b", r"\bfactoring\b", r"\badvance fee\b"]),
    ("platform_fees",                      [r"\bdat\b", r"\btruckstop\b", r"\bload board\b", r"\bbroker fee\b",
                                             r"\bplatform fee\b"]),
    ("subscriptions_saas",                  [r"\bsamsara\b", r"\bmotive\b", r"\bkeeptruckin\b", r"\bquickmanage\b",
                                              r"\bquickbooks\b", r"\bsubscription\b"]),
    ("intercompany",                          [r"\bzone llc\b", r"\bxtrack\b", r"\bafg transportco\b",
                                                r"\biron lease\b", r"\btruck max usa\b", r"\bshaeffer\b",
                                                r"\brunstar\b"]),
]

UNIT_NUMBER_PATTERN = re.compile(r"\b(?:unit|truck|trailer|#)\s*[-#]?\s*(\d{2,5})\b", re.IGNORECASE)


def categorize(memo: str) -> str:
    memo_l = (memo or "").lower()
    for category, patterns in CATEGORY_RULES:
        if any(re.search(p, memo_l) for p in patterns):
            return category
    return "uncategorized"


def extract_unit_number(memo: str) -> str | None:
    """Pull a unit number out of a memo string. Returns None if not found —
    those rows fall to entity-level cost, not per-truck cost, until mapped manually."""
    match = UNIT_NUMBER_PATTERN.search(memo or "")
    return match.group(1) if match else None
