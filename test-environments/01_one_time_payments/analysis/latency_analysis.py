#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Latency analysis of the ONE-TIME payment (folder 01).

Reads the CSV produced by measurement_client.js and draws:
  - a box plot of latency by phase,
  - the median phase breakdown of the full flow (stacked bar),
  - a summary table (median / mean / p95) → CSV + PNG.

Usage:
  python3 latency_analysis.py                        # finds the CSV automatically
  python3 latency_analysis.py ../measurements/one_time_real.csv
  python3 latency_analysis.py ../measurements/_sample/one_time_real.csv --out figures
"""
import os, sys, argparse
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from style import set_style, clean_axes, save, mark_sample, t, add_lang_flag, set_language, BLUE, ORANGE, AQUA, INK2, MUTED
import matplotlib.pyplot as plt

def find_csv():
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "measurements")
    for name in ("one_time_real.csv", "one_time_mock.csv", "_sample/one_time_real.csv", "_sample/one_time_mock.csv"):
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

    # Phase labels are built here (not at module level) so that t() runs after
    # set_language() and honours the --sl flag.
    PHASES = [("t_challenge_ms", t("402 challenge", "Izziv 402")),
              ("t_submit_ms", t("Tx submission", "Oddaja tx")),
              ("t_confirm_ms", t("Block confirmation", "Potrditev bloka")),
              ("t_verify_ms", t("Verification", "Preverjanje")),
              ("t_access_ms", t("Access", "Dostop"))]

    csv_path = args.csv or find_csv()
    if not csv_path or not os.path.exists(csv_path):
        print("No CSV found. Run a measurement first:  cd ../client && npm run mock")
        sys.exit(1)

    df = pd.read_csv(csv_path)
    mode = str(df["mode"].iloc[0]) if "mode" in df and len(df) else "?"
    for c, _ in PHASES:
        df[c] = pd.to_numeric(df.get(c), errors="coerce")
    df["t_total_ms"] = pd.to_numeric(df.get("t_total_ms"), errors="coerce")
    set_style()
    if args.sample or "_sample" in str(csv_path):
        mark_sample(True)
    print(f"Source: {csv_path}  ·  mode={mode}  ·  n={len(df)}")

    # phases that have data (>0)
    active = [(c, l) for c, l in PHASES if df[c].notna().any() and df[c].fillna(0).sum() > 0]

    # ── Figure 1: boxplot by phase ───────────────────────────────────────────
    fig, ax = plt.subplots(figsize=(8, 4.6))
    data = [df[c].dropna().values for c, _ in active]
    labels = [l for _, l in active]
    # Set the tick labels separately: the parameter was renamed in matplotlib
    # (labels -> tick_labels in 3.9), while set_xticklabels works in all versions.
    bp = ax.boxplot(data, patch_artist=True, widths=0.55,
                    medianprops=dict(color=INK2, linewidth=1.6),
                    flierprops=dict(marker="o", markersize=3, markerfacecolor=MUTED, markeredgecolor="none", alpha=0.5))
    ax.set_xticklabels(labels)
    for patch in bp["boxes"]:
        patch.set(facecolor=BLUE, alpha=0.75, edgecolor=BLUE)
    for w in bp["whiskers"]: w.set(color=MUTED)
    for cpp in bp["caps"]: cpp.set(color=MUTED)
    span = df[[c for c, _ in active]].max().max() / max(1e-9, df[[c for c, _ in active]].replace(0, np.nan).min().min())
    if span > 50:
        ax.set_yscale("log"); ax.set_ylabel(t("time [ms] (log scale)", "čas [ms] (logaritemska skala)"))
    else:
        ax.set_ylabel(t("time [ms]", "čas [ms]"))
    ax.set_title(t(f"One-time payment latency by phase  ·  mode: {mode}  (n={len(df)})",
                   f"Latenca enkratnega plačila po fazah  ·  način: {mode}  (n={len(df)})"))
    clean_axes(ax)
    save(fig, os.path.join(args.out, "01_latency_boxplot.png"))

    # ── Figure 2: median breakdown of the full flow (stacked bar) ────────────
    med = [float(df[c].median(skipna=True)) if df[c].notna().any() else 0.0 for c, _ in active]
    colors = [BLUE, ORANGE, AQUA, "#eda100", "#4a3aa7"][:len(active)]
    fig, ax = plt.subplots(figsize=(7.6, 2.4))
    left = 0.0
    for v, (c, l), col in zip(med, active, colors):
        ax.barh(0, v, left=left, color=col, edgecolor="white", height=0.6, label=f"{l}")
        if v / max(sum(med), 1e-9) > 0.03:
            ax.text(left + v / 2, 0, f"{l}\n{v:.0f} ms", ha="center", va="center", color="white", fontsize=8.5, fontweight="bold")
        left += v
    ax.set_xlim(0, sum(med) * 1.02); ax.set_yticks([])
    ax.set_xlabel(t("time [ms]", "čas [ms]"))
    ax.set_title(t(f"Median phase breakdown of the one-time flow  (total ≈ {sum(med):.0f} ms)",
                   f"Medianska sestava enkratnega poteka po fazah  (skupaj ≈ {sum(med):.0f} ms)"))
    clean_axes(ax); ax.spines["left"].set_visible(False)
    save(fig, os.path.join(args.out, "02_phase_breakdown.png"))

    # ── summary table ────────────────────────────────────────────────────────
    total_label = t("TOTAL", "SKUPAJ")
    rows = []
    for c, l in active + [("t_total_ms", total_label)]:
        s = pd.to_numeric(df[c], errors="coerce").dropna()
        if len(s):
            rows.append([l, len(s), f"{s.min():.2f}", f"{s.median():.2f}", f"{s.mean():.2f}",
                         f"{s.quantile(0.95):.2f}", f"{s.max():.2f}"])
    # CSV column headers stay plain English so the CSV output does not vary by language.
    tab = pd.DataFrame(rows, columns=["phase", "n", "min", "median", "mean", "p95", "max"])
    csv_out = os.path.join(args.out, "latency_summary.csv")
    os.makedirs(args.out, exist_ok=True); tab.to_csv(csv_out, index=False)
    print(f"  ✓ table: {csv_out}")

    fig, ax = plt.subplots(figsize=(8, 0.5 + 0.4 * len(tab)))
    ax.axis("off")
    tbl = ax.table(cellText=tab.values, colLabels=tab.columns, cellLoc="center", loc="center")
    tbl.auto_set_font_size(False); tbl.set_fontsize(9); tbl.scale(1, 1.4)
    for (r, cc), cell in tbl.get_celld().items():
        cell.set_edgecolor("#e1e0d9")
        if r == 0: cell.set_facecolor(BLUE); cell.set_text_props(color="white", fontweight="bold")
        elif tab.iloc[r-1, 0] == total_label: cell.set_facecolor("#eef4fc"); cell.set_text_props(fontweight="bold")
    ax.set_title(t(f"Latency summary by phase [ms] · mode {mode} (units in milliseconds)",
                   f"Povzetek latence po fazah [ms] · način {mode} (enote v milisekundah)"),
                 fontsize=11, fontweight="bold", pad=12)
    save(fig, os.path.join(args.out, "03_summary_table.png"))
    print("Done.")

if __name__ == "__main__":
    main()
