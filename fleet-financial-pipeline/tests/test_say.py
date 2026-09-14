"""Controls on reading this project's numbers aloud.

A listener cannot re-read a sentence, so a spoken figure has exactly one chance
to be right. Every test here is a precision bug that was live: truncation, a
lost decimal place, and a crash in the normaliser itself.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import say  # noqa: E402


def spoken(s):
    return say.normalise(s)


@pytest.mark.parametrize("written,expected", [
    ("$0.0003", "zero point zero three cents"),
    ("$0.0070", "zero point seven cents"),
    ("$0.0143", "one point four three cents"),
    ("$0.8657", "eighty-six point five seven cents"),
    ("$0.10", "ten cents"),
])
def test_sub_dollar_amounts_are_cents_with_the_place_kept(written, expected):
    """$0.0003 was read as 'zero point three cents' -- ten times the truth.
    lstrip('0') to shift the decimal point destroys exactly the positional
    information the shift depends on, so this uses Decimal."""
    assert spoken(written) == expected


@pytest.mark.parametrize("written,expected", [
    ("$2.928", "two point nine two eight dollars"),
    ("$1.0725", "one point zero seven two five dollars"),
])
def test_a_rate_keeps_every_decimal(written, expected):
    """Truncating to two decimals read $2.928 a mile as 'two dollars ninety-two'
    -- a different rate, spoken with total confidence. On a 3,000-mile truck
    $1.0725 and $1.07 are eighteen dollars a week apart."""
    assert spoken(written) == expected


def test_money_and_rates_are_said_differently():
    """'two dollars eighty' is a price; 'two point nine two eight dollars' is a
    rate. Saying a rate the first way is not English."""
    assert spoken("$2.80") == "two dollars eighty"
    assert "dollars point" not in spoken("$2.928")


def test_large_amounts_are_words_not_digits():
    assert spoken("$82,801").startswith("eighty-two thousand")
    assert spoken("2,161 miles") == "two thousand one hundred and sixty-one miles"


def test_a_year_is_not_read_as_a_quantity():
    """'2026' is a year, not two thousand and twenty-six of something."""
    assert "2026" in spoken("in 2026 the fleet ran")


def test_percentages_spell_their_decimals():
    assert spoken("4.69%") == "four point six nine percent"
    assert spoken("100%") == "one hundred percent"


def test_the_normaliser_never_raises_on_a_symbol():
    """decimal_number() took the whole regex match, so the percent rule fed it a
    trailing '%' and it crashed on int('%'). A normaliser that raises is worse
    than one that reads a symbol aloud."""
    for s in ("4.69%", "100%", "$-", "% of gross", "1.2.3", "$", "--", "|---|"):
        say.normalise(s)


def test_units_survive_the_slash():
    assert "a mile" in spoken("$2.80/mile")
    assert "a truck week" in spoken("$2,043/truck-week")
    assert "a truck day" in spoken("$292/truck-day")
    assert "a year" in spoken("$163,411/yr")


def test_the_fleets_own_words_are_pronounced():
    """XTRACK is a word, IFTA is not, and AFG is spelled out."""
    out = spoken("XTRACK and AFG filed IFTA")
    assert "Ex-track" in out and "A F G" in out and "IF-ta" in out
    # a word that merely contains them is left alone
    assert "Ex-track" not in spoken("XTRACKING")


def test_markdown_furniture_is_removed():
    """A table border read aloud is a minute of 'pipe dash pipe dash'."""
    table = "| a | b |\n|---|---|\n| 1 | 2 |"
    out = spoken(table)
    assert "|" not in out and "---" not in out
    assert spoken("**bold** and `code`") == "bold and code"
    assert spoken("[the docs](http://x.com)") == "the docs"


def test_negatives_are_spoken_as_minus():
    assert spoken("-$63.09").startswith("minus")
    assert spoken("−$18,926").startswith("minus")   # U+2212, as the sheets use


def test_the_voice_model_is_present_or_says_how_to_get_it():
    try:
        p = say.voice_path(say.DEFAULT_VOICE)
        assert p.exists() and p.stat().st_size > 1_000_000
    except SystemExit as e:
        assert "--install-voice" in str(e)
