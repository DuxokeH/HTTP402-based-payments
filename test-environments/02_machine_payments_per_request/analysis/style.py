# -*- coding: utf-8 -*-
"""
Shared style for analysis figures (matplotlib).
Colours come from a validated, colour-blind-friendly palette:
  blue #2a78d6, orange #eb6834, aqua #1baf7a — blue+orange stay distinguishable
  under all colour-vision tests (deuteranopia/protanopia/tritanopia).

Figure text is English by default; pass --sl to any analysis script to render
the Slovenian labels instead (e.g. for a Slovenian-language thesis).
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

# ── palette ─────────────────────────────────────────────────────────────────
BLUE    = "#2a78d6"   # slot 1 — e.g. metered / efficient model
ORANGE  = "#eb6834"   # slot 2 — e.g. one-time / expensive baseline (N transactions)
AQUA    = "#1baf7a"   # slot 3 — extra accent (with a label)
INK     = "#0b0b0b"   # primary text
INK2    = "#52514e"   # secondary text
MUTED   = "#898781"   # axes / small labels
GRID    = "#e1e0d9"   # grid (thin)
AXIS    = "#c3c2b7"   # base axis
SURFACE = "#ffffff"   # white background (print)

# ── language of rendered figure text ────────────────────────────────────────
_LANG = "en"

def set_language(lang):
    """Select the language of all subsequently rendered figure text.

    "en" (default) or "sl". Analysis scripts expose this as the --sl flag.
    """
    global _LANG
    _LANG = "sl" if str(lang).lower().startswith("sl") else "en"

def t(en, sl):
    """Return the English or Slovenian variant of a figure string."""
    return sl if _LANG == "sl" else en

def add_lang_flag(parser):
    """Attach the shared --sl flag to an argparse parser."""
    parser.add_argument("--sl", action="store_true",
                        help="render figure text in Slovenian (default: English)")

def set_style():
    plt.rcParams.update({
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE,
        "font.family": "DejaVu Sans",   # supports č, š, ž
        "font.size": 11,
        "axes.titlesize": 13,
        "axes.titleweight": "bold",
        "axes.labelsize": 11,
        "axes.edgecolor": AXIS,
        "axes.linewidth": 1.0,
        "axes.grid": True,
        "axes.axisbelow": True,
        "grid.color": GRID,
        "grid.linewidth": 0.8,
        "xtick.color": INK2, "ytick.color": INK2,
        "xtick.labelsize": 10, "ytick.labelsize": 10,
        "text.color": INK, "axes.labelcolor": INK,
        "legend.frameon": False, "legend.fontsize": 10,
        "figure.dpi": 130,
    })

def clean_axes(ax):
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(AXIS)
    ax.spines["bottom"].set_color(AXIS)

_SAMPLE = False
def mark_sample(v=True):
    """Watermark every figure rendered from here on (simulated/sample data)."""
    global _SAMPLE
    _SAMPLE = bool(v)

def watermark(fig, text=None):
    """Diagonal red watermark — for figures built from simulated/sample data."""
    if text is None:
        text = t("SIMULATED EXAMPLE — NOT REAL MEASUREMENTS",
                 "SIMULIRANI PRIMER — NE PRAVE MERITVE")
    fig.text(0.5, 0.5, text, fontsize=22, color="#d03b3b", alpha=0.28,
             ha="center", va="center", rotation=22, fontweight="bold", zorder=1000)

def save(fig, path):
    import os
    if _SAMPLE:
        watermark(fig)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fig.tight_layout()
    fig.savefig(path, dpi=150, bbox_inches="tight", facecolor=SURFACE)
    plt.close(fig)
    print(f"  ✓ figure: {path}")
