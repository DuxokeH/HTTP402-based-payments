# 02 — Avtomatska plačila: ena transakcija na odčitek

**Scenarij (obrnjena vloga).** Mock **IoT naprava** (senzor temperature in vlage) je **ponudnik** in
na svojo denarnico **prejema** plačila. **Agent** — stroj, ki je bil v mapi `01` ponudnik — je zdaj
**uporabnik oziroma plačnik** in za **vsak** odčitek plača **eno ločeno transakcijo na verigi**.
Torej: **20 poizvedb = 20 transakcij.** Med strojema ni človeka; celoten tok teče avtomatsko.

Protokolni potek ene poizvedbe:
`GET /reading` → **402** (`requestId`, `to`, `priceWei`) → plačilo na omrežju Ethereum Sepolia →
`POST /verify-payment` → **dokazni žeton** → `GET /reading` z glavo `X-Payment` → **200** + odčitek.
Dokazni žeton je enkraten (poraba ga razveljavi).

To je namenoma **draga osnova**: kumulativni strošek gasa raste **linearno s številom poizvedb N**.
Primerja se z mapo `03` (ista storitev, a ena sama polnitev dobroimetja). Šele obe skupaj pokažeta
amortizacijo stroška plačilnega sloja.

## Kaj poskus meri

Za vsako poizvedbo se zabeležijo iste latenčne faze kot v mapi `01`, dopolnjene s stroškovnimi
podatki:

- **faze (ms):** `t_izziv` (402), `t_oddaja` (oddaja transakcije), `t_potrditev` (čakanje na blok),
  `t_preverjanje` (`POST /verify-payment`), `t_odcitek` (`GET /reading` z žetonom), `t_skupaj`;
- **strošek:** `gas_enote`, `cena_gas_wei`, `provizija_wei`, `provizija_eth`, `vrednost_wei` in
  **`kumulativna_provizija_eth`** (tekoča vsota — osrednja spremenljivka tega poskusa);
- **kupljena vsebina:** `temperatura_c`, `vlaga_pct` (dokaz, da je bila storitev res dostavljena).

Naprava vsakemu odgovoru doda še merilne glave `X-Server-Ms`, `X-Request-Id` in — samo pri pravem
preverjanju na verigi — `X-Chain-Read-Ms`, tako da se čas strežnika loči od omrežja in od bralnih
klicev proti vozlišču RPC. Te glave so vidne v zajemu z Wiresharkom, v CSV te mape pa **niso**
zapisane kot svoji stolpci (za razliko od mape `01`).

Poudarek meritve: **število transakcij na verigi = N** in **kumulativni gas ∝ N**.

## Zahteve

- **Node.js ≥ 20** in **npm** (koda uporablja globalni `fetch`; odvisnost `better-sqlite3` je nativni
  modul in se ob namestitvi prevede ali prenese).
- **Python ≥ 3.9** za analizo (`analiza/requirements.txt`).
- Za **realni način**: **financirana denarnica na omrežju Ethereum Sepolia** (testni ETH iz javnega
  faucet-a). Za 20 transakcij potrebuje 20 × (znesek odčitka + provizija za gas).
- V **mock** načinu sredstva niso potrebna in denarnica plačnika ni potrebna.

Repozitorij **ne vsebuje nobenih ključev, gesel ali žetonov** — vse si ustvariš sam ob prvem zagonu.

## Struktura mape

```
iot_naprava/   Express IoT ponudnik (402 → verify → odčitek), vrata 3100
agent/         agent, ki N-krat izvede celoten tok in beleži kumulativni gas
analiza/       Python skripta za sliki (kumulativni gas, latenca poizvedb)
meritve/       izhodni CSV — mapa v repozitoriju ni sledena in po kloniranju
               ne obstaja; agent jo ustvari sam ob prvem uspešnem teku
```

Ta mapa nima datotek `Dockerfile`, `docker-compose.yml` ali `Caddyfile` — naprava se na strežniku
zažene neposredno z Node.js.

## Namestitev

