---
name: voice
description: Read an answer, report or setup guide aloud as an MP3, in a neural voice, entirely offline. Use when the user asks to hear something, wants it "voiced", spoken, narrated, read out, as audio, or as a briefing for the car. Handles this project's money, rates, percentages and per-mile figures correctly.
---

# Voice

`python3 tools/say.py` turns text into an MP3 with Piper, a neural TTS that runs
in this container. Nothing leaves the machine — the text being read is the
group's own margins, break-even and what the sheets get wrong, and that does not
belong on a cloud voice API for the sake of a nicer accent.

## Use it

    python3 tools/say.py --in notes.md --out brief.mp3
    echo "..." | python3 tools/say.py --out answer.mp3 --rate 1.15
    python3 tools/say.py --in notes.md --dry-run     # see the words, make no audio

Then send the file with SendUserFile.

**Always `--dry-run` first on anything with figures in it.** The synthesiser is
the easy half; the normaliser is where a number gets said wrong, and a spoken
number has one chance to land.

## What it fixes, and why each one matters

| written | spoken |
|---|---|
| `$0.0003` | zero point zero three cents |
| `$2.928` | two point nine two eight dollars |
| `$2.80` | two dollars eighty |
| `$82,801` | eighty-two thousand eight hundred and one dollars |
| `4.69%` | four point six nine percent |
| `$2,043/truck-week` | … dollars a truck week |
| `XTRACK` `AFG` `IFTA` | Ex-track, A F G, IF-ta |

**A rate is not a price.** `$2.80` is "two dollars eighty"; `$2.928` is "two
point nine two eight dollars". Reading a rate the first way truncates it into a
different number, said with total confidence.

**Sub-dollar figures become cents**, keeping every place. `$0.0003` read as
"zero point three cents" is ten times the truth, and it is the per-mile figures
that decide whether a truck makes money.

**Markdown furniture is stripped** — a table border read aloud is a minute of
"pipe dash pipe dash".

## Length

About 150 words a minute. A full cost-structure answer is 4–6 minutes; trim to
the findings before rendering rather than reading a table aloud. Tables do not
work as audio — say the three numbers that matter and leave the grid on screen.

## Voices

`en_US-lessac-medium` (63 MB, in `/opt/piper-voices`) is the default: neutral US
English, clear on numbers. Others: `--install-voice en_US-amy-medium` (lighter),
`en_US-ryan-high` (deeper, larger). `--rate 1.15` is brisker without distortion.

**After a container reclaim the voice model is gone** — it lives outside the repo
because it is 63 MB of binary. `say.py` then names the install command rather
than failing obscurely.
