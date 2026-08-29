#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Analysis of MACHINE payments with 1 transaction per query (folder 02).

Plots:
  - cumulative fee cost (gas) as a function of the number of queries N
    (a steeply rising straight line — every query is a new transaction),
  - the latency of each individual query in sequence order.

If the CSV has no real gas values (e.g. mock), the cost is MODELLED with an
assumed gas price (--gas-price-gwei) and clearly labelled as "modelled".

Usage:
  python3 transaction_analysis.py
  python3 transaction_analysis.py ../measurements/transactions_real.csv --gas-price-gwei 2
"""
import os, sys, argparse
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from style import set_style, clean_axes, save, mark_sample, t, add_lang_flag, set_language, ORANGE, BLUE, INK2, MUTED
import matplotlib.pyplot as plt

GWEI = 1_000_000_000

def find_csv():
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "measurements")
    for name in ("transactions_real.csv", "transactions_mock.csv", "_sample/transactions_real.csv", "_sample/transactions_mock.csv"):
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="?", default=None)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "figures"))
    ap.add_argument("--gas-price-gwei", type=float, default=2.0, help="assumed gas price for the MODEL when the CSV has no gas values")
    ap.add_argument("--gas-per-tx", type=int, default=21000)
    ap.add_argument("--sample", action="store_true", help="add the 'SIMULATED EXAMPLE' watermark")
    add_lang_flag(ap)
    args = ap.parse_args()
    set_language("sl" if args.sl else "en")
    csv_path = args.csv or find_csv()
    if not csv_path or not os.path.exists(csv_path):
        print("No CSV found. Run a measurement first:  cd ../agent && npm run mock"); sys.exit(1)

    df = pd.read_csv(csv_path)
    mode = str(df["mode"].iloc[0]) if "mode" in df and len(df) else "?"
    df["query"] = pd.to_numeric(df["query"], errors="coerce")
    df = df.sort_values("query")
    df["fee_eth"] = pd.to_numeric(df.get("fee_eth"), errors="coerce")
    df["t_total_ms"] = pd.to_numeric(df.get("t_total_ms"), errors="coerce")
    set_style()
    if args.sample or "_sample" in str(csv_path):
        mark_sample(True)
    print(f"Source: {csv_path}  ·  mode={mode}  ·  n={len(df)}")

    N = df["query"].astype(int).values
    modelirano = df["fee_eth"].notna().sum() == 0
    if modelirano:
        fee = args.gas_per_tx * args.gas_price_gwei / 1e9   # ETH/tx
        cum = np.cumsum(np.full(len(df), fee))
        oznaka = t(f"modelled @ {args.gas_price_gwei:g} gwei", f"modelirano @ {args.gas_price_gwei:g} gwei")
    else:
        fee = float(df["fee_eth"].dropna().mean())
        cum = df["fee_eth"].fillna(fee).cumsum().values
        oznaka = t("measured", "izmerjeno")

    # ── Figure 1: cumulative settlement cost ─────────────────────────────────
    fig, ax = plt.subplots(figsize=(8, 4.6))
    ax.step(N, cum, where="post", color=ORANGE, linewidth=2.2, label=t(f"1 transaction / query ({oznaka})", f"1 transakcija / poizvedbo ({oznaka})"))
    ax.scatter(N, cum, color=ORANGE, s=18, zorder=3)
    ax.set_xlabel(t("number of queries N", "število poizvedb N")); ax.set_ylabel(t("cumulative settlement cost [ETH]", "kumulativni strošek poravnave [ETH]"))
    ax.set_title(t("Machine payments: cumulative gas cost grows linearly with N", "Avtomatska plačila: kumulativni strošek gasa narašča linearno z N"))
    ax.annotate(t(f"{len(N)} queries = {len(N)} transactions\n≈ {cum[-1]:.6f} ETH", f"{len(N)} poizvedb = {len(N)} transakcij\n≈ {cum[-1]:.6f} ETH"),
                xy=(N[-1], cum[-1]), xytext=(-10, -30), textcoords="offset points",
                ha="right", color=INK2, fontsize=9,
                arrowprops=dict(arrowstyle="->", color=MUTED))
    ax.legend(loc="upper left")
    clean_axes(ax)
    if modelirano:
        ax.text(0.99, 0.02, t("cost MODELLED (CSV has no real gas values)", "strošek MODELIRAN (CSV brez pravega gasa)"), transform=ax.transAxes,
                ha="right", va="bottom", fontsize=8, color=MUTED, style="italic")
    save(fig, os.path.join(args.out, "01_cumulative_gas.png"))

    # ── Figure 2: latency of individual queries ─────────────────────────────
    fig, ax = plt.subplots(figsize=(8, 4.2))
    ax.plot(N, df["t_total_ms"].values, color=BLUE, linewidth=1.8, marker="o", markersize=4, label=t("t_total", "t_skupaj"))
    med = float(df["t_total_ms"].median())
    ax.axhline(med, color=MUTED, linestyle="--", linewidth=1, label=t(f"median ≈ {med:.0f} ms", f"mediana ≈ {med:.0f} ms"))
    ax.set_xlabel(t("query number in sequence", "zaporedna poizvedba")); ax.set_ylabel(t("query time [ms]", "čas poizvedbe [ms]"))
    ax.set_title(t(f"Latency of individual queries (mode {mode})", f"Latenca posamezne poizvedbe (način {mode})"))
    ax.legend(); clean_axes(ax)
    save(fig, os.path.join(args.out, "02_query_latency.png"))

    print(f"  Total transactions: {len(df)} · cumulative cost ≈ {cum[-1]:.8f} ETH ({oznaka})")
    print("Done.")

if __name__ == "__main__":
    main()
