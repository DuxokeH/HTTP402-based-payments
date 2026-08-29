# Comparison — combined figures for scenarios 02 and 03

This folder performs no measurements of its own. It reads the CSV files produced in
[`../02_machine_payments_per_request`](../02_machine_payments_per_request) and
[`../03_machine_payments_prepaid`](../03_machine_payments_prepaid) and draws comparison
figures from them: what N uses cost when each one requires its own on-chain
transaction, versus a model with a single top-up and N signed debits.

## What it compares

| Figure | What it shows |
|---|---|
| `01_cumulative_cost.png` | cumulative settlement cost as a function of N — a rising straight line against an almost flat one |
| `02_amortization.png` | effective on-chain cost per request (the top-up cost divided by N) |
| `03_latency_comparison.png` | latency of an on-chain query versus an off-chain signed debit (logarithmic scale) |
| `04_cost_table.png` + `cost_comparison.csv` | the number of settlements and the cost at selected values of N |

## Requirements

- Python ≥ 3.9
- The packages from `requirements.txt` (`matplotlib`, `pandas`, `numpy`)

Nothing else is needed — the scripts read all their data from scenarios you have already run.

## Installation

```bash
cd test-environments/comparison
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Running

The scripts resolve the folder paths themselves, so you run them from this folder with no extra arguments.

### With your own measurements (recommended)

First run scenarios 02 and 03 (see their READMEs) so that `transactions_*.csv` and `credit_*.csv`
are produced, then:

```bash
python3 comparison.py
```

The script looks for `*_real.csv` first, then `*_mock.csv`.

### Without measurements — a simulated sample for previewing

If you only want to see what the figures look like, you can generate the input data yourself:

```bash
python3 generate_sample.py    # writes simulated CSVs to ../0X_*/measurements/_sample/
python3 comparison.py          # if there are no real measurements, it falls back to the sample
```

> **Caution:** these numbers are **made up**. Figures drawn from the sample carry a red watermark
> reading “SIMULATED EXAMPLE — NOT REAL MEASUREMENTS”. Only ever cite figures from your own
> measurements as results.

### Comparison with the official x402 protocol

```bash
python3 comparison_x402.py --mode mock     # or --mode real
```

This reads the `x402_*.csv` files produced by runs with the `--x402` flag (see
[the official x402 v2 protocol](../README.md#official-x402-v2-protocol)), and places them alongside the results of this project's
own protocol. On every run the script prints a methodological caveat, which is also burned into the
figure: the two branches share the network and the denomination, but differ in protocol, transaction
type and who pays the gas — so the differences cannot be attributed to the x402 protocol alone.

## Useful arguments

| Argument | Script | Default | Meaning |
|---|---|---|---|
| `--horizon N` | `comparison.py` | 50 | how far along N the chart extends |
| `--gas-price-gwei` | `comparison.py` | 2.0 | gas price to assume when the CSV has none (mock) |
| `--gas-per-tx` | `comparison.py` | 21000 | gas units for a plain ETH transfer |
| `--out` | `comparison.py` | `figures/` | target folder for the figures |
| `--sample` | both | — | adds the “SIMULATED EXAMPLE” watermark |
| `--mode` | `comparison_x402.py` | `mock` | `mock` or `real` |

If the CSV holds no actual gas data (mock mode), the cost is **modelled** from the two arguments
above; the figures say so explicitly.

## Expected outputs

Everything lands in `figures/` (the folder is created automatically): the four PNG figures from the
table above and `cost_comparison.csv`. `figures/` is listed in `.gitignore` — the results are yours,
not part of the repository.

## Files

```
comparison.py         the main comparison figures (scenarios 02 and 03)
comparison_x402.py    comparison of this project's own protocol with official x402
generate_sample.py    creates simulated input CSVs for previewing
style.py              shared matplotlib style (colour-blind-safe palette, localised labels)
requirements.txt      Python dependencies
```

`style.py` is duplicated on purpose across all the `analysis/` folders, so that each folder can be
run on its own.

## Troubleshooting

- **“CSV measurements are missing”** — run scenarios 02 and 03 first, or create a sample with
  `generate_sample.py`.
- For a general overview, the recommended experiment order and measurement hygiene, see
  [`test-environments/README.md`](../README.md).
