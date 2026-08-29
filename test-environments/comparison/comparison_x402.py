#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Primerjava x402 krakov z obstoječimi lastnimi kraki — NOVE slike, obstoječe
analize so nedotaknjene.

Bere NOVE datoteke:
  01/meritve/x402_enkratna_{nacin}.csv      (x402-self, enkratno)
  02/meritve/x402_transakcije_{nacin}.csv   (x402-self, na odčitek)
  03/meritve/x402_dobroimetje_{nacin}.csv   (x402-self polnitev + lokalne bremenitve)
  04/meritve/x402_posrednik_tx_{nacin}.csv  (x402-facilitated)
in jih postavi ob obstoječe (enkratna_*, transakcije_*, dobroimetje_*,
posrednik_tx_*), kadar te obstajajo.

⚠ METODOLOŠKO OPOZORILO (izpiše se vedno in je vžgano v sliko):
kraka custom-* in x402-* delita omrežje in denominacijo (Ethereum
Sepolia, ETH); preostale razlike so protokol, vrsta transakcije
(EIP-3009 pooblastilo — v mock konfiguraciji je poravnava sintetična)
in plačnik gasa. Mock zakasnitve x402 izključujejo čas poravnave na
verigi — razlik ne pripisuj zgolj protokolu x402.
"""
import argparse
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slog import (AKVA, MODRA, MUTED, ORANZNA, nastavi_slog, ocisti_osi,
                  oznaci_vzorec, shrani)  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402

nastavi_slog()
BLUE, ORANGE = MODRA, ORANZNA


def nova_slika():
    fig, ax = plt.subplots(figsize=(7.5, 4.6))
    return fig, ax


def gridnice(ax):
    ocisti_osi(ax)

TU = os.path.dirname(os.path.abspath(__file__))
KOREN = os.path.dirname(TU)

OPOZORILO = ("Kraka delita omrežje in denominacijo; razlike: protokol, vrsta "
             "transakcije (EIP-3009 pooblastilo, v mock sintetična poravnava) "
             "in plačnik gasa.")


KOREN_ = KOREN

OMREZJA = {"eip155:11155111": "Ethereum Sepolia", "eip155:84532": "Base Sepolia"}


def _zadnja(df, stolpec, privzeto=""):
    """Vrednost stolpca iz zadnje vrstice (CSV se dopolnjuje — velja zadnja serija)."""
    if df is not None and stolpec in df.columns:
        v = df[stolpec].dropna()
        if len(v):
            return str(v.iloc[-1])
    return privzeto


def oznaka_kraka(ime, df):
    sredstvo = _zadnja(df, "sredstvo", "?")
    omrezje = OMREZJA.get(_zadnja(df, "omrezje"), _zadnja(df, "omrezje", "?"))
    gas = _zadnja(df, "placnik_gasa", "?")
    return f"{ime}\n({sredstvo} · {omrezje}\n· gas: {gas})"


def poisci(pot):
    p = os.path.join(KOREN_, pot)
    if os.path.exists(p):
        try:
            df = pd.read_csv(p)
            if len(df):
                return df, p
        except Exception:
            pass
    return None, None


def zig_opozorilo(ax):
    ax.text(0.99, 0.02, OPOZORILO, transform=ax.transAxes, ha="right",
            va="bottom", fontsize=7, color=MUTED, style="italic", wrap=True)


def preveri_sinteticnost(df, oznaka):
    if "sinteticni_tx" in df.columns and df["sinteticni_tx"].fillna(0).astype(int).any():
        print(f"  ⚠ {oznaka}: vsebuje SINTETIČNE poravnave (mock, 0x6d6f636b…) — slika dobi vodni žig.")
        return True
    if "nacin" in df.columns and (df["nacin"] == "mock").any():
        print(f"  ⚠ {oznaka}: vsebuje mock vrstice — slika dobi vodni žig.")
        return True
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--nacin", default="mock", choices=["mock", "real"])
    ap.add_argument("--vzorec", action="store_true", help="dodaj vodni žig 'SIMULIRANI PRIMER'")
    args = ap.parse_args()
    n = args.nacin

    out = os.path.join(TU, "slike")
    os.makedirs(out, exist_ok=True)

    print(f"Primerjava x402 krakov · nacin={n}")
    print(f"⚠ {OPOZORILO}\n")

    # ── 1) enkratno: custom-direct vs x402-self (skupni čas) ─────────────────
    cd, cdp = poisci(f"01_enkratna_placila/meritve/enkratna_{n}.csv")
    xs, xsp = poisci(f"01_enkratna_placila/meritve/x402_enkratna_{n}.csv")
    if xs is not None:
        vz = args.vzorec or preveri_sinteticnost(xs, "x402 enkratna")
        if cd is not None:
            vz = vz or ("nacin" in cd.columns and (cd["nacin"] == "mock").any())
        oznaci_vzorec(vz)
        fig, ax = nova_slika()
        skupine, oznake, barve = [], [], []
        if cd is not None and "t_skupaj_ms" in cd.columns:
            skupine.append(cd["t_skupaj_ms"].dropna())
            oznake.append("custom-direct\n(ETH · Ethereum Sepolia\n· gas: odjemalec)")
            barve.append(ORANGE)
        skupine.append(xs["t_skupaj_ms"].dropna())
        oznake.append(oznaka_kraka("x402-self", xs))
        barve.append(BLUE)
        bp = ax.boxplot(skupine, labels=oznake, patch_artist=True, showfliers=False)
        for patch, c in zip(bp["boxes"], barve):
            patch.set_facecolor(c)
            patch.set_alpha(0.6)
        ax.set_ylabel("t_skupaj [ms]")
        ax.set_title(f"Enkratno plačilo: lastni protokol proti x402 v2 ({n})")
        gridnice(ax)
        zig_opozorilo(ax)
        shrani(fig, os.path.join(out, f"x402_01_enkratno_{n}.png"))
        oznaci_vzorec(False)
    else:
        print(f"  – x402 enkratna ({n}): še ni meritev — poženi 01/klient: node merilni_klient.js --x402")

    # ── 2) na odčitek: kumulativni strošek potrošnika (ločeni enoti!) ────────
    xt, _ = poisci(f"02_avtomatska_placila_transakcije/meritve/x402_transakcije_{n}.csv")
    if xt is not None and "kumulativno_atomic" in xt.columns:
        vz = args.vzorec or preveri_sinteticnost(xt, "x402 transakcije")
        oznaci_vzorec(vz)
        fig, ax = nova_slika()
        enota = _zadnja(xt, "sredstvo", "?")
        dec = int(float(_zadnja(xt, "decimals", "18") or 18))
        ax.plot(xt.index + 1, xt["kumulativno_atomic"].astype(float) / 10**dec, marker="o",
                color=BLUE, label=f"x402-self: plačilo potrošnika [{enota}]")
        ax.set_xlabel("odčitek N")
        ax.set_ylabel(f"kumulativno plačilo [{enota}]")
        ax.set_title(f"x402 na odčitek: strošek raste linearno z N ({n})")
        ax.legend()
        gridnice(ax)
        ax.text(0.99, 0.10, f"Gas vseh poravnav plača {_zadnja(xt, 'placnik_gasa', 'strežnik').upper()} —\n"
                            "ni vštet v to krivuljo in ni primerljiv s krivuljo mape 02.",
                transform=ax.transAxes, ha="right", va="bottom", fontsize=7,
                color=MUTED, style="italic")
        zig_opozorilo(ax)
        shrani(fig, os.path.join(out, f"x402_02_kumulativno_{n}.png"))
        oznaci_vzorec(False)
    else:
        print(f"  – x402 transakcije ({n}): še ni meritev — poženi 02/agent: node agent.js --x402")

    # ── 3) merjena seja: bremenitve so lokalne v OBEH krakih ─────────────────
    xd, _ = poisci(f"03_avtomatska_placila_dobroimetje/meritve/x402_dobroimetje_{n}.csv")
    dd, _ = poisci(f"03_avtomatska_placila_dobroimetje/meritve/dobroimetje_{n}.csv")
    if xd is not None:
        vz = args.vzorec or preveri_sinteticnost(xd, "x402 dobroimetje")
        oznaci_vzorec(vz)
        fig, ax = nova_slika()
        skupine, oznake, barve = [], [], []
        if dd is not None and "vrsta" in dd.columns:
            deb = dd[dd["vrsta"] == "debit"]["t_zahteva_ms"].dropna()
            if len(deb):
                skupine.append(deb)
                oznake.append("ETH polnitev\n→ lokalne bremenitve")
                barve.append(ORANGE)
        deb_x = xd[xd["vrsta"] == "debit"]["t_zahteva_ms"].dropna()
        skupine.append(deb_x)
        oznake.append(f"x402/{_zadnja(xd, 'sredstvo', '?')} polnitev\n→ lokalne bremenitve")
        barve.append(BLUE)
        bp = ax.boxplot(skupine, labels=oznake, patch_artist=True, showfliers=False)
        for patch, c in zip(bp["boxes"], barve):
            patch.set_facecolor(c)
            patch.set_alpha(0.6)
        ax.set_ylabel("t_zahteva (lokalna bremenitev) [ms]")
        ax.set_title(f"Merjena seja: bremenitve so lokalne ne glede na vir polnitve ({n})")
        gridnice(ax)
        ax.text(0.99, 0.10, "Bremenitve v OBEH krakih tečejo brez verige (EIP-191);\n"
                            "razlikuje se samo financiranje seje.",
                transform=ax.transAxes, ha="right", va="bottom", fontsize=7,
                color=MUTED, style="italic")
        shrani(fig, os.path.join(out, f"x402_03_bremenitve_{n}.png"))
        oznaci_vzorec(False)
    else:
        print(f"  – x402 dobroimetje ({n}): še ni meritev — poženi 03/agent: node agent.js --x402")

    # ── 4) topologija: x402-self (05/01) vs x402-facilitated (04) ────────────
    xp, _ = poisci(f"04_spletisce_posrednik/meritve/x402_posrednik_tx_{n}.csv")
    if xp is not None and xs is not None:
        vz = args.vzorec or preveri_sinteticnost(xp, "x402 posrednik")
        oznaci_vzorec(vz)
        fig, ax = nova_slika()
        bp = ax.boxplot(
            [xs["t_placilo_http_ms"].dropna(), xp["t_placilo_http_ms"].dropna()],
            labels=["x402-self\n(neposredno)", "x402-facilitated\n(prek posrednika)"],
            patch_artist=True, showfliers=False)
        for patch, c in zip(bp["boxes"], [BLUE, ORANGE]):
            patch.set_facecolor(c)
            patch.set_alpha(0.6)
        ax.set_ylabel("t_placilo (verify+settle+vir) [ms]")
        ax.set_title(f"x402: neposredna proti facilitirani topologiji ({n})")
        gridnice(ax)
        ax.text(0.99, 0.10, "Lokalni posrednik: meritev izključuje WAN zakasnitve,\n"
                            "ki bi jih imel oddaljeno gostovani facilitator.",
                transform=ax.transAxes, ha="right", va="bottom", fontsize=7,
                color=MUTED, style="italic")
        shrani(fig, os.path.join(out, f"x402_04_topologija_{n}.png"))
        oznaci_vzorec(False)
    else:
        print(f"  – topološka primerjava ({n}): potrebna x402 kraka iz map 01 in 04")

    print("\nKončano. Slike: primerjava/slike/x402_*.png")
    print(f"⚠ Ponovno: {OPOZORILO}")


if __name__ == "__main__":
    main()