```bash
cd iot_naprava
npm ci                                  # ali: npm install
cp .env.example .env                    # neobvezno za mock, priporočeno za realni tek
cp wallet.example.json wallet.json      # OBVEZNO — brez te datoteke se strežnik ustavi
```

V `iot_naprava/wallet.json` vpiši **samo naslov** denarnice, ki naj **prejema** plačila
(polje `address`). Za tok te mape — in za x402 v mock načinu — naprava privatnega ključa ne
potrebuje; polji `x402Address` in `x402SettlerPrivateKey` iz predloge pusti prazni.

```bash
cd agent
npm ci                                  # ali: npm install
```

Denarnica plačnika je potrebna **samo za `--real`**:

```bash
cd agent
npm run gen-wallet                      # ustvari wallet.json s pravicami 0600
```

Skripta obstoječe datoteke ne prepiše. Naslov iz izpisa napolni iz javnega faucet-a za Sepolio.
Namesto tega lahko privatni ključ že financirane denarnice vpišeš ročno v `agent/wallet.json`
(predloga: `agent/wallet.example.json`). Datoteki `wallet.json` in `data/admin-credentials.txt`
pokriva `.gitignore` in nikoli ne smeta v git.

## Lokalni zagon — mock (brez sredstev)

Mock način meri protokolno latenco brez verige in brez porabe testnega ETH; transakcije so
sintetične, zato je stolpec `provizija_eth` prazen.

**Terminal 1 — IoT naprava:**

```bash
cd iot_naprava
npm run mock          # NODE_ENV=development MOCK_VERIFY=true, vrata 3100
```

Ob prvem zagonu naprava ustvari skrbniške poverilnice in jih shrani v `iot_naprava/data/admin.json`;
berljivi izvod je v `iot_naprava/data/admin-credentials.txt` (pravice 0600, polja `UPORABNIK=`,
`GESLO=`, `ZETON=`). To datoteko naprava prepiše ob **vsakem** zagonu, vrednosti pa ostanejo iste —
nove dobiš tako, da izbrišeš `data/admin.json` in napravo znova zaženeš. Naprava je zaprta: javna so
samo `GET /health`, `/prijava` in `/odjava`, vse ostalo zahteva sejo ali glavo
`Authorization: Bearer <ZETON>`.

**Terminal 2 — agent:**

```bash
cd agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../iot_naprava/data/admin-credentials.txt | cut -d= -f2)
npm run mock          # = node agent.js --mock --queries 20
```

Brez veljavnega žetona agent na `GET /config` dobi `401`, izpiše točen ukaz za `grep` in konča.
V brskalniku se prijaviš na `http://127.0.0.1:3100/prijava` (uporabnik in geslo iz iste datoteke);
po prijavi te preusmeri na `/config`.

> `npm start` v mapi `agent` požene **isti mock tek** kot `npm run mock`. Realni tek zahteva
> izrecno zastavico `--real` (oziroma `npm run real`).

Parametri, ki jih agent razume: `--real`, `--queries <N>` (privzeto 20), `--pause-ms <ms>`
(privzeto 1000 v realnem, 0 v mock načinu), `--x402`, `--security`, `--out <pot>`.

## Lokalni zagon — realne meritve (Sepolia)

Pred tem uredi `iot_naprava/.env`: pusti `MOCK_VERIFY=false` in po potrebi nastavi svoj `RPC_URL`
ter `MIN_CONFIRMATIONS`. Agent mora imeti financiran `agent/wallet.json`.

**Terminal 1 — IoT naprava:**

```bash
cd iot_naprava
npm start             # pravo preverjanje na verigi
```

**Terminal 2 — agent:**

```bash
cd agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../iot_naprava/data/admin-credentials.txt | cut -d= -f2)
npm run real          # = node agent.js --real --queries 20 --pause-ms 1500
```

Premor 1500 ms med poizvedbami preprečuje omejevanje pri javnem vozlišču RPC in poskrbi, da vsaka
transakcija dobi svoj `nonce` v pravilnem vrstnem redu. Za manjši preizkus uporabi manj poizvedb,
npr. `node agent.js --real --queries 5 --pause-ms 1500`.

