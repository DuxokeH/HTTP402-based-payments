#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Analiza AVTOMATSKIH plačil z 1 transakcijo/poizvedbo (mapa 02).

Nariše:
  - kumulativni strošek provizij (gas) v odvisnosti od števila poizvedb N
    (strmo naraščajoča premica — vsaka poizvedba je nova transakcija),
  - latenco posamezne poizvedbe po zaporedju.

Če CSV nima pravih vrednosti gasa (npr. mock), strošek MODELIRA z domnevno
ceno gasa (--gas-price-gwei) in to jasno označi kot »modelirano«.

Uporaba:
  python3 analiza_transakcije.py
  python3 analiza_transakcije.py ../meritve/transakcije_real.csv --gas-price-gwei 2
"""
import os, sys, argparse
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slog import nastavi_slog, ocisti_osi, shrani, oznaci_vzorec, ORANZNA, MODRA, INK2, MUTED
import matplotlib.pyplot as plt

GWEI = 1_000_000_000

def poisci_csv():
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "meritve")
    for name in ("transakcije_real.csv", "transakcije_mock.csv", "_vzorec/transakcije_real.csv", "_vzorec/transakcije_mock.csv"):
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="?", default=None)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "slike"))
    ap.add_argument("--gas-price-gwei", type=float, default=2.0, help="domnevna cena gasa za MODEL, če CSV nima gasa")
    ap.add_argument("--gas-per-tx", type=int, default=21000)
    ap.add_argument("--vzorec", action="store_true", help="dodaj vodni žig 'SIMULIRANI PRIMER'")
    args = ap.parse_args()
    csv_path = args.csv or poisci_csv()
    if not csv_path or not os.path.exists(csv_path):
        print("Ni CSV. Najprej poženi meritev:  cd ../agent && npm run mock"); sys.exit(1)

    df = pd.read_csv(csv_path)
    nacin = str(df["nacin"].iloc[0]) if "nacin" in df and len(df) else "?"
    df["poizvedba"] = pd.to_numeric(df["poizvedba"], errors="coerce")
    df = df.sort_values("poizvedba")
    df["provizija_eth"] = pd.to_numeric(df.get("provizija_eth"), errors="coerce")
    df["t_skupaj_ms"] = pd.to_numeric(df.get("t_skupaj_ms"), errors="coerce")
    nastavi_slog()
    if args.vzorec or "_vzorec" in str(csv_path):
        oznaci_vzorec(True)
    print(f"Vir: {csv_path}  ·  način={nacin}  ·  n={len(df)}")

    N = df["poizvedba"].astype(int).values
    modelirano = df["provizija_eth"].notna().sum() == 0
    if modelirano:
        fee = args.gas_per_tx * args.gas_price_gwei / 1e9   # ETH/tx
        cum = np.cumsum(np.full(len(df), fee))
        oznaka = f"modelirano @ {args.gas_price_gwei:g} gwei"
    else:
        fee = float(df["provizija_eth"].dropna().mean())
        cum = df["provizija_eth"].fillna(fee).cumsum().values
        oznaka = "izmerjeno"

    # ── Slika 1: kumulativni strošek poravnave ───────────────────────────────
    fig, ax = plt.subplots(figsize=(8, 4.6))
    ax.step(N, cum, where="post", color=ORANZNA, linewidth=2.2, label=f"1 transakcija / poizvedbo ({oznaka})")
    ax.scatter(N, cum, color=ORANZNA, s=18, zorder=3)
    ax.set_xlabel("število poizvedb N"); ax.set_ylabel("kumulativni strošek poravnave [ETH]")
    ax.set_title("Avtomatska plačila: kumulativni strošek gasa narašča linearno z N")
    ax.annotate(f"{len(N)} poizvedb = {len(N)} transakcij\n≈ {cum[-1]:.6f} ETH",
                xy=(N[-1], cum[-1]), xytext=(-10, -30), textcoords="offset points",
                ha="right", color=INK2, fontsize=9,
                arrowprops=dict(arrowstyle="->", color=MUTED))
    ax.legend(loc="upper left")
    ocisti_osi(ax)
    if modelirano:
        ax.text(0.99, 0.02, "strošek MODELIRAN (CSV brez pravega gasa)", transform=ax.transAxes,
                ha="right", va="bottom", fontsize=8, color=MUTED, style="italic")
    shrani(fig, os.path.join(args.out, "01_kumulativni_gas.png"))

    # ── Slika 2: latenca posamezne poizvedbe ─────────────────────────────────
    fig, ax = plt.subplots(figsize=(8, 4.2))
    ax.plot(N, df["t_skupaj_ms"].values, color=MODRA, linewidth=1.8, marker="o", markersize=4, label="t_skupaj")
    med = float(df["t_skupaj_ms"].median())
    ax.axhline(med, color=MUTED, linestyle="--", linewidth=1, label=f"mediana ≈ {med:.0f} ms")
    ax.set_xlabel("zaporedna poizvedba"); ax.set_ylabel("čas poizvedbe [ms]")
    ax.set_title(f"Latenca posamezne poizvedbe (način {nacin})")
    ax.legend(); ocisti_osi(ax)
    shrani(fig, os.path.join(args.out, "02_latenca_poizvedb.png"))

    print(f"  Skupaj transakcij: {len(df)} · kumulativni strošek ≈ {cum[-1]:.8f} ETH ({oznaka})")
    print("Končano.")

if __name__ == "__main__":
    main()
