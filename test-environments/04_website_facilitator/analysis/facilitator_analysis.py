#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
 FACILITATOR-BRANCH ANALYSIS — payment per reading, metered session, message count
 (folder 04_website_facilitator/analysis)
================================================================================

Compares the DIRECT topology (a) with the FACILITATOR topology (b) and renders
the figures. All inputs are CSVs produced by this folder's measurement agent
and by the agents in folders 02/03 (or 05).

  payment per reading   facilitator_tx_*.csv        vs  02_.../transactions_*.csv
  metered session       facilitator_metered_*.csv   vs  03_.../credit_*.csv
  message count         e9_*.csv (counting proxy)

Why this is not a duplicate of the earlier comparison of the direct and the
facilitator implementation: there, TWO DIFFERENT code bases were compared,
which was an acknowledged limitation. Here the merchant is the same in both
branches; only the topology differs.

READ THE RESULTS WITH CARE: the facilitator is LOCAL (self-hosted, on the same
host). The measured overhead is therefore a LOWER BOUND for a hosted
facilitator — the numbers contain no network distance. Likewise, this
experiment does NOT measure the costs of trust (availability, correctness, a
privileged observer): those do not arise with a self-run facilitator. What is
measured is the pure cost of the process boundary.

USAGE:
    pip install -r requirements.txt
    python3 facilitator_analysis.py                # finds the CSVs automatically
    python3 facilitator_analysis.py --mode real   # real measurements only
    python3 facilitator_analysis.py --out figures
