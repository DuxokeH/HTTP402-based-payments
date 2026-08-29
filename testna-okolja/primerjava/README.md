# Primerjava — združene slike scenarijev 02 in 03

Ta mapa ne izvaja nobene meritve. Prebere CSV datoteke, ki nastanejo v mapah
[`../02_avtomatska_placila_transakcije`](../02_avtomatska_placila_transakcije) in
[`../03_avtomatska_placila_dobroimetje`](../03_avtomatska_placila_dobroimetje), ter iz njih
nariše primerjalne slike: koliko stane N uporab, če vsaka zahteva svojo on-chain
transakcijo, proti modelu z eno polnitvijo in N podpisanimi bremenitvami.

## Kaj primerja

| Slika | Kaj pokaže |
|---|---|
| `01_kumulativni_strosek.png` | kumulativni strošek poravnave v odvisnosti od N — naraščajoča premica proti skoraj ravni črti |
| `02_amortizacija.png` | efektivni on-chain strošek na zahtevo (strošek polnitve, deljen z N) |
| `03_latenca_primerjava.png` | latenca on-chain poizvedbe proti off-chain podpisani bremenitvi (logaritemska skala) |
| `04_tabela_stroskov.png` + `primerjava_stroskov.csv` | število poravnav in strošek pri izbranih N |

## Zahteve

- Python ≥ 3.9
- Paketi iz `requirements.txt` (`matplotlib`, `pandas`, `numpy`)

Ničesar drugega ni treba — vse podatke skripte preberejo iz že zagnanih scenarijev.

## Namestitev

```bash
cd testna-okolja/primerjava
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Zagon

Skripte pot do map razrešijo same, zato jih zaženeš iz te mape brez dodatnih argumentov.

### Z lastnimi meritvami (priporočeno)

Najprej zaženi scenarija 02 in 03 (glej njuna README), da nastaneta
`transakcije_*.csv` in `dobroimetje_*.csv`, nato:

```bash
python3 primerjava.py
```

Skripta poišče najprej `*_real.csv`, nato `*_mock.csv`.

### Brez meritev — simulirani vzorec za predogled

Če želiš samo videti, kako slike izgledajo, si lahko vhodne podatke ustvariš:

```bash
python3 generiraj_vzorec.py    # zapiše simulirane CSV v ../0X_*/meritve/_vzorec/
python3 primerjava.py          # če pravih meritev ni, samodejno uporabi vzorec
```

> **Pozor:** te številke so **izmišljene**. Slike, narisane iz vzorca, nosijo rdeč vodni žig
> „SIMULIRANI PRIMER — NE PRAVE MERITVE". Kot rezultat navajaj samo slike iz lastnih
> meritev.

### Primerjava z uradnim protokolom x402

```bash
python3 primerjava_x402.py --nacin mock     # ali --nacin real
```

Bere datoteke `x402_*.csv`, ki nastanejo pri zagonih z zastavico `--x402` (glej
[uradni protokol x402 v2](../README.md#uradni-protokol-x402-v2)), in jih postavi ob rezultate lastnega protokola. Skripta ob
vsakem zagonu izpiše metodološko opozorilo, ki je vžgano tudi v sliko: kraka si delita
omrežje in denominacijo, razlikujeta pa se v protokolu, vrsti transakcije in plačniku gasa —
razlik torej ni mogoče pripisati zgolj protokolu x402.

## Uporabni argumenti

| Argument | Skripta | Privzeto | Pomen |
|---|---|---|---|
| `--horizon N` | `primerjava.py` | 50 | do katerega N sega graf |
| `--gas-price-gwei` | `primerjava.py` | 2.0 | cena gasa, kadar je v CSV ni (mock) |
| `--gas-per-tx` | `primerjava.py` | 21000 | enote gasa za navadni prenos ETH |
| `--out` | `primerjava.py` | `slike/` | ciljna mapa slik |
| `--vzorec` | obe | — | doda vodni žig „SIMULIRANI PRIMER" |
| `--nacin` | `primerjava_x402.py` | `mock` | `mock` ali `real` |

Če v CSV ni podatkov o dejanskem gasu (mock način), se strošek **modelira** iz zgornjih
dveh argumentov; slike to izrecno označijo.

## Pričakovani izhodi

Vse nastane v `slike/` (mapa se ustvari sama): štiri slike PNG iz zgornje tabele in
`primerjava_stroskov.csv`. Mapa `slike/` je v `.gitignore` — rezultati so tvoji, ne del
repozitorija.

## Datoteke

```
primerjava.py         glavne primerjalne slike (scenarija 02 in 03)
primerjava_x402.py    primerjava lastnega protokola z uradnim x402
generiraj_vzorec.py   ustvari simulirane vhodne CSV za predogled
slog.py               skupni slog matplotlib (barvno slepim varna paleta, slovenske oznake)
requirements.txt      Python odvisnosti
```

`slog.py` je namerno podvojen v vseh mapah `analiza/`, da je vsaka mapa samostojno
zaženljiva.

## Odpravljanje težav

- **„Manjkajo CSV meritve"** — najprej zaženi scenarija 02 in 03, ali si ustvari vzorec z
  `generiraj_vzorec.py`.
- Za splošni pregled, vrstni red poskusov in higieno meritev glej
  [`testna-okolja/README.md`](../README.md).
