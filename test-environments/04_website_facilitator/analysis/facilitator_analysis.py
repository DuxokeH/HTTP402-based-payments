#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
 ANALIZA POSREDNIŠKE VEJE — plačilo na odčitek, merjena seja, štetje sporočil
 (mapa 04_spletisce_posrednik/analiza)
================================================================================

Primerja NEPOSREDNO topologijo (a) s POSREDNIŠKO (b) in izriše slike.
Vsi vhodi so CSV, ki jih ustvarita merilni agent te mape in agenta
v mapah 02/03 (oz. 05).

  plačilo na odčitek   posrednik_tx_*.csv        vs  02_.../transakcije_*.csv
  merjena seja         posrednik_merjeno_*.csv   vs  03_.../dobroimetje_*.csv
  število sporočil     e9_*.csv (števni posredovalnik)

Zakaj to ni podvajanje zgodnejše primerjave neposredne in posredniške izvedbe:
tam sta bili primerjani DVE RAZLIČNI kodni bazi, kar je bila priznana omejitev.
Tu je trgovec v obeh vejah isti; razlikuje se samo topologija.

BERI REZULTATE PREVIDNO: posrednik je LOKALEN (samogostovan, na istem gostitelju).
Izmerjeni pribitek je zato SPODNJA MEJA za gostovanega posrednika — v številkah ni
omrežne razdalje. Prav tako ta poskus NE meri stroškov zaupanja (razpoložljivost,
pravilnost, privilegiran opazovalec): ti pri lastnem posredniku ne nastopajo.
Meri se čisti strošek procesne meje.

UPORABA:
    pip install -r requirements.txt
    python3 analiza_posrednik.py                # samodejno poišče CSV
    python3 analiza_posrednik.py --nacin real   # samo prave meritve
    python3 analiza_posrednik.py --out slike
