"""Read text aloud in a neural voice. The work is the NORMALISATION, not the audio.

Piper turns text into speech well. What it cannot do is know that "$0.8657/mile"
should be spoken "eighty-six point five seven cents a mile", that "XTRACK" is a
word and "IFTA" is spelled out, or that a markdown table is a table. Feed this
project's output to any synthesiser raw and you get:

    "dollar two comma three nine one"           for  $2,391
    "eks tee arr ay cee kay"                    for  XTRACK
    "pipe dash dash dash pipe"                  for  a table border

So this module is mostly a normaliser with a synthesiser bolted on the end.

WHY OFFLINE. The text being read is the group's own financial position -- rates,
margins, break-even, what the sheets get wrong. Sending that to a cloud voice API
would put it on somebody else's server for the sake of a nicer accent. Piper runs
entirely in this container.

NUMBERS ARE THE WHOLE GAME IN A FINANCE READ-ALOUD. A listener cannot re-read a
sentence, so "$1,166" must land as "one thousand one hundred and sixty six
dollars" the first time. Money, rates, percentages and per-mile figures each get
their own rule, because "2.80" is "two dollars eighty" as a rate and "two point
eight" as a ratio and the difference matters.
"""
import argparse
import html
import re
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOICE_DIR = Path("/opt/piper-voices")
DEFAULT_VOICE = "en_US-lessac-medium"
# Words this project uses constantly that a synthesiser mispronounces. Spelled
# out where they are initialisms, respelled where they are words.
SAY_AS = {
    "XTRACK": "Ex-track", "AFG": "A F G", "ZONE-OH": "Zone O H",
    "IFTA": "IF-ta", "HVUT": "H V U T", "IRP": "I R P", "P&L": "P and L",
    "RPM": "R P M", "OO": "owner operator", "CD": "company driver",
    "VIN": "vin", "MPG": "miles per gallon", "mpg": "miles per gallon",
    "OCR": "O C R", "API": "A P I", "CSV": "C S V", "PDF": "P D F",
    "ODOT": "O DOT", "MCTD": "M C T D", "ADP": "A D P", "STL": "S T L",
    "TIV": "T I V", "NTL": "N T L", "PD": "P D", "GVW": "G V W",
    "YTD": "year to date", "Q1": "quarter one", "Q2": "quarter two",
    "Q3": "quarter three", "Q4": "quarter four",
}


