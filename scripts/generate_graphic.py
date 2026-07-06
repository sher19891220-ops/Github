#!/usr/bin/env python3
"""Generate a simple stat-card PNG for Telegram posts.

Usage: generate_graphic.py "STAT" "context line" /path/to/output.png
"""
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

WIDTH_IN, HEIGHT_IN, DPI = 10.8, 10.8, 100
BG = "#0b1220"
ACCENT = "#3ba7ff"
FG = "#f5f7fa"
MUTED = "#9fb0c3"


def main():
    if len(sys.argv) != 4:
        print(f"usage: {sys.argv[0]} STAT CONTEXT OUTPUT_PATH", file=sys.stderr)
        sys.exit(1)

    stat, context, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

    fig = plt.figure(figsize=(WIDTH_IN, HEIGHT_IN), dpi=DPI)
    fig.patch.set_facecolor(BG)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_facecolor(BG)
    ax.axis("off")

    ax.axhline(y=0.86, xmin=0.08, xmax=0.32, color=ACCENT, linewidth=4)

    ax.text(0.08, 0.74, "FOUNDER HUB", color=ACCENT, fontsize=20,
             fontweight="bold", family="sans-serif", ha="left", va="top")

    stat_fontsize = 68 if len(stat) <= 12 else max(30, int(68 * 12 / len(stat)))
    ax.text(0.08, 0.60, stat, color=FG, fontsize=stat_fontsize, fontweight="bold",
             family="sans-serif", ha="left", va="top", wrap=True)

    ax.text(0.08, 0.30, context, color=MUTED, fontsize=24, family="sans-serif",
             ha="left", va="top", wrap=True)

    ax.text(0.08, 0.06, "Transportation & Logistics Daily", color=MUTED,
             fontsize=14, family="sans-serif", ha="left", va="bottom")

    fig.savefig(out_path, facecolor=BG)
    plt.close(fig)
    print(out_path)


if __name__ == "__main__":
    main()
