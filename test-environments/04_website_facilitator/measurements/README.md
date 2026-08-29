# Measurement results for the facilitator branch

On checkout this folder is **empty** — the files appear only once you run the measurements
yourself (see [`../README.md`](../README.md)).

| File | Created by | Experiment |
|---|---|---|
| `facilitator_tx_mock.csv` / `facilitator_tx_real.csv` | `node agent.js --tx` | **payment per reading** |
| `facilitator_metered_mock.csv` / `..._real.csv` | `node agent.js --metered` | **metered session** |
| `*_summary.json` | the same | condensed run statistics |
| `facilitator_security.csv` | `node agent.js --security` | fixes for bugs 1, 2, 3, 5 + abuse |
| `e9_merchant.csv`, `e9_facilitator.csv`, `e9_neposredno.csv` | `node count-proxy.js` | **message count** |

> **The CSV is APPENDED TO, not overwritten.** Delete the old file before repeating the same
> experiment, otherwise two runs merge into one and the analysis treats them as a single sample.

The figures and the table are created in `../analysis/figures/` by
`python3 ../analysis/facilitator_analysis.py`.