def spell_number(n):
    """A number as words. Written out because a listener cannot re-read it."""
    ones = ("zero one two three four five six seven eight nine ten eleven twelve "
            "thirteen fourteen fifteen sixteen seventeen eighteen nineteen").split()
    tens = ("_ _ twenty thirty forty fifty sixty seventy eighty ninety").split()
    n = int(n)
    if n < 0:
        return "minus " + spell_number(-n)
    if n < 20:
        return ones[n]
    if n < 100:
        return tens[n // 10] + ("" if n % 10 == 0 else "-" + ones[n % 10])
    if n < 1000:
        rest = n % 100
        return ones[n // 100] + " hundred" + (" and " + spell_number(rest) if rest else "")
    for size, name in ((1_000_000_000, "billion"), (1_000_000, "million"), (1000, "thousand")):
        if n >= size:
            rest = n % size
            return (spell_number(n // size) + " " + name
                    + (" " + spell_number(rest) if rest else ""))
    return str(n)


def say_decimal(frac):
    """'8657' -> 'eight six five seven'. Digit by digit, deliberately.

    'point eight six five seven' as a number word is worse: a listener tracking
    a rate wants the digits, and 'eight thousand six hundred and fifty seven'
    after a decimal point is nonsense.
    """
    ones = "zero one two three four five six seven eight nine".split()
    return " ".join(ones[int(d)] for d in frac)


def money(m):
    """$1,166 -> 'one thousand one hundred and sixty six dollars'.

    NEVER TRUNCATES. An earlier version cut to two decimals, so $2.928 a mile
    was read as 'two dollars ninety-two' -- a different rate, spoken with total
    confidence. Precision is the whole point of these figures: $1.0725 and
    $1.07 are eighteen dollars a week apart on a 3,000-mile truck.

    Sub-dollar amounts become CENTS, because 'zero point eight six five seven'
    loses the unit that decides whether a truck makes money.
    """
    raw = m.group(1).replace(",", "")
    neg = m.group(0).lstrip().startswith("-") or m.group(0).startswith("\u2212")
    sign = "minus " if neg else ""
    val = Decimal(raw)

    if val < 1 and val != 0:
        # Decimal, not string surgery. An earlier version stripped leading zeros
        # to shift the point and so read $0.0003 as "zero point three cents" --
        # ten times the real 0.03 cents. lstrip("0") destroys exactly the
        # positional information the shift depends on.
        cents = (val * 100).normalize()
        whole, _, frac = f"{cents:f}".partition(".")
        frac = frac.rstrip("0")
        said = spell_number(whole or "0")
        said += f" point {say_decimal(frac)}" if frac else ""
        return f"{sign}{said} cent" + ("" if said == "one" else "s")

    whole, _, frac = raw.partition(".")
    frac = frac.rstrip("0")
    if len(frac) > 2:
        # A RATE, not a price. "two point nine two eight dollars a mile" is how
        # somebody says it; "two dollars point nine two eight" is not English.
        return (sign + spell_number(whole) + " point " + say_decimal(frac)
                + " dollars")
    said = spell_number(whole) + " dollar" + ("" if whole == "1" else "s")
    if frac:
        said += " " + spell_number(frac.ljust(2, "0"))
    return sign + said


def decimal_number(m):
    """A bare decimal: '4.69' -> 'four point six nine'.

    Takes the DIGITS out of the match rather than the whole match: the percent
    rule's match carries a trailing '%', and feeding that to the digit reader
    crashed on int('%'). A normaliser that raises is worse than one that reads
    a symbol aloud.
    """
    digits = re.search(r"\d[\d,]*(?:\.\d+)?", m.group(0))
    if not digits:
        return m.group(0)
    whole, _, frac = digits.group(0).replace(",", "").partition(".")
    said = spell_number(whole)
    frac = frac.rstrip("0")
    return said + (" point " + say_decimal(frac) if frac else "")


def normalise(text):
    """Everything between the written page and a sentence somebody can follow."""
    t = html.unescape(text)
    # Markdown furniture. A table border read aloud is a minute of "pipe dash".
    t = re.sub(r"^\s*\|[-:\s|]+\|\s*$", "", t, flags=re.M)      # table rules
    t = re.sub(r"^\s*[-*]{3,}\s*$", "", t, flags=re.M)          # horizontal rules
    t = re.sub(r"^\s*#+\s*", "", t, flags=re.M)                 # headings
    t = t.replace("|", ", ")                                     # table cells
    t = re.sub(r"[*_`]{1,3}", "", t)                             # emphasis, code
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)               # links -> the words
    t = t.replace("→", " to ").replace("—", ", ").replace("–", ", ")
    t = t.replace("−", "-")                                      # U+2212
    t = re.sub(r"\.{3,}", ".", t)

    # Units before money, so "$2.80/mile" keeps its unit.
    t = re.sub(r"/\s*(loaded\s+)?mile\b", r" a \1mile", t)
    t = re.sub(r"/\s*truck-week\b", " a truck week", t)
    t = re.sub(r"/\s*truck-day\b", " a truck day", t)
    t = re.sub(r"/\s*(wk|week)\b", " a week", t)
    t = re.sub(r"/\s*(yr|year)\b", " a year", t)
    t = re.sub(r"/\s*gal\b", " a gallon", t)
    t = re.sub(r"\bper\s+truck-week\b", "per truck week", t)

    t = re.sub(r"[-−]?\$\s*([\d,]+(?:\.\d+)?)", money, t)
    t = re.sub(r"(\d+\.\d+)\s*%", lambda m: decimal_number(m) + " percent", t)
    t = re.sub(r"(\d+)\s*%", lambda m: spell_number(m.group(1)) + " percent", t)
    # Any remaining bare decimal -- an mpg, a ratio, a rate without a symbol.
    t = re.sub(r"(?<![\w.$-])\d{1,7}\.\d+(?![\w.])", decimal_number, t)

    # Bare integers, so "2,161 miles" is not read digit by digit. Left alone
    # inside anything that looks like a date, a year or an identifier.
    def bare(m):
        s = m.group(0)
        if re.fullmatch(r"(19|20)\d{2}", s):
            return s
        return spell_number(s.replace(",", ""))
    t = re.sub(r"(?<![\w.$-])\d{1,3}(?:,\d{3})+(?![\w.])", bare, t)

    for k, v in sorted(SAY_AS.items(), key=lambda kv: -len(kv[0])):
        t = re.sub(rf"(?<![A-Za-z]){re.escape(k)}(?![A-Za-z])", v, t)

    t = re.sub(r"[ \t]+", " ", t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def voice_path(name):
    for d in (VOICE_DIR, ROOT / "tools/voices", Path.home() / ".local/share/piper"):
        p = Path(d) / f"{name}.onnx"
        if p.exists():
            return p
    raise SystemExit(
        f"Voice '{name}' not found. Install it with:\n"
        f"  python3 tools/say.py --install-voice {name}")


def install_voice(name):
    """Fetch a Piper voice. ~63 MB, and it stays outside the repo."""
    base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US"
    short = name.replace("en_US-", "").split("-")
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    for suffix in ("", ".json"):
        url = f"{base}/{short[0]}/{short[1]}/{name}.onnx{suffix}"
        dest = VOICE_DIR / f"{name}.onnx{suffix}"
        subprocess.run(["curl", "-sSL", "-o", str(dest), url], check=True)
        if dest.stat().st_size < 1000:
            raise SystemExit(f"Download failed for {url}")
        print(f"  {dest.name}  {dest.stat().st_size / 1e6:.0f} MB")


def speak(text, out, voice=DEFAULT_VOICE, rate=1.0):
    model = voice_path(voice)
    wav = Path(out).with_suffix(".wav")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["piper", "-m", str(model), "-f", str(wav),
                    "--length-scale", str(round(1.0 / rate, 3))],
                   input=text, text=True, check=True, capture_output=True)
    if str(out).endswith(".mp3"):
        # 48 kbps mono is plenty for speech and keeps a long read small enough
        # to open on a phone over a bad connection.
        subprocess.run(["lame", "--quiet", "-b", "48", "-m", "m",
                        str(wav), str(out)], check=True)
        wav.unlink()
    return Path(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", help="text file; omit to read stdin")
    ap.add_argument("--out", default="speech.mp3")
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--rate", type=float, default=1.0, help="1.15 is brisker")
    ap.add_argument("--install-voice", metavar="NAME")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the normalised text, synthesise nothing")
    a = ap.parse_args()

    if a.install_voice:
        install_voice(a.install_voice)
        return
    raw = Path(a.src).read_text() if a.src else sys.stdin.read()
    text = normalise(raw)
    if a.dry_run:
        print(text)
        return
    out = speak(text, a.out, a.voice, a.rate)
    mb = out.stat().st_size / 1e6
    words = len(text.split())
    print(f"  {out}  {mb:.1f} MB, ~{words} words, ~{words / 150:.1f} min")


if __name__ == "__main__":
    main()