"""
import argparse
import os
import sys
import glob

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from style import set_style, clean_axes, save, mark_sample, t, add_lang_flag, set_language, BLUE, ORANGE, AQUA, INK, INK2, MUTED

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))          # measurements/
MEASUREMENTS = os.path.abspath(os.path.join(HERE, "..", "measurements"))    # this folder's measurements


def find(*candidates):
    """First existing and NON-EMPTY CSV. An empty file (header only) counts as missing."""
    for p in candidates:
        for m in sorted(glob.glob(p)):
            try:
                if os.path.getsize(m) > 0 and len(pd.read_csv(m)) > 0:
                    return m
            except Exception:
                continue
    return None


def is_sample(path):
    """Is this SIMULATED sample data? Such data must be flagged, not used silently."""
    return path is not None and "_sample" in str(path)


def mode_of(csv_path, default_value="?"):
    """Read the mode (mock/real) from the `mode` column, not from the filename."""
    try:
        d = pd.read_csv(csv_path, nrows=5)
        if "mode" in d.columns and len(d):
            return str(d["mode"].iloc[0])
    except Exception:
        pass
    return default_value


def warn_about_source(label, path, our_mode):
    """Say it out loud when the comparison is not apples-to-apples. Staying silent would be worse."""
    sample = is_sample(path)
    their_mode = mode_of(path)
    if sample:
        print(f"  ⚠ {label}: SIMULATED sample data is being used ({os.path.basename(path)}).")
        print("    The figure will carry a watermark. For authoritative numbers run a real measurement.")
    if their_mode != our_mode:
        print(f"  ⚠ {label}: the modes differ (direct={their_mode}, facilitator={our_mode}).")
        print("    Protocol latency excludes waiting for the chain and thus remains comparable,")
        print("    but the difference also includes the difference between environments — state this when reporting.")
    return sample, their_mode


def permutation_test(a, b, iterations=20000, seed=20260819):
    """
    Two-sided permutation test of the difference of medians. No `scipy` (the
    package does not list it among its dependencies), yet still honest: it does
    not assume normality, and latencies are not normal. Returns (median_difference, p).
    """
    a = np.asarray(a, dtype=float); b = np.asarray(b, dtype=float)
    a = a[np.isfinite(a)]; b = b[np.isfinite(b)]
    if len(a) < 3 or len(b) < 3:
        return (float("nan"), float("nan"))
    observed = float(np.median(b) - np.median(a))
    pooled = np.concatenate([a, b])
    n = len(a)
    rng = np.random.default_rng(seed)
    greater = 0
    for _ in range(iterations):
        rng.shuffle(pooled)
        d = np.median(pooled[n:]) - np.median(pooled[:n])
        if abs(d) >= abs(observed) - 1e-12:
            greater += 1
    return (observed, (greater + 1) / (iterations + 1))


def summarise(x):
    x = np.asarray(x, dtype=float); x = x[np.isfinite(x)]
    if not len(x):
        return None
    return dict(n=int(len(x)), median=float(np.median(x)), mean=float(np.mean(x)),
                p95=float(np.percentile(x, 95)), min=float(x.min()), max=float(x.max()))


def boxplot_pair(ax, a, b, labels, colors=(BLUE, ORANGE)):
    bp = ax.boxplot([a, b], patch_artist=True, widths=0.55, showfliers=False,
                    medianprops=dict(color=INK, linewidth=1.6))
    for patch, c in zip(bp["boxes"], colors):
        patch.set_facecolor(c); patch.set_alpha(0.35); patch.set_edgecolor(c); patch.set_linewidth(1.4)
    for w in bp["whiskers"] + bp["caps"]:
        w.set_color(MUTED)
    # Set the tick labels separately: the parameter was renamed in matplotlib
    # (labels -> tick_labels in 3.9), while set_xticklabels works in all versions.
    ax.set_xticklabels(labels)
    return bp


# ══════════════════ Payment per reading ══════════════════════════════════════
def e7(mode, out, rows):
    facilitator_csv = find(os.path.join(MEASUREMENTS, f"facilitator_tx_{mode}.csv"),
                            os.path.join(MEASUREMENTS, "facilitator_tx_*.csv"))
    direct_csv = find(os.path.join(ROOT, "02_machine_payments_per_request", "measurements", f"transactions_{mode}.csv"),
                       os.path.join(ROOT, "02_machine_payments_per_request", "measurements", "transactions_*.csv"),
                       os.path.join(ROOT, "02_machine_payments_per_request", "measurements", "_sample", "transactions_*.csv"))
    if not facilitator_csv:
        print("  · payment per reading: facilitator_tx_*.csv missing (run: cd agent && npm run mock)")
        return
    print(f"  payment per reading, facilitator: {os.path.relpath(facilitator_csv, ROOT)}")
    p = pd.read_csv(facilitator_csv)
    p = p[p["event"].astype(str).str.startswith("query")]
    if not len(p):
        print("  · payment per reading: CSV has no query rows"); return

    # The share eaten by the hops to the facilitator.
    p["facilitator_total_ms"] = (p[["facilitator_challenge_ms", "facilitator_access_ms", "facilitator_report_ms"]]
                                .apply(pd.to_numeric, errors="coerce").fillna(0).sum(axis=1))
    # Protocol latency without waiting for the chain — this is the comparable quantity.
    p["protocol_ms"] = (pd.to_numeric(p["t_total_ms"], errors="coerce")
                        - pd.to_numeric(p["t_chain_ms"], errors="coerce").fillna(0))

    sP = summarise(p["protocol_ms"])
    rows.append(["payment per reading", mode, "facilitator", "protocol latency (ms)", sP["n"], sP["median"], sP["mean"], sP["p95"]])
    sPos = summarise(p["facilitator_total_ms"])
    rows.append(["payment per reading", mode, "facilitator", "of which facilitator (ms)", sPos["n"], sPos["median"], sPos["mean"], sPos["p95"]])

    # ── figure 1: breakdown by phase ─────────────────────────────────────────
    phases = [("t_challenge_ms", t("402 challenge\n(M→F→M)", "402 izziv\n(M→F→M)"), BLUE),
              ("t_report_ms", t("payment report\n(C→F→B)", "prijava plačila\n(C→F→B)"), ORANGE),
              ("t_access_ms", t("access\n(M→F→M)", "dostop\n(M→F→M)"), AQUA)]
    fig, ax = plt.subplots(figsize=(7.6, 4.4))
    med = [float(pd.to_numeric(p[k], errors="coerce").median()) for k, _, _ in phases]
    xs = np.arange(len(phases))
    ax.bar(xs, med, color=[c for _, _, c in phases], alpha=0.85, width=0.6)
    for x, v in zip(xs, med):
        ax.text(x, v, f"{v:.1f} ms", ha="center", va="bottom", fontsize=10, color=INK)
    ax.set_xticks(xs); ax.set_xticklabels([l for _, l, _ in phases])
    ax.set_ylabel(t("median (ms)", "mediana (ms)"))
    ax.set_title(t(f"Payment per reading · facilitator topology by phase ({mode})",
                   f"Plačilo na odčitek · posredniška topologija po fazah ({mode})"))
    ax.text(0.99, 0.97, t(f"of which waiting for the facilitator: {sPos['median']:.1f} ms",
                          f"od tega čakanje na posrednika: {sPos['median']:.1f} ms"),
            transform=ax.transAxes, ha="right", va="top", fontsize=9, color=INK2)
    clean_axes(ax); save(fig, os.path.join(out, f"e7_phases_{mode}.png"))

    if not direct_csv:
        print("  · payment per reading: no direct measurement (folder 02) — no comparison figure.")
        return
    print(f"  payment per reading, direct:  {os.path.relpath(direct_csv, ROOT)}")
    sample, other_mode = warn_about_source("payment per reading", direct_csv, mode)
    d = pd.read_csv(direct_csv)

    # Protocol latency = ALL phases EXCEPT waiting for the chain. Without that
    # subtraction we would compare ~92 ms of protocol against ~12 s of waiting
    # for a block, and the result would be nonsense.
    phases_without_chain = [c for c in ["t_challenge_ms", "t_verify_ms", "t_reading_ms"] if c in d.columns]
    if phases_without_chain:
        a = d[phases_without_chain].apply(pd.to_numeric, errors="coerce").sum(axis=1, min_count=1).dropna().values
        print(f"    (protocol latency summed from: {', '.join(phases_without_chain)})")
    elif "t_total_ms" in d.columns:
        a = pd.to_numeric(d["t_total_ms"], errors="coerce")
        for c in ["t_chain_ms", "t_confirm_ms", "t_submit_ms"]:
            if c in d.columns:
                a = a - pd.to_numeric(d[c], errors="coerce").fillna(0)
        a = a.dropna().values
    else:
        print("  · payment per reading: the direct CSV has no known latency columns."); return
    b = p["protocol_ms"].dropna().values
    if len(a) < 3:
        print("  · payment per reading: too few direct rows."); return

    difference, pval = permutation_test(a, b)
    sA = summarise(a)
    rows.append(["payment per reading", mode, "direct", "protocol latency (ms)", sA["n"], sA["median"], sA["mean"], sA["p95"]])
    rows.append(["payment per reading", mode, "difference", "facilitator − direct (ms)" + (" [SAMPLE]" if sample else ""), "", difference, "", f"p={pval:.2g}"])

    fig, ax = plt.subplots(figsize=(6.4, 4.6))
    boxplot_pair(ax, a, b, [t(f"direct (a)\nfolder 02 · {other_mode}", f"neposredna (a)\nmapa 02 · {other_mode}"),
                            t(f"facilitator (b)\nfolder 04 · {mode}", f"posredniška (b)\nmapa 04 · {mode}")])
    ax.set_ylabel(t("protocol latency (ms), excluding the chain wait",
                    "protokolna latenca (ms), brez čakanja na verigo"))
    ax.set_title(t(f"Payment per reading · effect of topology on latency ({mode})",
                   f"Plačilo na odčitek · vpliv topologije na latenco ({mode})"))
    ax.text(0.5, 0.02, t(f"Δmedian = {difference:+.1f} ms  ·  permutation test p = {pval:.2g}  ·  n = {len(a)} / {len(b)}",
                         f"Δmediana = {difference:+.1f} ms  ·  permutacijski test p = {pval:.2g}  ·  n = {len(a)} / {len(b)}"),
            transform=ax.transAxes, ha="center", va="bottom", fontsize=9, color=INK2)
    clean_axes(ax)
    mark_sample(sample)          # watermark only on THIS figure, if the direct side is sample data
    save(fig, os.path.join(out, f"e7_topology_{mode}.png"))
    mark_sample(False)


# ══════════════════ Metered session × facilitator ════════════════════════════
def e8(mode, out, rows):
    facilitator_csv = find(os.path.join(MEASUREMENTS, f"facilitator_metered_{mode}.csv"),
                            os.path.join(MEASUREMENTS, "facilitator_metered_*.csv"))
    direct_csv = find(os.path.join(ROOT, "03_machine_payments_prepaid", "measurements", f"credit_{mode}.csv"),
                       os.path.join(ROOT, "03_machine_payments_prepaid", "measurements", "credit_*.csv"),
                       os.path.join(ROOT, "03_machine_payments_prepaid", "measurements", "_sample", "credit_*.csv"))
    if not facilitator_csv:
        print("  · metered session: facilitator_metered_*.csv missing (run: cd agent && npm run mock-metered)")
        return
    print(f"  metered session, facilitator: {os.path.relpath(facilitator_csv, ROOT)}")
    p = pd.read_csv(facilitator_csv)
    p = p[p.get("kind", pd.Series(dtype=str)).astype(str) == "debit"]
    if not len(p):
        print("  · metered session: CSV has no debits"); return
    b = pd.to_numeric(p["t_request_ms"], errors="coerce").dropna().values
    b_facilitator = pd.to_numeric(p["facilitator_ms"], errors="coerce").fillna(0).values

    sB, sPos = summarise(b), summarise(b_facilitator)
    rows.append(["metered session", mode, "facilitator", "debit — round trip (ms)", sB["n"], sB["median"], sB["mean"], sB["p95"]])
    rows.append(["metered session", mode, "facilitator", "of which facilitator (ms)", sPos["n"], sPos["median"], sPos["mean"], sPos["p95"]])

    if not direct_csv:
        print("  · metered session: no direct measurement (folder 03) — no comparison figure.")
        return
    print(f"  metered session, direct:  {os.path.relpath(direct_csv, ROOT)}")
    sample, other_mode = warn_about_source("metered session", direct_csv, mode)
    d = pd.read_csv(direct_csv)
    d = d[d.get("kind", pd.Series(dtype=str)).astype(str) == "debit"]
    a = pd.to_numeric(d["t_request_ms"], errors="coerce").dropna().values
    if len(a) < 3:
        print("  · metered session: too few direct debits."); return

    difference, pval = permutation_test(a, b)
    sA = summarise(a)
    rows.append(["metered session", mode, "direct", "debit — round trip (ms)", sA["n"], sA["median"], sA["mean"], sA["p95"]])
    rows.append(["metered session", mode, "difference", "facilitator − direct (ms)" + (" [SAMPLE]" if sample else ""), "", difference, "", f"p={pval:.2g}"])
    share = 100.0 * difference / sA["median"] if sA["median"] else float("nan")

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.4, 4.6), gridspec_kw=dict(width_ratios=[1, 1]))
    boxplot_pair(ax1, a, b, [t(f"direct (a)\nfolder 03 · {other_mode}", f"neposredna (a)\nmapa 03 · {other_mode}"),
                             t(f"facilitator (b)\nfolder 04 · {mode}", f"posredniška (b)\nmapa 04 · {mode}")])
    ax1.set_ylabel(t("signed debit latency (ms)", "latenca podpisane bremenitve (ms)"))
    ax1.set_title(t("Metered session: one extra hop", "Merjena seja: en skok več"))
    ax1.text(0.5, 0.02, t(f"Δmedian = {difference:+.1f} ms ({share:+.0f} %)  ·  p = {pval:.2g}",
                          f"Δmediana = {difference:+.1f} ms ({share:+.0f} %)  ·  p = {pval:.2g}"),
             transform=ax1.transAxes, ha="center", va="bottom", fontsize=9, color=INK2)
    clean_axes(ax1)

    # What the facilitator debit is made of.
    label_b = t("facilitator (b)", "posredniška (b)")
    merchant = pd.to_numeric(p["server_ms"], errors="coerce").fillna(0).values
    own = np.maximum(merchant - b_facilitator, 0)
    network = np.maximum(b - merchant, 0)
    ax2.bar([label_b], [np.median(network)], color=MUTED, alpha=0.7, label=t("network client↔merchant", "omrežje odjemalec↔trgovec"))
    ax2.bar([label_b], [np.median(own)], bottom=[np.median(network)], color=BLUE, alpha=0.85, label=t("merchant work", "delo trgovca"))
    ax2.bar([label_b], [np.median(b_facilitator)], bottom=[np.median(network) + np.median(own)], color=ORANGE, alpha=0.9, label=t("waiting for the facilitator", "čakanje na posrednika"))
    ax2.axhline(np.median(a), color=INK, linestyle="--", linewidth=1.2)
    ax2.text(0.02, np.median(a), t(f"  direct median {np.median(a):.1f} ms",
                                   f"  neposredna mediana {np.median(a):.1f} ms"),
             va="bottom", fontsize=9, color=INK2)
    ax2.set_ylabel(t("median (ms)", "mediana (ms)"))
    ax2.set_title(t("What it is made of", "Iz česa je sestavljena"))
    ax2.legend(frameon=False, fontsize=9, loc="upper left")
    clean_axes(ax2)
    mark_sample(sample)
    save(fig, os.path.join(out, f"e8_metered_topology_{mode}.png"))
    mark_sample(False)


# ══════════════════ Message counting ═════════════════════════════════════════
def e9(out, rows):
    files = sorted(glob.glob(os.path.join(MEASUREMENTS, "e9_*.csv")))
    if not files:
        print("  · message counting: no e9_*.csv (run the counting proxy, see ../README.md)")
        return
    groups = {}
    for f in files:
        try:
            d = pd.read_csv(f)
        except Exception:
            continue
        # ONLY payment exchanges are counted: preparatory routes (/config, /health)
        # and long-lived SSE streams are not part of the payment flow.
        if "payment" in d.columns:
            d = d[pd.to_numeric(d["payment"], errors="coerce").fillna(0) == 1]
        elif "flow" in d.columns:
            d = d[pd.to_numeric(d["flow"], errors="coerce").fillna(0) == 0]
        label = os.path.basename(f)[3:-4]
        groups[label] = len(d)
        print(f"  message counting, {label}: {len(d)} exchanges / {2 * len(d)} messages")

    direct = sum(v for k, v in groups.items() if "direct" in k)
    facilitator = sum(v for k, v in groups.items() if "direct" not in k)
    for name, exchanges in (("direct", direct), ("facilitator", facilitator)):
        if exchanges:
            rows.append(["message count", "-", name, "exchanges / messages", exchanges, exchanges, 2 * exchanges, ""])
    if not (direct and facilitator):
        print("  · message counting: the comparison figure needs both branches (e9_direct.csv + e9_merchant.csv/e9_facilitator.csv)")
        return

    fig, ax = plt.subplots(figsize=(6.6, 4.4))
    xs = np.arange(2)
    exchanges = [direct, facilitator]; messages = [2 * direct, 2 * facilitator]
    ax.bar(xs - 0.18, exchanges, width=0.34, color=BLUE, alpha=0.85, label=t("exchanges", "izmenjave"))
    ax.bar(xs + 0.18, messages, width=0.34, color=ORANGE, alpha=0.85, label=t("messages (HTTP)", "sporočila (HTTP)"))
    for x, v in zip(xs - 0.18, exchanges):
        ax.text(x, v, str(v), ha="center", va="bottom", fontsize=10, color=INK)
    for x, v in zip(xs + 0.18, messages):
        ax.text(x, v, str(v), ha="center", va="bottom", fontsize=10, color=INK)
    ax.set_xticks(xs); ax.set_xticklabels([t("direct (a)\nfolder 05", "neposredna (a)\nmapa 05"),
                                           t("facilitator (b)\nfolder 04", "posredniška (b)\nmapa 04")])
    ax.set_ylabel(t("count per payment", "število na eno plačilo"))
    ax.set_title(t("Messages per payment flow", "Sporočila na plačilni tok"))
    ax.legend(frameon=False, fontsize=9)
    clean_axes(ax); save(fig, os.path.join(out, "e9_messages.png"))


def main():
    ap = argparse.ArgumentParser(description="Facilitator-branch analysis (payment per reading, metered session, message counting)")
    ap.add_argument("--mode", default=None, choices=["mock", "real"], help="only one mode (default: both, whatever is found)")
    ap.add_argument("--out", default=os.path.join(HERE, "figures"))
    add_lang_flag(ap)
    a = ap.parse_args()
    set_language("sl" if a.sl else "en")
    set_style()
    os.makedirs(a.out, exist_ok=True)

    modes = [a.mode] if a.mode else ["real", "mock"]
    rows = []
    print("Facilitator-branch analysis (topology b)\n")
    for n in modes:
        if not (glob.glob(os.path.join(MEASUREMENTS, f"facilitator_*_{n}.csv"))):
            continue
        print(f"── mode: {n} ──")
        e7(n, a.out, rows)
        e8(n, a.out, rows)
    e9(a.out, rows)

    if not rows:
        print("\nNo measurements. Run the agents first:")
        print("  cd ../facilitator && npm run mock            # facilitator")
        print("  cd ../server  && npm run mock            # merchant")
        print("  cd ../agent && npm run mock && npm run mock-metered")
        sys.exit(1)

    # CSV column headers stay plain English so the CSV output does not vary by language.
    tab = pd.DataFrame(rows, columns=["experiment", "mode", "topology", "quantity", "n", "median", "mean", "p95"])
    path = os.path.join(a.out, "facilitator_summary.csv")
    tab.to_csv(path, index=False)
    print(f"\n  ✓ table: {path}")
    print(tab.to_string(index=False))
    print("\nNOTE: the facilitator is LOCAL, so these numbers are a LOWER BOUND")
    print("for a hosted facilitator (they contain no network distance), and the costs of trust")
    print("do not arise in this experiment at all — see the introductory comment of this script.")


if __name__ == "__main__":
    main()