Agent pred tekom izpiše ceno odčitka, naslov prejemnika in saldo plačnika, ob koncu pa skupno
provizijo za gas. **Vsaka poizvedba porabi testni ETH** — 20 poizvedb pomeni 20 transakcij.

## Zagon na oddaljenem strežniku

Razdelitev vlog: **IoT naprava teče na strežniku**, **agent na lokalnem računalniku**. Tako je
promet med njima resničen omrežni promet, primeren za zajem z Wiresharkom (glej `../README.md`).

Na strežniku:

```bash
ssh <UPORABNIK>@<IP_STREZNIKA>
git clone <URL_REPOZITORIJA>
cd <IME_REPOZITORIJA>/testna-okolja/02_avtomatska_placila_transakcije/iot_naprava
npm ci
cp .env.example .env
cp wallet.example.json wallet.json      # vpiši naslov prejemnika
sudo ufw allow 3100/tcp                 # odpri vrata naprave
npm run mock                            # ali: npm start za realni tek
```

Žeton preberi na strežniku:

```bash
grep ZETON ~/<IME_REPOZITORIJA>/testna-okolja/02_avtomatska_placila_transakcije/iot_naprava/data/admin-credentials.txt
```

Na lokalnem računalniku poženi agenta in ga usmeri na strežnik s spremenljivko `IOT_URL`
(ta ima prednost pred `agent/config.json`):

```bash
cd agent
IOT_URL=http://<IP_STREZNIKA>:3100 ADMIN_TOKEN=<ZETON> npm run mock
IOT_URL=http://<IP_STREZNIKA>:3100 ADMIN_TOKEN=<ZETON> npm run real
```

Namesto naslova IP je priporočeno ime gostitelja (npr. `http://iot.primer.si:3100`), da ob menjavi
naslova ni treba spreminjati nastavitev.

> **Opozorilo.** Naprava namenoma teče po navadnem **HTTP brez TLS**, ker je le tako mogoč zajem
> in razčlenitev protokola v Wiresharku. Zato dostop do vrat 3100 omeji na svoj naslov IP
> (npr. `sudo ufw allow from <TVOJ_IP> to any port 3100 proto tcp`), naprave ne puščaj odprte v
> internet dlje, kot traja meritev, in po koncu vrata zapri (`sudo ufw delete allow 3100/tcp`).
> Skrbniški žeton potuje v glavi `Authorization` v čistopisu.

## Analiza rezultatov

```bash
cd analiza
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 analiza_transakcije.py
```

Brez argumenta skripta poišče vhodni CSV po vrsti: `../meritve/transakcije_real.csv`,
`../meritve/transakcije_mock.csv`, nato še vzorčni različici v `../meritve/_vzorec/` (te mape v
repozitoriju ni — nastane šele, če jo ustvariš z generatorjem, glej spodaj). Pot lahko
podaš tudi izrecno kot pozicijski argument. Če CSV-ja ni, izpiše navodilo za zagon meritve in
konča z izhodno kodo 1.

Zastavice: `--out <mapa>` (privzeto `slike`), `--gas-price-gwei` (2.0), `--gas-per-tx` (21000),
`--vzorec` (vodni žig „SIMULIRANI PRIMER“; vklopi se samodejno, če je v poti `_vzorec`).

Če je stolpec `provizija_eth` prazen — torej v mock načinu — skripta strošek **modelira** iz
`--gas-price-gwei × --gas-per-tx` in sliko označi z opozorilom „strošek MODELIRAN“. Realni tek
da izmerjene vrednosti.

**Vzorčni podatki brez sredstev.** Če hočeš sliko videti brez financirane denarnice, simulirane
podatke ustvari `../primerjava/generiraj_vzorec.py` v `meritve/_vzorec/transakcije_real.csv`;
analiza jih samodejno prepozna in označi kot simulirane.