"""
import argparse
import os
import sys
import glob

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slog import nastavi_slog, ocisti_osi, shrani, oznaci_vzorec, MODRA, ORANZNA, AKVA, INK, INK2, MUTED

TU = os.path.dirname(os.path.abspath(__file__))
KOREN = os.path.abspath(os.path.join(TU, "..", ".."))          # meritve/
MERITVE = os.path.abspath(os.path.join(TU, "..", "meritve"))    # meritve te mape


def najdi(*kandidati):
    """Prvi obstoječi in NEPRAZEN CSV. Prazna datoteka (samo glava) je enaka manjkajoči."""
    for p in kandidati:
        for m in sorted(glob.glob(p)):
            try:
                if os.path.getsize(m) > 0 and len(pd.read_csv(m)) > 0:
                    return m
            except Exception:
                continue
    return None


def je_vzorec(pot):
    """Ali gre za SIMULIRANE vzorčne podatke? Te je treba označiti, ne tiho uporabiti."""
    return pot is not None and "_vzorec" in str(pot)


def nacin_v(csv_pot, privzeto="?"):
    """Način (mock/real) preberi iz stolpca `nacin`, ne iz imena datoteke."""
    try:
        d = pd.read_csv(csv_pot, nrows=5)
        if "nacin" in d.columns and len(d):
            return str(d["nacin"].iloc[0])
    except Exception:
        pass
    return privzeto


def opozori_o_viru(oznaka, pot, nas_nacin):
    """Glasno povej, kadar primerjava ni jabolka-z-jabolki. Tiho bi bilo huje."""
    vz = je_vzorec(pot)
    njihov = nacin_v(pot)
    if vz:
        print(f"  ⚠ {oznaka}: uporabljeni so SIMULIRANI vzorčni podatki ({os.path.basename(pot)}).")
        print("    Slika bo nosila vodni žig. Za merodajne številke poženi pravo meritev.")
    if njihov != nas_nacin:
        print(f"  ⚠ {oznaka}: načina se razlikujeta (neposredna={njihov}, posredniška={nas_nacin}).")
        print("    Protokolna latenca je brez čakanja na verigo in je zato še vedno primerljiva,")
        print("    a razlika vsebuje tudi razliko med okoljema — to pri poročanju navedi.")
    return vz, njihov


def permutacijski_test(a, b, ponovitev=20000, seme=20260819):
    """
    Dvostranski permutacijski test razlike median. Brez `scipy` (paket ga nima
    med odvisnostmi), pa vendar pošten: ne predpostavlja normalnosti, latence pa
    normalne niso. Vrne (razlika_median, p).
    """
    a = np.asarray(a, dtype=float); b = np.asarray(b, dtype=float)
    a = a[np.isfinite(a)]; b = b[np.isfinite(b)]
    if len(a) < 3 or len(b) < 3:
        return (float("nan"), float("nan"))
    opazovano = float(np.median(b) - np.median(a))
    skupaj = np.concatenate([a, b])
    n = len(a)
    rng = np.random.default_rng(seme)
    vecji = 0
    for _ in range(ponovitev):
        rng.shuffle(skupaj)
        d = np.median(skupaj[n:]) - np.median(skupaj[:n])
        if abs(d) >= abs(opazovano) - 1e-12:
            vecji += 1
    return (opazovano, (vecji + 1) / (ponovitev + 1))


def povzemi(x):
    x = np.asarray(x, dtype=float); x = x[np.isfinite(x)]
    if not len(x):
        return None
    return dict(n=int(len(x)), median=float(np.median(x)), mean=float(np.mean(x)),
                p95=float(np.percentile(x, 95)), min=float(x.min()), max=float(x.max()))


def boxplot_dva(ax, a, b, oznake, barve=(MODRA, ORANZNA)):
    bp = ax.boxplot([a, b], patch_artist=True, widths=0.55, showfliers=False,
                    medianprops=dict(color=INK, linewidth=1.6))
    for patch, c in zip(bp["boxes"], barve):
        patch.set_facecolor(c); patch.set_alpha(0.35); patch.set_edgecolor(c); patch.set_linewidth(1.4)
    for w in bp["whiskers"] + bp["caps"]:
        w.set_color(MUTED)
    # Oznake nastavimo posebej: parameter se je v matplotlibu preimenoval
    # (labels -> tick_labels v 3.9), set_xticklabels pa deluje v vseh različicah.
    ax.set_xticklabels(oznake)
    return bp


# ══════════════════ Plačilo na odčitek ═══════════════════════════════════════
def e7(nacin, out, vrstice):
    pos_csv = najdi(os.path.join(MERITVE, f"posrednik_tx_{nacin}.csv"),
                    os.path.join(MERITVE, "posrednik_tx_*.csv"))
    nep_csv = najdi(os.path.join(KOREN, "02_avtomatska_placila_transakcije", "meritve", f"transakcije_{nacin}.csv"),
                    os.path.join(KOREN, "02_avtomatska_placila_transakcije", "meritve", "transakcije_*.csv"),
                    os.path.join(KOREN, "02_avtomatska_placila_transakcije", "meritve", "_vzorec", "transakcije_*.csv"))
    if not pos_csv:
        print("  · plačilo na odčitek: manjka posrednik_tx_*.csv (poženi: cd agent && npm run mock)")
        return
    print(f"  plačilo na odčitek, posredniška: {os.path.relpath(pos_csv, KOREN)}")
    p = pd.read_csv(pos_csv)
    p = p[p["dogodek"].astype(str).str.startswith("poizvedba")]
    if not len(p):
        print("  · plačilo na odčitek: CSV nima vrstic poizvedb"); return

    # Delež, ki ga pojedo skoki do posrednika.
    p["posrednik_skupaj_ms"] = (p[["posrednik_izziv_ms", "posrednik_dostop_ms", "posrednik_prijava_ms"]]
                                .apply(pd.to_numeric, errors="coerce").fillna(0).sum(axis=1))
    # Protokolna latenca brez čakanja na verigo — to je primerljiva količina.
    p["protokol_ms"] = (pd.to_numeric(p["t_skupaj_ms"], errors="coerce")
                        - pd.to_numeric(p["t_veriga_ms"], errors="coerce").fillna(0))

    sP = povzemi(p["protokol_ms"])
    vrstice.append(["placilo na odcitek", nacin, "posredniska", "protokolna latenca (ms)", sP["n"], sP["median"], sP["mean"], sP["p95"]])
    sPos = povzemi(p["posrednik_skupaj_ms"])
    vrstice.append(["placilo na odcitek", nacin, "posredniska", "od tega posrednik (ms)", sPos["n"], sPos["median"], sPos["mean"], sPos["p95"]])

    # ── slika 1: razčlenitev po fazah ────────────────────────────────────────
    faze = [("t_izziv_ms", "402 izziv\n(M→F→M)", MODRA),
            ("t_prijava_ms", "prijava plačila\n(C→F→B)", ORANZNA),
            ("t_dostop_ms", "dostop\n(M→F→M)", AKVA)]
    fig, ax = plt.subplots(figsize=(7.6, 4.4))
    med = [float(pd.to_numeric(p[k], errors="coerce").median()) for k, _, _ in faze]
    xs = np.arange(len(faze))
    ax.bar(xs, med, color=[c for _, _, c in faze], alpha=0.85, width=0.6)
    for x, v in zip(xs, med):
        ax.text(x, v, f"{v:.1f} ms", ha="center", va="bottom", fontsize=10, color=INK)
    ax.set_xticks(xs); ax.set_xticklabels([l for _, l, _ in faze])
    ax.set_ylabel("mediana (ms)")
    ax.set_title(f"Plačilo na odčitek · posredniška topologija po fazah ({nacin})")
    ax.text(0.99, 0.97, f"od tega čakanje na posrednika: {sPos['median']:.1f} ms",
            transform=ax.transAxes, ha="right", va="top", fontsize=9, color=INK2)
    ocisti_osi(ax); shrani(fig, os.path.join(out, f"e7_faze_{nacin}.png"))

    if not nep_csv:
        print("  · plačilo na odčitek: neposredne meritve (mapa 02) ni — primerjalne slike ni.")
        return
    print(f"  plačilo na odčitek, neposredna:  {os.path.relpath(nep_csv, KOREN)}")
    vz, nnacin = opozori_o_viru("plačilo na odčitek", nep_csv, nacin)
    d = pd.read_csv(nep_csv)

    # Protokolna latenca = VSE faze RAZEN čakanja na verigo. Brez tega odštevanja
    # bi primerjali ~92 ms protokola z ~12 s čakanja na blok in dobili nesmisel.
    faze_brez_verige = [c for c in ["t_izziv_ms", "t_preverjanje_ms", "t_odcitek_ms"] if c in d.columns]
    if faze_brez_verige:
        a = d[faze_brez_verige].apply(pd.to_numeric, errors="coerce").sum(axis=1, min_count=1).dropna().values
        print(f"    (protokolna latenca sešteta iz: {', '.join(faze_brez_verige)})")
    elif "t_skupaj_ms" in d.columns:
        a = pd.to_numeric(d["t_skupaj_ms"], errors="coerce")
        for c in ["t_veriga_ms", "t_potrditev_ms", "t_oddaja_ms"]:
            if c in d.columns:
                a = a - pd.to_numeric(d[c], errors="coerce").fillna(0)
        a = a.dropna().values
    else:
        print("  · plačilo na odčitek: v neposrednem CSV ni znanih stolpcev latence."); return
    b = p["protokol_ms"].dropna().values
    if len(a) < 3:
        print("  · plačilo na odčitek: premalo neposrednih vrstic."); return

    razlika, pval = permutacijski_test(a, b)
    sA = povzemi(a)
    vrstice.append(["placilo na odcitek", nacin, "neposredna", "protokolna latenca (ms)", sA["n"], sA["median"], sA["mean"], sA["p95"]])
    vrstice.append(["placilo na odcitek", nacin, "razlika", "posredniška − neposredna (ms)" + (" [VZOREC]" if vz else ""), "", razlika, "", f"p={pval:.2g}"])

    fig, ax = plt.subplots(figsize=(6.4, 4.6))
    boxplot_dva(ax, a, b, [f"neposredna (a)\nmapa 02 · {nnacin}", f"posredniška (b)\nmapa 04 · {nacin}"])
    ax.set_ylabel("protokolna latenca (ms), brez čakanja na verigo")
    ax.set_title(f"Plačilo na odčitek · vpliv topologije na latenco ({nacin})")
    ax.text(0.5, 0.02, f"Δmediana = {razlika:+.1f} ms  ·  permutacijski test p = {pval:.2g}  ·  n = {len(a)} / {len(b)}",
            transform=ax.transAxes, ha="center", va="bottom", fontsize=9, color=INK2)
    ocisti_osi(ax)
    oznaci_vzorec(vz)          # žig samo na TEJ sliki, če je neposredna stran vzorčna
    shrani(fig, os.path.join(out, f"e7_topologija_{nacin}.png"))
    oznaci_vzorec(False)


# ══════════════════ Merjena seja × posrednik ═════════════════════════════════
def e8(nacin, out, vrstice):
    pos_csv = najdi(os.path.join(MERITVE, f"posrednik_merjeno_{nacin}.csv"),
                    os.path.join(MERITVE, "posrednik_merjeno_*.csv"))
    nep_csv = najdi(os.path.join(KOREN, "03_avtomatska_placila_dobroimetje", "meritve", f"dobroimetje_{nacin}.csv"),
                    os.path.join(KOREN, "03_avtomatska_placila_dobroimetje", "meritve", "dobroimetje_*.csv"),
                    os.path.join(KOREN, "03_avtomatska_placila_dobroimetje", "meritve", "_vzorec", "dobroimetje_*.csv"))
    if not pos_csv:
        print("  · merjena seja: manjka posrednik_merjeno_*.csv (poženi: cd agent && npm run mock-merjeno)")
        return
    print(f"  merjena seja, posredniška: {os.path.relpath(pos_csv, KOREN)}")
    p = pd.read_csv(pos_csv)
    p = p[p.get("vrsta", pd.Series(dtype=str)).astype(str) == "debit"]
    if not len(p):
        print("  · merjena seja: CSV nima bremenitev"); return
    b = pd.to_numeric(p["t_zahteva_ms"], errors="coerce").dropna().values
    bpos = pd.to_numeric(p["posrednik_ms"], errors="coerce").fillna(0).values

    sB, sPos = povzemi(b), povzemi(bpos)
    vrstice.append(["merjena seja", nacin, "posredniska", "bremenitev — obhod (ms)", sB["n"], sB["median"], sB["mean"], sB["p95"]])
    vrstice.append(["merjena seja", nacin, "posredniska", "od tega posrednik (ms)", sPos["n"], sPos["median"], sPos["mean"], sPos["p95"]])

    if not nep_csv:
        print("  · merjena seja: neposredne meritve (mapa 03) ni — primerjalne slike ni.")
        return
    print(f"  merjena seja, neposredna:  {os.path.relpath(nep_csv, KOREN)}")
    vz, nnacin = opozori_o_viru("merjena seja", nep_csv, nacin)
    d = pd.read_csv(nep_csv)
    d = d[d.get("vrsta", pd.Series(dtype=str)).astype(str) == "debit"]
    a = pd.to_numeric(d["t_zahteva_ms"], errors="coerce").dropna().values
    if len(a) < 3:
        print("  · merjena seja: premalo neposrednih bremenitev."); return

    razlika, pval = permutacijski_test(a, b)
    sA = povzemi(a)
    vrstice.append(["merjena seja", nacin, "neposredna", "bremenitev — obhod (ms)", sA["n"], sA["median"], sA["mean"], sA["p95"]])
    vrstice.append(["merjena seja", nacin, "razlika", "posredniška − neposredna (ms)" + (" [VZOREC]" if vz else ""), "", razlika, "", f"p={pval:.2g}"])
    delez = 100.0 * razlika / sA["median"] if sA["median"] else float("nan")

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.4, 4.6), gridspec_kw=dict(width_ratios=[1, 1]))
    boxplot_dva(ax1, a, b, [f"neposredna (a)\nmapa 03 · {nnacin}", f"posredniška (b)\nmapa 04 · {nacin}"])
    ax1.set_ylabel("latenca podpisane bremenitve (ms)")
    ax1.set_title("Merjena seja: en skok več")
    ax1.text(0.5, 0.02, f"Δmediana = {razlika:+.1f} ms ({delez:+.0f} %)  ·  p = {pval:.2g}",
             transform=ax1.transAxes, ha="center", va="bottom", fontsize=9, color=INK2)
    ocisti_osi(ax1)

    # Iz česa je sestavljena posredniška bremenitev.
    trg = pd.to_numeric(p["streznik_ms"], errors="coerce").fillna(0).values
    lastno = np.maximum(trg - bpos, 0)
    omrezje = np.maximum(b - trg, 0)
    ax2.bar(["posredniška (b)"], [np.median(omrezje)], color=MUTED, alpha=0.7, label="omrežje odjemalec↔trgovec")
    ax2.bar(["posredniška (b)"], [np.median(lastno)], bottom=[np.median(omrezje)], color=MODRA, alpha=0.85, label="delo trgovca")
    ax2.bar(["posredniška (b)"], [np.median(bpos)], bottom=[np.median(omrezje) + np.median(lastno)], color=ORANZNA, alpha=0.9, label="čakanje na posrednika")
    ax2.axhline(np.median(a), color=INK, linestyle="--", linewidth=1.2)
    ax2.text(0.02, np.median(a), f"  neposredna mediana {np.median(a):.1f} ms", va="bottom", fontsize=9, color=INK2)
    ax2.set_ylabel("mediana (ms)")
    ax2.set_title("Iz česa je sestavljena")
    ax2.legend(frameon=False, fontsize=9, loc="upper left")
    ocisti_osi(ax2)
    oznaci_vzorec(vz)
    shrani(fig, os.path.join(out, f"e8_merjeno_topologija_{nacin}.png"))
    oznaci_vzorec(False)


# ══════════════════ Število sporočil ═════════════════════════════════════════
def e9(out, vrstice):
    datoteke = sorted(glob.glob(os.path.join(MERITVE, "e9_*.csv")))
    if not datoteke:
        print("  · štetje sporočil: ni e9_*.csv (poženi števni posredovalnik, glej ../README.md)")
        return
    skupine = {}
    for f in datoteke:
        try:
            d = pd.read_csv(f)
        except Exception:
            continue
        # Štejejo SAMO plačilne izmenjave: pripravljalne poti (/config, /health)
        # in dolgo živeči SSE pretoki niso del plačilnega toka.
        if "placilna" in d.columns:
            d = d[pd.to_numeric(d["placilna"], errors="coerce").fillna(0) == 1]
        elif "pretok" in d.columns:
            d = d[pd.to_numeric(d["pretok"], errors="coerce").fillna(0) == 0]
        oznaka = os.path.basename(f)[3:-4]
        skupine[oznaka] = len(d)
        print(f"  štetje sporočil, {oznaka}: {len(d)} izmenjav / {2 * len(d)} sporočil")

    nep = sum(v for k, v in skupine.items() if "neposred" in k)
    pos = sum(v for k, v in skupine.items() if "neposred" not in k)
    for ime, izm in (("neposredna", nep), ("posredniska", pos)):
        if izm:
            vrstice.append(["stevilo sporocil", "-", ime, "izmenjav / sporočil", izm, izm, 2 * izm, ""])
    if not (nep and pos):
        print("  · štetje sporočil: za primerjalno sliko potrebujem obe veji (e9_neposredno.csv + e9_trgovec.csv/e9_posrednik.csv)")
        return

    fig, ax = plt.subplots(figsize=(6.6, 4.4))
    xs = np.arange(2)
    izm = [nep, pos]; spo = [2 * nep, 2 * pos]
    ax.bar(xs - 0.18, izm, width=0.34, color=MODRA, alpha=0.85, label="izmenjave")
    ax.bar(xs + 0.18, spo, width=0.34, color=ORANZNA, alpha=0.85, label="sporočila (HTTP)")
    for x, v in zip(xs - 0.18, izm):
        ax.text(x, v, str(v), ha="center", va="bottom", fontsize=10, color=INK)
    for x, v in zip(xs + 0.18, spo):
        ax.text(x, v, str(v), ha="center", va="bottom", fontsize=10, color=INK)
    ax.set_xticks(xs); ax.set_xticklabels(["neposredna (a)\nmapa 05", "posredniška (b)\nmapa 04"])
    ax.set_ylabel("število na eno plačilo")
    ax.set_title("Sporočila na plačilni tok")
    ax.legend(frameon=False, fontsize=9)
    ocisti_osi(ax); shrani(fig, os.path.join(out, "e9_sporocila.png"))


def main():
    ap = argparse.ArgumentParser(description="Analiza posredniške veje (plačilo na odčitek, merjena seja, štetje sporočil)")
    ap.add_argument("--nacin", default=None, choices=["mock", "real"], help="samo en način (privzeto oba, kar najde)")
    ap.add_argument("--out", default=os.path.join(TU, "slike"))
    a = ap.parse_args()
    nastavi_slog()
    os.makedirs(a.out, exist_ok=True)

    nacini = [a.nacin] if a.nacin else ["real", "mock"]
    vrstice = []
    print("Analiza posredniške veje (topologija b)\n")
    for n in nacini:
        if not (glob.glob(os.path.join(MERITVE, f"posrednik_*_{n}.csv"))):
            continue
        print(f"── način: {n} ──")
        e7(n, a.out, vrstice)
        e8(n, a.out, vrstice)
    e9(a.out, vrstice)

    if not vrstice:
        print("\nNi meritev. Najprej poženi agenta:")
        print("  cd ../posrednik && npm run mock            # posrednik")
        print("  cd ../streznik  && npm run mock            # trgovec")
        print("  cd ../agent && npm run mock && npm run mock-merjeno")
        sys.exit(1)

    tab = pd.DataFrame(vrstice, columns=["poskus", "nacin", "topologija", "kolicina", "n", "mediana", "povprecje", "p95"])
    pot = os.path.join(a.out, "posrednik_povzetek.csv")
    tab.to_csv(pot, index=False)
    print(f"\n  ✓ tabela: {pot}")
    print(tab.to_string(index=False))
    print("\nOPOMBA: posrednik je LOKALEN, zato so te številke SPODNJA MEJA")
    print("za gostovanega posrednika (v njih ni omrežne razdalje), stroški zaupanja pa")
    print("v tem poskusu sploh ne nastopajo — glej uvodni komentar te skripte.")


if __name__ == "__main__":
    main()
