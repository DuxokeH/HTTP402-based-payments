# Rezultati meritev posredniške veje

Ta mapa je ob prevzemu **prazna** — datoteke nastanejo šele, ko sam poženeš meritve
(glej [`../README.md`](../README.md)).

| Datoteka | Nastane z | Poskus |
|---|---|---|
| `posrednik_tx_mock.csv` / `posrednik_tx_real.csv` | `node agent.js --tx` | **plačilo na odčitek** |
| `posrednik_merjeno_mock.csv` / `..._real.csv` | `node agent.js --merjeno` | **merjena seja** |
| `*_povzetek.json` | isto | strnjena statistika teka |
| `posrednik_varnost.csv` | `node agent.js --security` | popravki napak 1, 2, 3, 5 + zloraba |
| `e9_trgovec.csv`, `e9_posrednik.csv`, `e9_neposredno.csv` | `node count-proxy.js` | **število sporočil** |

> **CSV se DOPOLNJUJE, ne prepisuje.** Pred ponovitvijo istega poskusa staro datoteko
> izbriši, sicer se dva teka zlijeta v enega in analiza ju obravnava kot en vzorec.

Slike in tabela nastanejo v `../analiza/slike/` z `python3 ../analiza/analiza_posrednik.py`.
