#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Comparison of the x402 branches against the existing custom branches — NEW
figures; the existing analyses are left untouched.

Reads the NEW files:
  01/measurements/x402_enkratna_{mode}.csv      (x402-self, one-time)
  02/measurements/x402_transakcije_{mode}.csv   (x402-self, per reading)
  03/measurements/x402_dobroimetje_{mode}.csv   (x402-self top-up + local debits)
  04/measurements/x402_facilitator_tx_{mode}.csv  (x402-facilitated)
and places them next to the existing ones (one_time_*, transactions_*, credit_*,
facilitator_tx_*) whenever those exist.

⚠ METHODOLOGY WARNING (always printed, and burned into the figure):
the custom-* and x402-* branches share the network and the denomination
(Ethereum Sepolia, ETH); the remaining differences are the protocol, the kind
of transaction (EIP-3009 authorization — in the mock configuration the
settlement is synthetic) and the gas payer. The x402 mock delays exclude the
on-chain settlement time — do not attribute the differences to the x402
protocol alone.
"""
import argparse
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from style import (AQUA, BLUE, MUTED, ORANGE, set_style, clean_axes,
                  mark_sample, save, t, add_lang_flag, set_language)  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402

set_style()
BLUE, ORANGE = BLUE, ORANGE


def new_figure():
    fig, ax = plt.subplots(figsize=(7.5, 4.6))
    return fig, ax


def gridlines(ax):
    clean_axes(ax)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def warning_text():
    """Methodology warning shown on every figure and printed to the console.

    This is a function, not a module constant, so that t() runs after
    set_language() has seen the --sl flag (same reason as the deferred labels
    in the other analysis scripts).
    """
    return t("The branches share the network and the denomination; differences: "
             "protocol, kind of transaction (EIP-3009 authorization, synthetic "
             "settlement in mock) and gas payer.",
             "Kraka delita omrežje in denominacijo; razlike: protokol, vrsta "
             "transakcije (EIP-3009 pooblastilo, v mock sintetična poravnava) "
             "in plačnik gasa.")


KOREN_ = ROOT

NETWORKS = {"eip155:11155111": "Ethereum Sepolia", "eip155:84532": "Base Sepolia"}


def _zadnja(df, stolpec, privzeto=""):
    """Value of a column taken from the last row (the CSV is appended to — the last run wins)."""
    if df is not None and stolpec in df.columns:
        v = df[stolpec].dropna()
        if len(v):
            return str(v.iloc[-1])
    return privzeto


def branch_label(ime, df):
    asset = _zadnja(df, "asset", "?")
    network = NETWORKS.get(_zadnja(df, "network"), _zadnja(df, "network", "?"))
    gas = _zadnja(df, "gas_payer", "?")
    return f"{ime}\n({asset} · {network}\n· gas: {gas})"


def find_file(path):
    p = os.path.join(KOREN_, path)
    if os.path.exists(p):
        try:
            df = pd.read_csv(p)
            if len(df):
                return df, p
        except Exception:
            pass
    return None, None


def stamp_warning(ax):
    ax.text(0.99, 0.02, warning_text(), transform=ax.transAxes, ha="right",
            va="bottom", fontsize=7, color=MUTED, style="italic", wrap=True)


def check_synthetic(df, oznaka):
    if "synthetic_tx" in df.columns and df["synthetic_tx"].fillna(0).astype(int).any():
        print(f"  ⚠ {oznaka}: contains SYNTHETIC settlements (mock, 0x6d6f636b…) — the figure gets a watermark.")
        return True
    if "mode" in df.columns and (df["mode"] == "mock").any():
        print(f"  ⚠ {oznaka}: contains mock rows — the figure gets a watermark.")
        return True
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mode", default="mock", choices=["mock", "real"])
    ap.add_argument("--sample", action="store_true", help="add a 'SIMULATED EXAMPLE' watermark")
    add_lang_flag(ap)
    args = ap.parse_args()
    set_language("sl" if args.sl else "en")
    n = args.mode

    out = os.path.join(HERE, "figures")
    os.makedirs(out, exist_ok=True)

    print(f"Comparison of the x402 branches · mode={n}")
    print(f"⚠ {warning_text()}\n")

    # ── 1) one-time: custom-direct vs x402-self (total time) ─────────────────
    cd, cdp = find_file(f"01_one_time_payments/measurements/one_time_{n}.csv")
    xs, xsp = find_file(f"01_one_time_payments/measurements/x402_enkratna_{n}.csv")
    if xs is not None:
        vz = args.vzorec or check_synthetic(xs, "x402 one_time")
        if cd is not None:
            vz = vz or ("mode" in cd.columns and (cd["mode"] == "mock").any())
        mark_sample(vz)
        fig, ax = new_figure()
        skupine, oznake, barve = [], [], []
        if cd is not None and "t_total_ms" in cd.columns:
            skupine.append(cd["t_total_ms"].dropna())
            oznake.append(t("custom-direct\n(ETH · Ethereum Sepolia\n· gas: client)",
                            "custom-direct\n(ETH · Ethereum Sepolia\n· gas: odjemalec)"))
            barve.append(ORANGE)
        skupine.append(xs["t_total_ms"].dropna())
        oznake.append(branch_label("x402-self", xs))
        barve.append(BLUE)
        bp = ax.boxplot(skupine, labels=oznake, patch_artist=True, showfliers=False)
        for patch, c in zip(bp["boxes"], barve):
            patch.set_facecolor(c)
            patch.set_alpha(0.6)
        ax.set_ylabel(t("t_total [ms]", "t_skupaj [ms]"))
        ax.set_title(t(f"One-time payment: custom protocol vs. x402 v2 ({n})",
                       f"Enkratno plačilo: lastni protokol proti x402 v2 ({n})"))
        gridlines(ax)
        stamp_warning(ax)
        save(fig, os.path.join(out, f"x402_01_one_time_{n}.png"))
        mark_sample(False)
    else:
        print(f"  – x402 one_time ({n}): no measurements yet — run 01/client: node measurement_client.js --x402")

    # ── 2) per reading: cumulative consumer cost (separate units!) ───────────
    xt, _ = find_file(f"02_machine_payments_per_request/measurements/x402_transakcije_{n}.csv")
    if xt is not None and "cumulative_atomic" in xt.columns:
        vz = args.vzorec or check_synthetic(xt, "x402 transactions")
        mark_sample(vz)
        fig, ax = new_figure()
        enota = _zadnja(xt, "asset", "?")
        dec = int(float(_zadnja(xt, "decimals", "18") or 18))
        ax.plot(xt.index + 1, xt["cumulative_atomic"].astype(float) / 10**dec, marker="o",
                color=BLUE, label=t(f"x402-self: consumer payment [{enota}]",
                                    f"x402-self: plačilo potrošnika [{enota}]"))
        ax.set_xlabel(t("reading N", "odčitek N"))
        ax.set_ylabel(t(f"cumulative payment [{enota}]", f"kumulativno plačilo [{enota}]"))
        ax.set_title(t(f"x402 per reading: the cost grows linearly with N ({n})",
                       f"x402 na odčitek: strošek raste linearno z N ({n})"))
        ax.legend()
        gridlines(ax)
        placnik = _zadnja(xt, 'gas_payer', t("server", "strežnik")).upper()
        ax.text(0.99, 0.10, t(f"The gas for all settlements is paid by {placnik} —\n"
                              "it is not included in this curve and is not comparable "
                              "with the folder 02 curve.",
                              f"Gas vseh poravnav plača {placnik} —\n"
                              "ni vštet v to krivuljo in ni primerljiv s krivuljo mape 02."),
                transform=ax.transAxes, ha="right", va="bottom", fontsize=7,
                color=MUTED, style="italic")
        stamp_warning(ax)
        save(fig, os.path.join(out, f"x402_02_cumulative_{n}.png"))
        mark_sample(False)
    else:
        print(f"  – x402 transactions ({n}): no measurements yet — run 02/agent: node agent.js --x402")

    # ── 3) metered session: debits are local in BOTH branches ───────────────
    xd, _ = find_file(f"03_machine_payments_prepaid/measurements/x402_dobroimetje_{n}.csv")
    dd, _ = find_file(f"03_machine_payments_prepaid/measurements/credit_{n}.csv")
    if xd is not None:
        vz = args.vzorec or check_synthetic(xd, "x402 credit")
        mark_sample(vz)
        fig, ax = new_figure()
        skupine, oznake, barve = [], [], []
        if dd is not None and "kind" in dd.columns:
            deb = dd[dd["kind"] == "debit"]["t_request_ms"].dropna()
            if len(deb):
                skupine.append(deb)
                oznake.append(t("ETH top-up\n→ local debits", "ETH polnitev\n→ lokalne bremenitve"))
                barve.append(ORANGE)
        deb_x = xd[xd["kind"] == "debit"]["t_request_ms"].dropna()
        skupine.append(deb_x)
        oznake.append(t(f"x402/{_zadnja(xd, 'asset', '?')} top-up\n→ local debits",
                        f"x402/{_zadnja(xd, 'asset', '?')} polnitev\n→ lokalne bremenitve"))
        barve.append(BLUE)
        bp = ax.boxplot(skupine, labels=oznake, patch_artist=True, showfliers=False)
        for patch, c in zip(bp["boxes"], barve):
            patch.set_facecolor(c)
            patch.set_alpha(0.6)
        ax.set_ylabel(t("t_request (local debit) [ms]", "t_zahteva (lokalna bremenitev) [ms]"))
        ax.set_title(t(f"Metered session: debits are local regardless of the top-up source ({n})",
                       f"Merjena seja: bremenitve so lokalne ne glede na vir polnitve ({n})"))
        gridlines(ax)
        ax.text(0.99, 0.10, t("Debits in BOTH branches run without the chain (EIP-191);\n"
                              "only the session funding differs.",
                              "Bremenitve v OBEH krakih tečejo brez verige (EIP-191);\n"
                              "razlikuje se samo financiranje seje."),
                transform=ax.transAxes, ha="right", va="bottom", fontsize=7,
                color=MUTED, style="italic")
        save(fig, os.path.join(out, f"x402_03_debits_{n}.png"))
        mark_sample(False)
    else:
        print(f"  – x402 credit ({n}): no measurements yet — run 03/agent: node agent.js --x402")

    # ── 4) topology: x402-self (05/01) vs x402-facilitated (04) ─────────────
    xp, _ = find_file(f"04_website_facilitator/measurements/x402_facilitator_tx_{n}.csv")
    if xp is not None and xs is not None:
        vz = args.vzorec or check_synthetic(xp, "x402 facilitator")
        mark_sample(vz)
        fig, ax = new_figure()
        bp = ax.boxplot(
            [xs["t_payment_http_ms"].dropna(), xp["t_payment_http_ms"].dropna()],
            labels=[t("x402-self\n(direct)", "x402-self\n(neposredno)"),
                    t("x402-facilitated\n(via a facilitator)", "x402-facilitated\n(prek posrednika)")],
            patch_artist=True, showfliers=False)
        for patch, c in zip(bp["boxes"], [BLUE, ORANGE]):
            patch.set_facecolor(c)
            patch.set_alpha(0.6)
        ax.set_ylabel(t("t_payment (verify+settle+source) [ms]", "t_placilo (verify+settle+vir) [ms]"))
        ax.set_title(t(f"x402: direct vs. facilitated topology ({n})",
                       f"x402: neposredna proti facilitirani topologiji ({n})"))
        gridlines(ax)
        ax.text(0.99, 0.10, t("Local facilitator: the measurement excludes the WAN delays\n"
                              "that a remotely hosted facilitator would incur.",
                              "Lokalni posrednik: meritev izključuje WAN zakasnitve,\n"
                              "ki bi jih imel oddaljeno gostovani facilitator."),
                transform=ax.transAxes, ha="right", va="bottom", fontsize=7,
                color=MUTED, style="italic")
        save(fig, os.path.join(out, f"x402_04_topology_{n}.png"))
        mark_sample(False)
    else:
        print(f"  – topology comparison ({n}): needs the x402 branches from folders 01 and 04")

    print("\nDone. Figures: comparison/figures/x402_*.png")
    print(f"⚠ Again: {warning_text()}")


if __name__ == "__main__":
    main()
