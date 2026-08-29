# -*- coding: utf-8 -*-
"""
Skupni slog za slike (matplotlib).
Barve iz validirane, barvno-slepim prijazne palete (dataviz skill):
  modra #2a78d6, oranžna #eb6834, akva #1baf7a — modra+oranžna prestaneta
  vse teste ločljivosti tudi za barvno slepoto (deuteran/protan/tritan).

Oznake so slovenske, enako kot konzolni izpisi in glave CSV v tem projektu.
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

# ── paleta ──────────────────────────────────────────────────────────────────
MODRA   = "#2a78d6"   # slot 1 — npr. merjeni / učinkoviti način
ORANZNA = "#eb6834"   # slot 2 — npr. enkratni / draga osnova (N transakcij)
AKVA    = "#1baf7a"   # slot 3 — dodatni poudarek (z oznako)
INK     = "#0b0b0b"   # primarno besedilo
INK2    = "#52514e"   # sekundarno besedilo
MUTED   = "#898781"   # osi / drobne oznake
GRID    = "#e1e0d9"   # mreža (tanka)
AXIS    = "#c3c2b7"   # bazna os
SURFACE = "#ffffff"   # bela podlaga (tisk)

def nastavi_slog():
    plt.rcParams.update({
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE,
        "font.family": "DejaVu Sans",   # podpira č, š, ž
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

def ocisti_osi(ax):
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(AXIS)
    ax.spines["bottom"].set_color(AXIS)

_VZOREC = False
def oznaci_vzorec(v=True):
    """Vklopi vodni žig na vseh nadaljnjih slikah (za simulirane/vzorčne podatke)."""
    global _VZOREC
    _VZOREC = bool(v)

def vodni_zig(fig, besedilo="SIMULIRANI PRIMER — NE PRAVE MERITVE"):
    """Diagonalni rdeč vodni žig — za slike iz simuliranih/vzorčnih podatkov."""
    fig.text(0.5, 0.5, besedilo, fontsize=22, color="#d03b3b", alpha=0.28,
             ha="center", va="center", rotation=22, fontweight="bold", zorder=1000)

def shrani(fig, pot):
    import os
    if _VZOREC:
        vodni_zig(fig)
    os.makedirs(os.path.dirname(pot), exist_ok=True)
    fig.tight_layout()
    fig.savefig(pot, dpi=150, bbox_inches="tight", facecolor=SURFACE)
    plt.close(fig)
    print(f"  ✓ slika: {pot}")