**Skripta `analiza_transakcije.py` ne obdela x402 CSV-jev.** Zanje je `../primerjava/primerjava_x402.py`.
Skupno primerjavo map `02` in `03` (graf amortizacije) izriše `../primerjava/primerjava.py`.

## Pričakovani izhodi

Poti so relativne na to mapo.

| Ukaz | Nastane |
|---|---|
| `agent: npm run mock` | `meritve/transakcije_mock.csv` |
| `agent: npm run real` | `meritve/transakcije_real.csv` |
| `agent: node agent.js --x402` | `meritve/x402_transakcije_mock.csv` (z `--real`: `_real.csv`) |
| `agent: node agent.js --x402 --security` | `meritve/varnostni_testi_x402_mock.csv` (ime je fiksno) |
| `analiza: python3 analiza_transakcije.py` | `analiza/slike/01_kumulativni_gas.png`, `analiza/slike/02_latenca_poizvedb.png` |
| naprava ob zagonu | `iot_naprava/data/admin-credentials.txt`, `data/admin.json`, `data/iot_transakcije.db` (ob x402 še `data/x402_placila.db`) |

Datoteka `transakcije_*.csv` ima 19 stolpcev:
`poizvedba, cas_iso, nacin, t_izziv_ms, t_oddaja_ms, t_potrditev_ms, t_preverjanje_ms, t_odcitek_ms,
t_skupaj_ms, gas_enote, cena_gas_wei, provizija_wei, provizija_eth, vrednost_wei,
kumulativna_provizija_eth, temperatura_c, vlaga_pct, blok, tx_hash`.

**Signal uspeha.** Vsaka poizvedba izpiše vrstico `✓ poizvedba NN · T=…°C RH=…% · t_skupaj=… ms`,
na koncu pa okvir `POVZETEK · uspešnih 20/20 · … · CSV: …` in vrstico
`Skupaj plačanih on-chain transakcij za 20 odčitkov: 20 (= N)`. CSV nastane **šele po uspešni
prijavi** (`GET /config`), da neuspel tek ne pusti datoteke s samo glavo. Vrstice se **dodajajo** —
ponovni tek podaljša obstoječi CSV; če hočeš čisto meritev, staro datoteko prej izbriši.

Ta mapa **ne** ustvarja nobene datoteke `*_povzetek.json`.

## Prilagoditve

- **Cena odčitka:** `PRICE_WEI_PER_READING` v `iot_naprava/.env` — privzeto `100000000000` wei
  = 1 × 10⁻⁷ ETH, kar je pri `ETH_EUR_RATE=2500` približno 2,5 × 10⁻⁴ € (≈ 0,025 centa).
  Vrednost je **enaka privzeti ceni v mapi `03`**, da je primerjava poštena — razlika med
  scenarijema je izključno v načinu poravnave, ne v ceni storitve.
- **Vrata naprave:** `IOT_PORT` (privzeto 3100); naprava posluša na `0.0.0.0`.
- **Omejevanje zahtev:** `RATE_PER_MIN` (privzeto 240 zahtev/min) — v `.env.example` ni naveden.
- **Pot do baze:** `DB_PATH` (privzeto `iot_naprava/data/iot_transakcije.db`).
- **Življenjska doba žetonov:** `PROOF_TOKEN_TTL_SECONDS` (600), `PAYMENT_REQUEST_TTL_SECONDS` (1800).
- **Poverilnice po meri:** `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_TOKEN` — iz okolja vedno
  prevladajo in se v tem primeru **ne zapišejo na disk**.

## Varnostni testi

Varnostni testi obstajajo samo za krak x402 in tečejo izključno v mock načinu.

```bash
# Terminal 1 — naprava
cd iot_naprava && X402_MODE=self X402_MOCK=true npm run mock

# Terminal 2 — agent
cd agent && ADMIN_TOKEN=<ZETON> node agent.js --x402 --security
```

Brez `X402_MOCK=true` skripta tek zavrne. Izvede šest testov:

