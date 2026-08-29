#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Analiza MERJENE SEJE z dobroimetjem (mapa 03).

Nariše:
  - latenco posamezne podpisane bremenitve (t_podpis + t_zahteva) — nekaj ms,
  - upadanje dobroimetja in preostanka proračuna skozi sejo.

Uporaba:
  python3 analiza_dobroimetje.py
  python3 analiza_dobroimetje.py ../meritve/dobroimetje_real.csv
"""
import os, sys, argparse
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slog import nastavi_slog, ocisti_osi, shrani, oznaci_vzorec, MODRA, ORANZNA, AKVA, INK2, MUTED
import matplotlib.pyplot as plt

def poisci_csv():
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "meritve")
    for name in ("dobroimetje_real.csv", "dobroimetje_mock.csv", "_vzorec/dobroimetje_real.csv", "_vzorec/dobroimetje_mock.csv"):
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
        print("Ni CSV. Najprej poženi meritev:  cd ../agent && npm run mock"); sys.exit(1)

    df = pd.read_csv(csv_path)
    nacin = str(df["nacin"].iloc[0]) if "nacin" in df and len(df) else "?"
    deb = df[df["vrsta"] == "debit"].copy().reset_index(drop=True)
    for c in ("t_podpis_ms", "t_zahteva_ms", "streznik_ms", "cena_wei", "dobroimetje_wei", "proracun_ostanek_wei"):
        deb[c] = pd.to_numeric(deb.get(c), errors="coerce")
    deb["idx"] = np.arange(1, len(deb) + 1)
    nastavi_slog()
    if args.vzorec or "_vzorec" in str(csv_path):
        oznaci_vzorec(True)
    print(f"Vir: {csv_path}  ·  način={nacin}  ·  bremenitev={len(deb)}")

    # ── Slika 1: latenca bremenitve (podpis + zahteva) ───────────────────────
    fig, ax = plt.subplots(figsize=(8, 4.4))
    ax.bar(deb["idx"], deb["t_podpis_ms"], color=AKVA, label="t_podpis (odjemalec)", width=0.7)
    ax.bar(deb["idx"], deb["t_zahteva_ms"], bottom=deb["t_podpis_ms"], color=MODRA, label="t_zahteva (omrežje+strežnik)", width=0.7)
    skupaj = (deb["t_podpis_ms"] + deb["t_zahteva_ms"])
    med = float(skupaj.median())
    ax.axhline(med, color=MUTED, linestyle="--", linewidth=1, label=f"mediana skupaj ≈ {med:.2f} ms")
    ax.set_xlabel("zaporedna bremenitev"); ax.set_ylabel("čas [ms]")
    ax.set_title(f"Latenca podpisane bremenitve (off-chain) · način {nacin}")
    ax.legend(loc="upper right"); ocisti_osi(ax)
    shrani(fig, os.path.join(args.out, "01_latenca_bremenitve.png"))

    # ── Slika 2: upadanje dobroimetja in proračuna ───────────────────────────
    fig, ax = plt.subplots(figsize=(8, 4.4))
    ax.step(deb["idx"], deb["dobroimetje_wei"], where="post", color=MODRA, linewidth=2, marker="o", markersize=3.5, label="preostalo dobroimetje")
    if deb["proracun_ostanek_wei"].notna().any() and not deb["proracun_ostanek_wei"].equals(deb["dobroimetje_wei"]):
        ax.step(deb["idx"], deb["proracun_ostanek_wei"], where="post", color=ORANZNA, linewidth=1.8, linestyle="--", label="preostali proračun")
    ax.set_xlabel("zaporedna bremenitev"); ax.set_ylabel("wei")
    ax.set_title(f"Poraba predplačniškega dobroimetja skozi sejo (način {nacin})")
    ax.legend(loc="upper right"); ocisti_osi(ax)
    ax.ticklabel_format(style="plain", axis="y")
    shrani(fig, os.path.join(args.out, "02_poraba_dobroimetja.png"))

    st = lambda s: (s.min(), s.median(), s.mean(), s.quantile(0.95), s.max())
    mn, md, mean, p95, mx = st(skupaj.dropna())
    print(f"  Latenca bremenitve [ms]: min={mn:.2f} median={md:.2f} mean={mean:.2f} p95={p95:.2f} max={mx:.2f}")
    print(f"  On-chain transakcij v seji: 1 (polnitev) za {len(deb)} odčitkov")
    print("Končano.")

if __name__ == "__main__":
    main()
