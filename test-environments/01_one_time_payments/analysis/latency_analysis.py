#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Analiza latence ENKRATNEGA plačila (mapa 01).

Prebere CSV, ki ga ustvari merilni_klient.js, in nariše:
  - škatlasti diagram (boxplot) latence po fazah,
  - mediansko sestavo celotnega poteka po fazah (naložen stolpec),
  - povzetno tabelo (median / povprečje / p95) → CSV + PNG.

Uporaba:
  python3 analiza_latence.py                        # samodejno poišče CSV
  python3 analiza_latence.py ../meritve/enkratna_real.csv
  python3 analiza_latence.py ../meritve/_vzorec/enkratna_real.csv --out slike
"""
import os, sys, argparse
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slog import nastavi_slog, ocisti_osi, shrani, oznaci_vzorec, MODRA, ORANZNA, AKVA, INK2, MUTED
import matplotlib.pyplot as plt

FAZE = [("t_izziv_ms", "Izziv 402"), ("t_oddaja_ms", "Oddaja tx"),
        ("t_potrditev_ms", "Potrditev bloka"), ("t_preverjanje_ms", "Preverjanje"),
        ("t_dostop_ms", "Dostop")]

def poisci_csv():
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "meritve")
    for name in ("enkratna_real.csv", "enkratna_mock.csv", "_vzorec/enkratna_real.csv", "_vzorec/enkratna_mock.csv"):
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="?", default=None)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "slike"))
    ap.add_argument("--vzorec", action="store_true", help="dodaj vodni žig 'SIMULIRANI PRIMER'")
    args = ap.parse_args()
    csv_path = args.csv or poisci_csv()
    if not csv_path or not os.path.exists(csv_path):
        print("Ni najdenega CSV. Najprej poženi meritev:  cd ../klient && npm run mock")
        sys.exit(1)

    df = pd.read_csv(csv_path)
    nacin = str(df["nacin"].iloc[0]) if "nacin" in df and len(df) else "?"
    for c, _ in FAZE:
        df[c] = pd.to_numeric(df.get(c), errors="coerce")
    df["t_skupaj_ms"] = pd.to_numeric(df.get("t_skupaj_ms"), errors="coerce")
    nastavi_slog()
    if args.vzorec or "_vzorec" in str(csv_path):
        oznaci_vzorec(True)
    print(f"Vir: {csv_path}  ·  način={nacin}  ·  n={len(df)}")

    # faze, ki imajo podatke (>0)
    aktivne = [(c, l) for c, l in FAZE if df[c].notna().any() and df[c].fillna(0).sum() > 0]

    # ── Slika 1: boxplot po fazah ────────────────────────────────────────────
    fig, ax = plt.subplots(figsize=(8, 4.6))
    podatki = [df[c].dropna().values for c, _ in aktivne]
    oznake = [l for _, l in aktivne]
    # Oznake nastavimo posebej: parameter se je v matplotlibu preimenoval
    # (labels -> tick_labels v 3.9), set_xticklabels pa deluje v vseh razlicicah.
    bp = ax.boxplot(podatki, patch_artist=True, widths=0.55,
                    medianprops=dict(color=INK2, linewidth=1.6),
                    flierprops=dict(marker="o", markersize=3, markerfacecolor=MUTED, markeredgecolor="none", alpha=0.5))
    ax.set_xticklabels(oznake)
    for patch in bp["boxes"]:
        patch.set(facecolor=MODRA, alpha=0.75, edgecolor=MODRA)
    for w in bp["whiskers"]: w.set(color=MUTED)
    for cpp in bp["caps"]: cpp.set(color=MUTED)
    span = df[[c for c, _ in aktivne]].max().max() / max(1e-9, df[[c for c, _ in aktivne]].replace(0, np.nan).min().min())
    if span > 50:
        ax.set_yscale("log"); ax.set_ylabel("čas [ms] (logaritemska skala)")
    else:
        ax.set_ylabel("čas [ms]")
    ax.set_title(f"Latenca enkratnega plačila po fazah  ·  način: {nacin}  (n={len(df)})")
    ocisti_osi(ax)
    shrani(fig, os.path.join(args.out, "01_latenca_boxplot.png"))

    # ── Slika 2: medianska sestava celotnega poteka (naložen stolpec) ────────
    med = [float(df[c].median(skipna=True)) if df[c].notna().any() else 0.0 for c, _ in aktivne]
    barve = [MODRA, ORANZNA, AKVA, "#eda100", "#4a3aa7"][:len(aktivne)]
    fig, ax = plt.subplots(figsize=(7.6, 2.4))
    levo = 0.0
    for v, (c, l), col in zip(med, aktivne, barve):
        ax.barh(0, v, left=levo, color=col, edgecolor="white", height=0.6, label=f"{l}")
        if v / max(sum(med), 1e-9) > 0.03:
            ax.text(levo + v / 2, 0, f"{l}\n{v:.0f} ms", ha="center", va="center", color="white", fontsize=8.5, fontweight="bold")
        levo += v
    ax.set_xlim(0, sum(med) * 1.02); ax.set_yticks([])
    ax.set_xlabel("čas [ms]"); ax.set_title(f"Medianska sestava enkratnega poteka po fazah  (skupaj ≈ {sum(med):.0f} ms)")
    ocisti_osi(ax); ax.spines["left"].set_visible(False)
    shrani(fig, os.path.join(args.out, "02_sestava_faz.png"))

    # ── povzetna tabela ──────────────────────────────────────────────────────
    vrstice = []
    for c, l in aktivne + [("t_skupaj_ms", "SKUPAJ")]:
        s = pd.to_numeric(df[c], errors="coerce").dropna()
        if len(s):
            vrstice.append([l, len(s), f"{s.min():.2f}", f"{s.median():.2f}", f"{s.mean():.2f}",
                            f"{s.quantile(0.95):.2f}", f"{s.max():.2f}"])
    tab = pd.DataFrame(vrstice, columns=["faza", "n", "min", "mediana", "povprečje", "p95", "maks"])
    csv_out = os.path.join(args.out, "povzetek_latenca.csv")
    os.makedirs(args.out, exist_ok=True); tab.to_csv(csv_out, index=False)
    print(f"  ✓ tabela: {csv_out}")

    fig, ax = plt.subplots(figsize=(8, 0.5 + 0.4 * len(tab)))
    ax.axis("off")
    t = ax.table(cellText=tab.values, colLabels=tab.columns, cellLoc="center", loc="center")
    t.auto_set_font_size(False); t.set_fontsize(9); t.scale(1, 1.4)
    for (r, cc), cell in t.get_celld().items():
        cell.set_edgecolor("#e1e0d9")
        if r == 0: cell.set_facecolor(MODRA); cell.set_text_props(color="white", fontweight="bold")
        elif tab.iloc[r-1, 0] == "SKUPAJ": cell.set_facecolor("#eef4fc"); cell.set_text_props(fontweight="bold")
    ax.set_title(f"Povzetek latence po fazah [ms] · način {nacin} (enote v milisekundah)", fontsize=11, fontweight="bold", pad=12)
    shrani(fig, os.path.join(args.out, "03_povzetek_tabela.png"))
    print("Končano.")

if __name__ == "__main__":
    main()