| Test | Pričakovano |
|---|---|
| T1 | zahteva brez prijave → `401` |
| T2 | s prijavo, a brez plačila → `402` |
| T3 | veljavno plačilo → `200` |
| T4 | trije odčitki → tri ločene poravnave |
| T5 | ponovitev istih plačilnih glav → idempotentno predvajanje |
| T6 | pokvarjen JSON na `POST /verify-payment` → `400` (ne `500`) |

Izhod je `meritve/varnostni_testi_x402_mock.csv` s stolpci `test,pricakovano,dejansko,uspeh,opomba`.
Ob neuspehu katerega koli testa agent konča z neničelno izhodno kodo.

## x402 v2 (vzporedni način)

Poleg lastnega toka naprava podpira **uradni protokol x402 v2** kot vzporedno pot. Vklopi se z
`X402_MODE=self X402_MOCK=true` in doda končne točke `GET /x402/config`, `GET /x402/reading` in
`GET /x402/payment/:id`. Samo `X402_MODE=self` (brez `X402_MOCK=true`) v tej testni konfiguraciji
**ne zažene** naprave: sredstvo je domači ETH brez pogodbe EIP-3009, zato koda pravi tek zavrne že
ob zagonu.

Semantika je namenoma enaka osnovnemu toku te mape: **N odčitkov = N poravnav x402 `exact`** (ETH, omrežje
Ethereum Sepolia), brez paketov in brez dobroimetja. Ključna razlika je v tem, **kdo plača gas**:
pri x402 ga plača **naprava (ponudnik)**, odjemalec le podpiše pooblastilo EIP-3009. Glava
`Authorization: Bearer` ostane avtentikacija in je od plačila ločena. Protokolni glavi sta
`PAYMENT-REQUIRED` (v odgovoru 402) in `PAYMENT-RESPONSE` (ob poravnavi), merilni oziroma statusni
pa `X-Verify-Ms`, `X-Settle-Ms` in `X-X402-Idempotent-Replay`.

```bash
# Terminal 1 — naprava
cd iot_naprava && X402_MODE=self X402_MOCK=true npm run mock

# Terminal 2 — agent
cd agent && ADMIN_TOKEN=<ZETON> node agent.js --x402 --queries 20
#   → meritve/x402_transakcije_mock.csv (28 stolpcev)
```

Pri `X402_MOCK=true` so podpisi in preverjanja resnična, poravnave pa **sintetične** (stolpec
`sinteticni_tx`). Popolnoma realni tek bi zahteval žeton s podporo EIP-3009, česar testna
konfiguracija z domačim ETH ne omogoča — zato je ta krak označen kot testni. Za x402 krak npm
skripte ni; požene se neposredno z `node agent.js --x402`.

Podroben opis protokola je v `../README.md`.

## Odpravljanje težav

- **Strežnik se takoj ustavi.** Manjka `iot_naprava/wallet.json` — glej razdelek Namestitev.
- **Agent javi `401`.** Manjka ali je napačen `ADMIN_TOKEN`. Žeton se ustvari enkrat in ostane
  shranjen v `iot_naprava/data/admin.json`, zato je po ponovnem zagonu isti; nov dobiš z brisanjem
  `data/admin.json` ali pa ga na napravi vsiliš s spremenljivko `ADMIN_TOKEN`.
- **Agent cilja napačen naslov.** Brez `IOT_URL` uporabi naslov iz `agent/config.json`
  (privzeto `http://127.0.0.1:3100`).
- **`Fatalna napaka … Je IoT naprava zagnana?`** Naprava ne teče ali so vrata 3100 zaprta
  (požarni zid, `sudo ufw allow 3100/tcp`).
- **Analiza javi `Ni CSV`.** Najprej poženi meritev (`cd ../agent && npm run mock`) ali ustvari
  vzorčne podatke z `../primerjava/generiraj_vzorec.py`.
- Podrobnejša navodila so v `../README.md`, v razdelkih „Postavitev na dveh napravah“,
  „Skrbniška prijava“ in „Zajem z Wiresharkom“.
