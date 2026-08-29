#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PRIMERJAVA obeh avtomatskih načinov plačevanja (scenarija 02 in 03).

Bere CSV iz mape 02 (1 transakcija/poizvedbo) in mape 03 (merjena seja) ter nariše:
  1. kumulativni strošek poravnave v odvisnosti od N (draga premica vs. ravna),
  2. amortizacijo — efektivni on-chain strošek na zahtevo (C_topup / N),
  3. primerjavo latence: on-chain poizvedba vs. off-chain podpisana bremenitev,
  4. tabelo: število zunanjih transakcij in efektivni strošek pri N uporabah.

Če CSV nima pravega gasa, strošek MODELIRA (--gas-price-gwei) in to označi.

Uporaba:
  python3 primerjava.py
  python3 primerjava.py --horizon 100 --gas-price-gwei 2
"""
import os, sys, argparse
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slog import nastavi_slog, ocisti_osi, shrani, oznaci_vzorec, MODRA, ORANZNA, AKVA, INK, INK2, MUTED
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GWEI = 1_000_000_000

def najdi(mapa, imena):
    d = os.path.join(ROOT, mapa, "meritve")
    for n in imena:
        p = os.path.join(d, n)
        if os.path.exists(p):
            return p
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--horizon", type=int, default=50, help="do katerega N naj sega graf")
    ap.add_argument("--gas-price-gwei", type=float, default=2.0)
    ap.add_argument("--gas-per-tx", type=int, default=21000)
    ap.add_argument("--out", default=os.path.join(HERE, "slike"))
    ap.add_argument("--vzorec", action="store_true", help="dodaj vodni žig 'SIMULIRANI PRIMER'")
    args = ap.parse_args()
    nastavi_slog()

    tx_csv = najdi("02_avtomatska_placila_transakcije", ["transakcije_real.csv", "transakcije_mock.csv", "_vzorec/transakcije_real.csv"])
    db_csv = najdi("03_avtomatska_placila_dobroimetje", ["dobroimetje_real.csv", "dobroimetje_mock.csv", "_vzorec/dobroimetje_real.csv"])
    if not tx_csv or not db_csv:
        print("Manjkajo CSV meritve. Poženi mapi 02 in 03 (npm run mock) ali generiraj vzorec."); sys.exit(1)
    if args.vzorec or "_vzorec" in str(tx_csv) or "_vzorec" in str(db_csv):
        oznaci_vzorec(True)
    print(f"Mapa 02: {tx_csv}\nMapa 03: {db_csv}")

    tx = pd.read_csv(tx_csv); db = pd.read_csv(db_csv)
    tx["provizija_eth"] = pd.to_numeric(tx.get("provizija_eth"), errors="coerce")
    tx["t_skupaj_ms"] = pd.to_numeric(tx.get("t_skupaj_ms"), errors="coerce")
    deb = db[db["vrsta"] == "debit"].copy()
    deb["t_skupaj_ms"] = pd.to_numeric(deb.get("t_skupaj_ms"), errors="coerce")
    topup = db[db["vrsta"] == "topup"]
    topup_fee_eth = pd.to_numeric(topup.get("provizija_eth"), errors="coerce").dropna()

    modelirano = tx["provizija_eth"].notna().sum() == 0
    if modelirano:
        fee_tx = args.gas_per_tx * args.gas_price_gwei / 1e9
        fee_topup = fee_tx
        oznaka = f"modelirano @ {args.gas_price_gwei:g} gwei"
    else:
        fee_tx = float(tx["provizija_eth"].dropna().mean())
        fee_topup = float(topup_fee_eth.iloc[0]) if len(topup_fee_eth) else fee_tx
        oznaka = "izmerjeno"

    Nmeas = int(len(deb))
    N = np.arange(1, args.horizon + 1)
    strosek_tx = fee_tx * N            # 1 tx per request
    strosek_seja = np.full_like(N, fee_topup, dtype=float)  # single top-up, flat

    # ── Slika 1: kumulativni strošek poravnave ───────────────────────────────
    fig, ax = plt.subplots(figsize=(8.4, 4.8))
    ax.plot(N, strosek_tx, color=ORANZNA, linewidth=2.4, label="1 transakcija / poizvedbo (mapa 02)")
    ax.plot(N, strosek_seja, color=MODRA, linewidth=2.4, label="merjena seja: 1 polnitev (mapa 03)")
    ax.axvline(Nmeas, color=MUTED, linestyle=":", linewidth=1)
    ax.text(Nmeas, ax.get_ylim()[1] * 0.30, f" izmerjeno\n N={Nmeas}", color=INK2, fontsize=9, va="center")
    ax.set_xlabel("število odčitkov N"); ax.set_ylabel("kumulativni strošek poravnave [ETH]")
    ax.set_title("Kumulativni strošek poravnave: N transakcij vs. ena polnitev")
    ax.legend(loc="upper left"); ocisti_osi(ax)
    if modelirano:
        ax.text(0.99, 0.02, "strošek MODELIRAN (brez pravega gasa)", transform=ax.transAxes, ha="right", va="bottom", fontsize=8, color=MUTED, style="italic")
    shrani(fig, os.path.join(args.out, "01_kumulativni_strosek.png"))

    # ── Slika 2: amortizacija — efektivni strošek na zahtevo ─────────────────
    fig, ax = plt.subplots(figsize=(8.4, 4.8))
    ax.plot(N, np.full_like(N, fee_tx, dtype=float), color=ORANZNA, linewidth=2.4, label="1 tx/poizvedbo: strošek/zahtevo = konst.")
    ax.plot(N, fee_topup / N, color=MODRA, linewidth=2.4, label="merjena seja: strošek/zahtevo = C_polnitev / N")
    ax.scatter([Nmeas], [fee_topup / Nmeas], color=MODRA, zorder=4, s=40)
    ax.annotate(f"pri N={Nmeas}:\n{fee_topup/Nmeas:.3e} ETH/zahtevo\n(faktor {fee_tx/(fee_topup/Nmeas):.0f}× ceneje)",
                xy=(Nmeas, fee_topup / Nmeas), xytext=(20, 30), textcoords="offset points",
                color=INK2, fontsize=9, arrowprops=dict(arrowstyle="->", color=MUTED))
    ax.set_yscale("log"); ax.set_xlabel("število odčitkov N"); ax.set_ylabel("efektivni on-chain strošek na zahtevo [ETH] (log)")
    ax.set_title("Amortizacija fiksnega stroška poravnave (C_debit = C_polnitev / N)")
    ax.legend(loc="upper right"); ocisti_osi(ax)
    if modelirano:
        ax.text(0.99, 0.02, "modelirano", transform=ax.transAxes, ha="right", va="bottom", fontsize=8, color=MUTED, style="italic")
    shrani(fig, os.path.join(args.out, "02_amortizacija.png"))

    # ── Slika 3: latenca — on-chain poizvedba vs off-chain bremenitev ────────
    fig, ax = plt.subplots(figsize=(7.6, 4.8))
    a = tx["t_skupaj_ms"].dropna().values
    b = deb["t_skupaj_ms"].dropna().values
    # Oznake nastavimo posebej: parameter se je v matplotlibu preimenoval
    # (labels -> tick_labels v 3.9), set_xticklabels pa deluje v vseh razlicicah.
    bp = ax.boxplot([a, b], patch_artist=True, widths=0.5, medianprops=dict(color=INK2, linewidth=1.6))
    ax.set_xticklabels(["on-chain poizvedba\n(mapa 02)", "off-chain bremenitev\n(mapa 03)"])
    bp["boxes"][0].set(facecolor=ORANZNA, alpha=0.8, edgecolor=ORANZNA)
    bp["boxes"][1].set(facecolor=MODRA, alpha=0.8, edgecolor=MODRA)
    for w in bp["whiskers"]: w.set(color=MUTED)
    for cp in bp["caps"]: cp.set(color=MUTED)
    ax.set_yscale("log"); ax.set_ylabel("čas [ms] (logaritemska skala)")
    ratio = (np.median(a) / np.median(b)) if len(a) and len(b) and np.median(b) > 0 else float("nan")
    ax.set_title(f"Latenca: on-chain vs. off-chain  (mediana {np.median(a):.0f} ms vs {np.median(b):.2f} ms ≈ {ratio:.0f}×)")
    ocisti_osi(ax)
    shrani(fig, os.path.join(args.out, "03_latenca_primerjava.png"))

    # ── tabela: število poravnav in efektivni strošek pri N ──────────────────
    vrst = []
    for n in sorted(set([1, 5, 10, Nmeas, 50, 100, 1000])):
        vrst.append([n, n, f"{fee_tx*n:.6f}", 1, f"{fee_topup:.6f}", f"{fee_topup/n:.3e}", f"{fee_tx/(fee_topup/n):.0f}×"])
    tab = pd.DataFrame(vrst, columns=["N uporab", "enkr.: št. tx", "enkr.: skupaj ETH", "merj.: št. tx", "merj.: skupaj ETH", "merj.: ETH/zahtevo", "razmerje/zahtevo"])
    os.makedirs(args.out, exist_ok=True)
    tab.to_csv(os.path.join(args.out, "primerjava_stroskov.csv"), index=False)
    print(f"  ✓ tabela: {os.path.join(args.out, 'primerjava_stroskov.csv')}")

    fig, ax = plt.subplots(figsize=(9.5, 0.5 + 0.4 * len(tab)))
    ax.axis("off")
    t = ax.table(cellText=tab.values, colLabels=tab.columns, cellLoc="center", loc="center")
    t.auto_set_font_size(False); t.set_fontsize(8.5); t.scale(1, 1.4)
    for (r, cc), cell in t.get_celld().items():
        cell.set_edgecolor("#e1e0d9")
        if r == 0: cell.set_facecolor(MODRA); cell.set_text_props(color="white", fontweight="bold")
        elif int(tab.iloc[r-1, 0]) == Nmeas: cell.set_facecolor("#eef4fc")
    ax.set_title(f"Poravnave in strošek pri N uporabah ({oznaka})", fontsize=11, fontweight="bold", pad=12)
    shrani(fig, os.path.join(args.out, "04_tabela_stroskov.png"))

    print(f"\nPovzetek ({oznaka}):")
    print(f"  strošek/tx ≈ {fee_tx:.8f} ETH · strošek polnitve ≈ {fee_topup:.8f} ETH")
    print(f"  pri N={Nmeas}: enkratni {fee_tx*Nmeas:.6f} ETH vs merjeni {fee_topup:.6f} ETH → {fee_tx*Nmeas/fee_topup:.1f}× manj poravnave")
    if len(a) and len(b):
        print(f"  latenca: on-chain median {np.median(a):.0f} ms vs off-chain {np.median(b):.2f} ms ≈ {ratio:.0f}× hitreje")
    print("Končano.")

if __name__ == "__main__":
    main()
