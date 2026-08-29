#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
╔════════════════════════════════════════════════════════════════════════════╗
║  GENERATOR OF SAMPLE (SIMULATED) MEASUREMENTS — NOT REAL NUMBERS!          ║
╠════════════════════════════════════════════════════════════════════════════╣
║  This script CREATES plausible-looking CSV files so you can try out the    ║
║  analysis pipeline and see what the figures will look like. The numbers    ║
║  are MADE UP (random draws from sensible distributions), NOT the result    ║
║  of real measurements.                                                     ║
║                                                                            ║
║  Once you run real measurements (mock or Sepolia), the real CSVs in the    ║
║  measurements/ folders will replace these samples. Run the analyses over   ║
║  the real data after that.                                                 ║
║                                                                            ║
║  Writes to: <folder>/measurements/_sample/<name>.csv                       ║
╚════════════════════════════════════════════════════════════════════════════╝
"""
import os, csv, datetime
import numpy as np

SEED = 42
rng = np.random.default_rng(SEED)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # test-environments/

def out(mapa, ime):
    d = os.path.join(ROOT, mapa, "measurements", "_sample")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, ime)

def iso(i):
    return (datetime.datetime(2026, 8, 13, 12, 0, 0) + datetime.timedelta(seconds=15 * i)).isoformat()

def clip(x, lo):
    return float(max(lo, x))

GWEI = 1_000_000_000

# ── 01 one-time payments ────────────────────────────────────────────────────
def one_time():
    # REAL: full flow incl. real confirmation + gas
    h = ["seq","timestamp_iso","mode","t_challenge_ms","t_submit_ms","t_confirm_ms","t_verify_ms",
         "t_access_ms","t_total_ms","server_verify_ms","chain_read_ms","server_access_ms",
         "external_api_ms","gas_units","gas_price_wei","fee_wei","fee_eth","block","tx_hash","status"]
    p = out("01_one_time_payments", "one_time_real.csv")
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
    p = out("01_one_time_payments", "one_time_mock.csv")
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

# ── 02 machine payments — 20 transactions ───────────────────────────────────
def transactions():
    h = ["query","timestamp_iso","mode","t_challenge_ms","t_submit_ms","t_confirm_ms","t_verify_ms",
         "t_reading_ms","t_total_ms","gas_units","gas_price_wei","fee_wei","fee_eth",
         "value_wei","cumulative_fee_eth","temperature_c","humidity_pct","block","tx_hash"]
    p = out("02_machine_payments_per_request", "transactions_real.csv")
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
    print(f"  ✓ {p}  (cumulative fee ≈ {cum:.6f} ETH for 20 tx)")

# ── 03 machine payments — metered session ───────────────────────────────────
def credit():
    h = ["event","timestamp_iso","mode","kind","t_sign_ms","t_request_ms","server_ms","t_total_ms",
         "price_wei","credit_wei","budget_remaining_wei","gas_units","fee_eth","temperature_c",
         "humidity_pct","nonce","session"]
    p = out("03_machine_payments_prepaid", "credit_real.csv")
    deposit = 100_000_000; price = 4_000_000; bal = deposit; budget = deposit
    temp, hum = 22.0, 50.0; sess = "sess_sample"
    gwei = clip(rng.normal(2.0, 1.1), 0.15); topup_fee = 21000*gwei/1e9
    with open(p, "w", newline="") as f:
        w = csv.writer(f); w.writerow(h)
        # topup (1 on-chain tx)
        w.writerow(["topup", iso(0), "real", "topup", "", f"{clip(rng.normal(330,120),120):.3f}",
                    f"{clip(rng.normal(4,1),1):.3f}", f"{clip(rng.normal(9300,3000),2600):.3f}",
                    "", str(deposit), str(budget), 21000, f"{topup_fee:.18f}", "", "", "", sess])
        for i in range(1, 21):
            podpis = clip(rng.normal(0.5, 0.2), 0.15); zaht = clip(rng.normal(4.0, 1.8), 1.2)
            bal -= price; budget_left = bal
            temp = min(30, max(15, temp + rng.normal(0, 0.2))); hum = min(70, max(30, hum + rng.normal(0, 0.6)))
            w.writerow([f"debit_{i}", iso(i), "real", "debit", f"{podpis:.3f}", f"{zaht:.3f}",
                        f"{clip(rng.normal(1.2,0.4),0.4):.3f}", f"{podpis+zaht:.3f}", price, bal, budget_left,
                        "", "", round(temp,2), round(hum,1), f"{1786000000000+i}-abcd", sess])
    print(f"  ✓ {p}  (1 top-up + 20 debits; final credit {bal} wei)")

if __name__ == "__main__":
    print("╔══════════════════════════════════════════════════════════════╗")
    print("║  SAMPLE (SIMULATED) DATA — NOT REAL MEASUREMENTS             ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    one_time(); transactions(); credit()
    print("\nWarning: these files are simulated, only for previewing the figures.")
    print("For publishable results run REAL measurements; the real CSVs belong in <folder>/measurements/.")
