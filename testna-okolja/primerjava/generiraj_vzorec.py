#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
╔════════════════════════════════════════════════════════════════════════════╗
║  GENERATOR VZORČNIH (SIMULIRANIH) MERITEV — NE PRAVE ŠTEVILKE!              ║
╠════════════════════════════════════════════════════════════════════════════╣
║  Ta skripta USTVARI verjetno izgledajoče CSV datoteke, da lahko preizkusiš  ║
║  analitični cevovod in vidiš, kako bodo slike videti. Številke so IZMIŠLJENE ║
║  (naključne iz razumnih porazdelitev), NISO rezultat pravih meritev.        ║
║                                                                              ║
║  Ko izvedeš prave meritve (mock ali Sepolia), bodo pravi CSV-ji v mapah     ║
║  meritve/ nadomestili te vzorce. Analize potem poženi nad pravimi podatki.  ║
║                                                                              ║
║  Zapiše v: <mapa>/meritve/_vzorec/<ime>.csv                                 ║
╚════════════════════════════════════════════════════════════════════════════╝
"""
import os, csv, datetime
import numpy as np

SEED = 42
rng = np.random.default_rng(SEED)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # testna-okolja/

def out(mapa, ime):
    d = os.path.join(ROOT, mapa, "meritve", "_vzorec")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, ime)

def iso(i):
    return (datetime.datetime(2026, 8, 13, 12, 0, 0) + datetime.timedelta(seconds=15 * i)).isoformat()

def clip(x, lo):
    return float(max(lo, x))

GWEI = 1_000_000_000

# ── 01 enkratna plačila ─────────────────────────────────────────────────────
def enkratna():
    # REAL: full flow incl. real confirmation + gas
    h = ["zap","cas_iso","nacin","t_izziv_ms","t_oddaja_ms","t_potrditev_ms","t_preverjanje_ms",
         "t_dostop_ms","t_skupaj_ms","streznik_preverjanje_ms","veriga_branje_ms","streznik_dostop_ms",
         "zunanji_api_ms","gas_enote","cena_gas_wei","provizija_wei","provizija_eth","blok","tx_hash","status"]
    p = out("01_enkratna_placila", "enkratna_real.csv")
    with open(p, "w", newline="") as f:
        w = csv.writer(f); w.writerow(h)
        for i in range(1, 9):
            izziv = clip(rng.normal(9, 3), 1.5)
            oddaja = clip(rng.normal(90, 30), 20)
            potrd = clip(rng.normal(9000, 3500), 2500)     # Sepolia ~1 conf
            prev = clip(rng.normal(340, 120), 120)         # 2 RPC reads
            dost = clip(rng.normal(12, 5), 2)
            skup = izziv + oddaja + potrd + prev + dost
            gwei = clip(rng.normal(2.0, 1.1), 0.15)
            fee_wei = int(21000 * gwei * GWEI)
            w.writerow([i, iso(i), "real", f"{izziv:.3f}", f"{oddaja:.3f}", f"{potrd:.3f}", f"{prev:.3f}",
                        f"{dost:.3f}", f"{skup:.3f}", f"{clip(rng.normal(180,60),40):.3f}",
                        f"{clip(rng.normal(150,60),30):.3f}", f"{clip(rng.normal(3,1),0.5):.3f}", "0.000",
                        21000, int(gwei*GWEI), fee_wei, f"{fee_wei/1e18:.18f}", 6800000+i, "0x"+"ab"*32, 200])
    print(f"  ✓ {p}")

    # MOCK: protocol-only, no chain
    p = out("01_enkratna_placila", "enkratna_mock.csv")
    with open(p, "w", newline="") as f:
        w = csv.writer(f); w.writerow(h)
        for i in range(1, 61):
            izziv = clip(rng.normal(3.0, 1.0), 0.8)
            oddaja = clip(rng.normal(1.4, 0.5), 0.4)   # local signing
            prev = clip(rng.normal(1.6, 0.6), 0.5)     # mock verify (no RPC)
            dost = clip(rng.normal(1.3, 0.5), 0.4)
            skup = izziv + oddaja + 0 + prev + dost
            w.writerow([i, iso(i), "mock", f"{izziv:.3f}", f"{oddaja:.3f}", "0.000", f"{prev:.3f}",
                        f"{dost:.3f}", f"{skup:.3f}", f"{clip(rng.normal(0.8,0.3),0.2):.3f}", "",
                        f"{clip(rng.normal(0.5,0.2),0.1):.3f}", "0.000", "", "", "", "", 0, "0x"+"cd"*32, 200])
    print(f"  ✓ {p}")

# ── 02 avtomatska plačila — 20 transakcij ───────────────────────────────────
def transakcije():
    h = ["poizvedba","cas_iso","nacin","t_izziv_ms","t_oddaja_ms","t_potrditev_ms","t_preverjanje_ms",
         "t_odcitek_ms","t_skupaj_ms","gas_enote","cena_gas_wei","provizija_wei","provizija_eth",
         "vrednost_wei","kumulativna_provizija_eth","temperatura_c","vlaga_pct","blok","tx_hash"]
    p = out("02_avtomatska_placila_transakcije", "transakcije_real.csv")
    temp, hum, cum = 22.0, 50.0, 0.0
    with open(p, "w", newline="") as f:
        w = csv.writer(f); w.writerow(h)
        for i in range(1, 21):
            izziv = clip(rng.normal(9, 3), 1.5); oddaja = clip(rng.normal(90, 30), 20)
            potrd = clip(rng.normal(9000, 3500), 2500); prev = clip(rng.normal(330, 120), 120)
            odc = clip(rng.normal(11, 4), 2); skup = izziv+oddaja+potrd+prev+odc
            gwei = clip(rng.normal(2.0, 1.1), 0.15); fee_wei = int(21000*gwei*GWEI); cum += fee_wei/1e18
            temp = min(30, max(15, temp + rng.normal(0, 0.2))); hum = min(70, max(30, hum + rng.normal(0, 0.6)))
            w.writerow([i, iso(i), "real", f"{izziv:.3f}", f"{oddaja:.3f}", f"{potrd:.3f}", f"{prev:.3f}",
                        f"{odc:.3f}", f"{skup:.3f}", 21000, int(gwei*GWEI), fee_wei, f"{fee_wei/1e18:.18f}",
                        4000000, f"{cum:.18f}", round(temp,2), round(hum,1), 6800000+i, "0x"+f"{i:02d}"*16])
    print(f"  ✓ {p}  (kumulativna provizija ≈ {cum:.6f} ETH za 20 tx)")

# ── 03 avtomatska plačila — merjena seja ────────────────────────────────────
def dobroimetje():
    h = ["dogodek","cas_iso","nacin","vrsta","t_podpis_ms","t_zahteva_ms","streznik_ms","t_skupaj_ms",
         "cena_wei","dobroimetje_wei","proracun_ostanek_wei","gas_enote","provizija_eth","temperatura_c",
         "vlaga_pct","nonce","seja"]
    p = out("03_avtomatska_placila_dobroimetje", "dobroimetje_real.csv")
    deposit = 100_000_000; price = 4_000_000; bal = deposit; budget = deposit
    temp, hum = 22.0, 50.0; sess = "sess_vzorec"
    gwei = clip(rng.normal(2.0, 1.1), 0.15); topup_fee = 21000*gwei/1e9
    with open(p, "w", newline="") as f:
        w = csv.writer(f); w.writerow(h)
        # topup (1 on-chain tx)
        w.writerow(["polnitev", iso(0), "real", "topup", "", f"{clip(rng.normal(330,120),120):.3f}",
                    f"{clip(rng.normal(4,1),1):.3f}", f"{clip(rng.normal(9300,3000),2600):.3f}",
                    "", str(deposit), str(budget), 21000, f"{topup_fee:.18f}", "", "", "", sess])
        for i in range(1, 21):
            podpis = clip(rng.normal(0.5, 0.2), 0.15); zaht = clip(rng.normal(4.0, 1.8), 1.2)
            bal -= price; budget_left = bal
            temp = min(30, max(15, temp + rng.normal(0, 0.2))); hum = min(70, max(30, hum + rng.normal(0, 0.6)))
            w.writerow([f"bremenitev_{i}", iso(i), "real", "debit", f"{podpis:.3f}", f"{zaht:.3f}",
                        f"{clip(rng.normal(1.2,0.4),0.4):.3f}", f"{podpis+zaht:.3f}", price, bal, budget_left,
                        "", "", round(temp,2), round(hum,1), f"{1786000000000+i}-abcd", sess])
    print(f"  ✓ {p}  (1 polnitev + 20 bremenitev; končno dobroimetje {bal} wei)")

if __name__ == "__main__":
    print("╔══════════════════════════════════════════════════════════════╗")
    print("║  VZORČNI (SIMULIRANI) PODATKI — NE PRAVE MERITVE               ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    enkratna(); transakcije(); dobroimetje()
    print("\nOpozorilo: te datoteke so simulirane le za predogled slik.")
    print("Za objavljive rezultate poženi PRAVE meritve; pravi CSV-ji naj bodo v <mapa>/meritve/.")
