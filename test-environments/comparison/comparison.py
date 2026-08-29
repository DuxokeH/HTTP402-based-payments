#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
COMPARISON of the two machine payment modes (scenarios 02 and 03).

Reads the CSVs from folder 02 (1 transaction/query) and folder 03 (metered
session) and plots:
  1. cumulative settlement cost as a function of N (costly rising line vs. flat),
  2. amortisation — effective on-chain cost per request (C_topup / N),
  3. latency comparison: on-chain query vs. off-chain signed debit,
  4. table: number of external transactions and effective cost at N uses.

If the CSV has no real gas data, the cost is MODELLED (--gas-price-gwei) and
labelled as such.

Usage:
  python3 comparison.py
  python3 comparison.py --horizon 100 --gas-price-gwei 2
"""
import os, sys, argparse
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from style import set_style, clean_axes, save, mark_sample, t, add_lang_flag, set_language, BLUE, ORANGE, AQUA, INK, INK2, MUTED
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GWEI = 1_000_000_000

def find(folder, names):
    d = os.path.join(ROOT, folder, "measurements")
    for n in names:
        p = os.path.join(d, n)
        if os.path.exists(p):
            return p
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--horizon", type=int, default=50, help="largest N the charts should extend to")
    ap.add_argument("--gas-price-gwei", type=float, default=2.0)
    ap.add_argument("--gas-per-tx", type=int, default=21000)
    ap.add_argument("--out", default=os.path.join(HERE, "figures"))
    ap.add_argument("--sample", action="store_true", help="add a 'SIMULATED EXAMPLE' watermark")
    add_lang_flag(ap)
    args = ap.parse_args()
    set_language("sl" if args.sl else "en")
    set_style()

    tx_csv = find("02_machine_payments_per_request", ["transactions_real.csv", "transactions_mock.csv", "_sample/transactions_real.csv"])
    db_csv = find("03_machine_payments_prepaid", ["credit_real.csv", "credit_mock.csv", "_sample/credit_real.csv"])
    if not tx_csv or not db_csv:
        print("CSV measurements are missing. Run folders 02 and 03 (npm run mock) or generate a sample."); sys.exit(1)
    if args.sample or "_sample" in str(tx_csv) or "_sample" in str(db_csv):
        mark_sample(True)
    print(f"Folder 02: {tx_csv}\nFolder 03: {db_csv}")

    tx = pd.read_csv(tx_csv); db = pd.read_csv(db_csv)
    tx["fee_eth"] = pd.to_numeric(tx.get("fee_eth"), errors="coerce")
    tx["t_total_ms"] = pd.to_numeric(tx.get("t_total_ms"), errors="coerce")
    deb = db[db["kind"] == "debit"].copy()
    deb["t_total_ms"] = pd.to_numeric(deb.get("t_total_ms"), errors="coerce")
    topup = db[db["kind"] == "topup"]
    topup_fee_eth = pd.to_numeric(topup.get("fee_eth"), errors="coerce").dropna()

    modelled = tx["fee_eth"].notna().sum() == 0
    if modelled:
        fee_tx = args.gas_per_tx * args.gas_price_gwei / 1e9
        fee_topup = fee_tx
        label = f"modelled @ {args.gas_price_gwei:g} gwei"
        label_sl = f"modelirano @ {args.gas_price_gwei:g} gwei"
    else:
        fee_tx = float(tx["fee_eth"].dropna().mean())
        fee_topup = float(topup_fee_eth.iloc[0]) if len(topup_fee_eth) else fee_tx
        label = "measured"
        label_sl = "izmerjeno"

    Nmeas = int(len(deb))
    N = np.arange(1, args.horizon + 1)
    cost_tx = fee_tx * N            # 1 tx per request
    cost_session = np.full_like(N, fee_topup, dtype=float)  # single top-up, flat

    # ── Figure 1: cumulative settlement cost ─────────────────────────────────
    fig, ax = plt.subplots(figsize=(8.4, 4.8))
    ax.plot(N, cost_tx, color=ORANGE, linewidth=2.4, label=t("1 transaction / query (folder 02)", "1 transakcija / poizvedbo (mapa 02)"))
    ax.plot(N, cost_session, color=BLUE, linewidth=2.4, label=t("metered session: 1 top-up (folder 03)", "merjena seja: 1 polnitev (mapa 03)"))
    ax.axvline(Nmeas, color=MUTED, linestyle=":", linewidth=1)
    ax.text(Nmeas, ax.get_ylim()[1] * 0.30, t(f" measured\n N={Nmeas}", f" izmerjeno\n N={Nmeas}"), color=INK2, fontsize=9, va="center")
    ax.set_xlabel(t("number of readings N", "število odčitkov N")); ax.set_ylabel(t("cumulative settlement cost [ETH]", "kumulativni strošek poravnave [ETH]"))
    ax.set_title(t("Cumulative settlement cost: N transactions vs. a single top-up", "Kumulativni strošek poravnave: N transakcij vs. ena polnitev"))
    ax.legend(loc="upper left"); clean_axes(ax)
    if modelled:
        ax.text(0.99, 0.02, t("cost MODELLED (no real gas data)", "strošek MODELIRAN (brez pravega gasa)"), transform=ax.transAxes, ha="right", va="bottom", fontsize=8, color=MUTED, style="italic")
    save(fig, os.path.join(args.out, "01_cumulative_cost.png"))

    # ── Figure 2: amortisation — effective cost per request ──────────────────
    fig, ax = plt.subplots(figsize=(8.4, 4.8))
    ax.plot(N, np.full_like(N, fee_tx, dtype=float), color=ORANGE, linewidth=2.4, label=t("1 tx/query: cost/request = const.", "1 tx/poizvedbo: strošek/zahtevo = konst."))
    ax.plot(N, fee_topup / N, color=BLUE, linewidth=2.4, label=t("metered session: cost/request = C_topup / N", "merjena seja: strošek/zahtevo = C_polnitev / N"))
    ax.scatter([Nmeas], [fee_topup / Nmeas], color=BLUE, zorder=4, s=40)
    ax.annotate(t(f"at N={Nmeas}:\n{fee_topup/Nmeas:.3e} ETH/request\n(factor {fee_tx/(fee_topup/Nmeas):.0f}× cheaper)",
                  f"pri N={Nmeas}:\n{fee_topup/Nmeas:.3e} ETH/zahtevo\n(faktor {fee_tx/(fee_topup/Nmeas):.0f}× ceneje)"),
                xy=(Nmeas, fee_topup / Nmeas), xytext=(20, 30), textcoords="offset points",
                color=INK2, fontsize=9, arrowprops=dict(arrowstyle="->", color=MUTED))
    ax.set_yscale("log"); ax.set_xlabel(t("number of readings N", "število odčitkov N")); ax.set_ylabel(t("effective on-chain cost per request [ETH] (log)", "efektivni on-chain strošek na zahtevo [ETH] (log)"))
    ax.set_title(t("Amortisation of the fixed settlement cost (C_debit = C_topup / N)", "Amortizacija fiksnega stroška poravnave (C_debit = C_polnitev / N)"))
    ax.legend(loc="upper right"); clean_axes(ax)
    if modelled:
        ax.text(0.99, 0.02, t("modelled", "modelirano"), transform=ax.transAxes, ha="right", va="bottom", fontsize=8, color=MUTED, style="italic")
    save(fig, os.path.join(args.out, "02_amortization.png"))

    # ── Figure 3: latency — on-chain query vs off-chain debit ────────
    fig, ax = plt.subplots(figsize=(7.6, 4.8))
    a = tx["t_total_ms"].dropna().values
    b = deb["t_total_ms"].dropna().values
    # Set the tick labels separately: the parameter was renamed in matplotlib
    # (labels -> tick_labels in 3.9), while set_xticklabels works in all versions.
    bp = ax.boxplot([a, b], patch_artist=True, widths=0.5, medianprops=dict(color=INK2, linewidth=1.6))
    ax.set_xticklabels([t("on-chain query\n(folder 02)", "on-chain poizvedba\n(mapa 02)"), t("off-chain debit\n(folder 03)", "off-chain bremenitev\n(mapa 03)")])
    bp["boxes"][0].set(facecolor=ORANGE, alpha=0.8, edgecolor=ORANGE)
    bp["boxes"][1].set(facecolor=BLUE, alpha=0.8, edgecolor=BLUE)
    for w in bp["whiskers"]: w.set(color=MUTED)
    for cp in bp["caps"]: cp.set(color=MUTED)
    ax.set_yscale("log"); ax.set_ylabel(t("time [ms] (log scale)", "čas [ms] (logaritemska skala)"))
    ratio = (np.median(a) / np.median(b)) if len(a) and len(b) and np.median(b) > 0 else float("nan")
    ax.set_title(t(f"Latency: on-chain vs. off-chain  (median {np.median(a):.0f} ms vs {np.median(b):.2f} ms ≈ {ratio:.0f}×)",
                   f"Latenca: on-chain vs. off-chain  (mediana {np.median(a):.0f} ms vs {np.median(b):.2f} ms ≈ {ratio:.0f}×)"))
    clean_axes(ax)
    save(fig, os.path.join(args.out, "03_latency_comparison.png"))

    # ── table: number of settlements and effective cost at N ──────────────────
    rows = []
    for n in sorted(set([1, 5, 10, Nmeas, 50, 100, 1000])):
        rows.append([n, n, f"{fee_tx*n:.6f}", 1, f"{fee_topup:.6f}", f"{fee_topup/n:.3e}", f"{fee_tx/(fee_topup/n):.0f}×"])
    # CSV headers stay plain English regardless of --sl; only the rendered figure table is translated.
    cols_en = ["N uses", "one-time: tx count", "one-time: total ETH", "metered: tx count", "metered: total ETH", "metered: ETH/request", "ratio/request"]
    cols_sl = ["N uporab", "enkr.: št. tx", "enkr.: skupaj ETH", "merj.: št. tx", "merj.: skupaj ETH", "merj.: ETH/zahtevo", "razmerje/zahtevo"]
    tab = pd.DataFrame(rows, columns=cols_en)
    os.makedirs(args.out, exist_ok=True)
    tab.to_csv(os.path.join(args.out, "cost_comparison.csv"), index=False)
    print(f"  ✓ table: {os.path.join(args.out, 'cost_comparison.csv')}")

    fig, ax = plt.subplots(figsize=(9.5, 0.5 + 0.4 * len(tab)))
    ax.axis("off")
    tbl = ax.table(cellText=tab.values, colLabels=[t(en, sl) for en, sl in zip(cols_en, cols_sl)], cellLoc="center", loc="center")
    tbl.auto_set_font_size(False); tbl.set_fontsize(8.5); tbl.scale(1, 1.4)
    for (r, cc), cell in tbl.get_celld().items():
        cell.set_edgecolor("#e1e0d9")
        if r == 0: cell.set_facecolor(BLUE); cell.set_text_props(color="white", fontweight="bold")
        elif int(tab.iloc[r-1, 0]) == Nmeas: cell.set_facecolor("#eef4fc")
    ax.set_title(t(f"Settlements and cost at N uses ({label})", f"Poravnave in strošek pri N uporabah ({label_sl})"), fontsize=11, fontweight="bold", pad=12)
    save(fig, os.path.join(args.out, "04_cost_table.png"))

    print(f"\nSummary ({label}):")
    print(f"  cost/tx ≈ {fee_tx:.8f} ETH · top-up cost ≈ {fee_topup:.8f} ETH")
    print(f"  at N={Nmeas}: one-time {fee_tx*Nmeas:.6f} ETH vs metered {fee_topup:.6f} ETH → {fee_tx*Nmeas/fee_topup:.1f}× less settlement cost")
    if len(a) and len(b):
        print(f"  latency: on-chain median {np.median(a):.0f} ms vs off-chain {np.median(b):.2f} ms ≈ {ratio:.0f}× faster")
    print("Done.")

if __name__ == "__main__":
    main()
