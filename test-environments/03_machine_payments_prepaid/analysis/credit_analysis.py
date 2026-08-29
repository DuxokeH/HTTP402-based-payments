#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Analysis of the METERED SESSION with credit (folder 03).

Plots:
  - the latency of each signed debit (t_sign + t_request) — a few ms,
  - the decline of credit and remaining budget over the session.

Usage:
  python3 credit_analysis.py
  python3 credit_analysis.py ../measurements/credit_real.csv
"""
import os, sys, argparse
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from style import set_style, clean_axes, save, mark_sample, t, add_lang_flag, set_language, BLUE, ORANGE, AQUA, INK2, MUTED
import matplotlib.pyplot as plt

def find_csv():
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "measurements")
    for name in ("credit_real.csv", "credit_mock.csv", "_sample/credit_real.csv", "_sample/credit_mock.csv"):
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="?", default=None)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "figures"))
    ap.add_argument("--sample", action="store_true", help="add the 'SIMULATED EXAMPLE' watermark")
    add_lang_flag(ap)
    args = ap.parse_args()
    set_language("sl" if args.sl else "en")
    csv_path = args.csv or find_csv()
    if not csv_path or not os.path.exists(csv_path):
        print("No CSV found. Run a measurement first:  cd ../agent && npm run mock"); sys.exit(1)

    df = pd.read_csv(csv_path)
    mode = str(df["mode"].iloc[0]) if "mode" in df and len(df) else "?"
    deb = df[df["kind"] == "debit"].copy().reset_index(drop=True)
    for c in ("t_sign_ms", "t_request_ms", "server_ms", "price_wei", "credit_wei", "budget_remaining_wei"):
        deb[c] = pd.to_numeric(deb.get(c), errors="coerce")
    deb["idx"] = np.arange(1, len(deb) + 1)
    set_style()
    if args.sample or "_sample" in str(csv_path):
        mark_sample(True)
    print(f"Source: {csv_path}  ·  mode={mode}  ·  debits={len(deb)}")

    # ── Figure 1: debit latency (sign + request) ─────────────────────────
    fig, ax = plt.subplots(figsize=(8, 4.4))
    ax.bar(deb["idx"], deb["t_sign_ms"], color=AQUA, label=t("t_sign (client)", "t_podpis (odjemalec)"), width=0.7)
    ax.bar(deb["idx"], deb["t_request_ms"], bottom=deb["t_sign_ms"], color=BLUE, label=t("t_request (network+server)", "t_zahteva (omrežje+strežnik)"), width=0.7)
    skupaj = (deb["t_sign_ms"] + deb["t_request_ms"])
    med = float(skupaj.median())
    ax.axhline(med, color=MUTED, linestyle="--", linewidth=1, label=t(f"total median ≈ {med:.2f} ms", f"mediana skupaj ≈ {med:.2f} ms"))
    ax.set_xlabel(t("debit number", "zaporedna bremenitev")); ax.set_ylabel(t("time [ms]", "čas [ms]"))
    ax.set_title(t(f"Signed debit latency (off-chain) · mode {mode}", f"Latenca podpisane bremenitve (off-chain) · način {mode}"))
    ax.legend(loc="upper right"); clean_axes(ax)
    save(fig, os.path.join(args.out, "01_debit_latency.png"))

    # ── Figure 2: decline of credit and budget ───────────────────────────────
    fig, ax = plt.subplots(figsize=(8, 4.4))
    ax.step(deb["idx"], deb["credit_wei"], where="post", color=BLUE, linewidth=2, marker="o", markersize=3.5, label=t("remaining credit", "preostalo dobroimetje"))
    if deb["budget_remaining_wei"].notna().any() and not deb["budget_remaining_wei"].equals(deb["credit_wei"]):
        ax.step(deb["idx"], deb["budget_remaining_wei"], where="post", color=ORANGE, linewidth=1.8, linestyle="--", label=t("remaining budget", "preostali proračun"))
    ax.set_xlabel(t("debit number", "zaporedna bremenitev")); ax.set_ylabel("wei")
    ax.set_title(t(f"Prepaid credit consumption over the session (mode {mode})", f"Poraba predplačniškega dobroimetja skozi sejo (način {mode})"))
    ax.legend(loc="upper right"); clean_axes(ax)
    ax.ticklabel_format(style="plain", axis="y")
    save(fig, os.path.join(args.out, "02_credit_consumption.png"))

    st = lambda s: (s.min(), s.median(), s.mean(), s.quantile(0.95), s.max())
    mn, md, mean, p95, mx = st(skupaj.dropna())
    print(f"  Debit latency [ms]: min={mn:.2f} median={md:.2f} mean={mean:.2f} p95={p95:.2f} max={mx:.2f}")
    print(f"  On-chain transactions in the session: 1 (top-up) for {len(deb)} readings")
    print("Done.")

if __name__ == "__main__":
    main()
