# 06 — Združena izmenjava: 4 sporočila namesto 6

Različica scenarija [`01_enkratna_placila`](../01_enkratna_placila) z **združeno izmenjavo**:
preverjanje plačila na verigi in dostava plačane vsebine potekata v **isti** zahtevi in istem
odgovoru. Celoten plačani potek zato obsega **2 izmenjavi / 4 sporočila HTTP** namesto 3 / 6.
Poti `POST /verify-payment` v tej mapi **ni** — njena odsotnost je bistvo različice.

Vse ostalo je namenoma enako kot v mapi 01: isti preveritveni cevovod, ista cena, isto omrežje
(Ethereum Sepolia), ista merilna instrumentacija. Primerjava obeh map zato osami **eno samo
spremenljivko** — ali za dokazni žeton porabimo svojo izmenjavo ali ne.

## Kaj poskus meri

- **Latenco združene faze** `t_zdruzeno` (`POST /service`: preverjanje + dostava) proti vsoti
  `t_preverjanje + t_dostop` iz mape 01. Pričakovano:
  `t_zdruzeno ≈ t_preverjanje + t_dostop − 1 × RTT`.
- **Število sporočil na žici.** Plačani potek ima natanko **dva** para zahteva/odgovor
  (mapa 01 jih ima tri). V zajemu Wireshark je pred njima še ena zahteva `GET /health`, s
  katero merilni klient ob zagonu preveri dosegljivost strežnika — ni del plačilnega poteka.
- **Razgradnjo latence po fazah** (izziv 402, oddaja transakcije, čakanje na potrditev,
  združena faza) v mock in realnem načinu.
- **Strežniške deleže latence** prek merilnih glav `X-Server-Ms`, `X-Chain-Read-Ms`
  (samo ne-mock) in `X-Downstream-Ms`.
- **Odpornost protokola** na tipične napade in napake (10 varnostnih testov).

## Zakaj združena izmenjava

Lastni protokol v mapi 01 opravi **3 izmenjave / 6 sporočil**:

```
1→ GET /service                        ←2  402 (izziv: requestId, naslov, znesek)
        (plačilo na verigi + čakanje na potrditev — izven HTTP)
3→ POST /verify-payment {txHash}       ←4  200 {proofToken}
5→ POST /service (X-Payment: proof)    ←6  200 {vsebina}
```

V trenutku, ko strežnik od verige dobi potrdilo o transakciji (korak 4), ima **že vse**, kar
potrebuje za dostavo vsebine. Ločitev korakov 4 in 5–6 je bila **oblikovalska odločitev**
(izolacija napak, ponovljivo preverjanje, ponovna uporaba istega cevovoda pri dobroimetju v
mapi 03), ne tehnična nujnost. Ta mapa preizkusi združeno različico:

```
1→ GET /service  (X-Payer)             ←2  402 (izziv: requestId, naslov, znesek, TTL)
        (klient ali MetaMask plača na verigi, počaka potrditev, dobi txHash)
3→ POST /service {requestId, txHash,   ←4  200 {response, proofToken, payment{txHash, blockNumber}}
         network, payerAddress, prompt}
```

- Sporočilo 3 nosi hkrati **dokaz o plačilu** (`txHash`) in **naročilo** (`prompt`).
- Strežnik izvede isti preveritveni cevovod kot mapa 01 (obstoj transakcije, število potrditev,
  status, prejemnik, plačnik, znesek, zaščita pred ponovitvijo `txHash`), nato pa v **istem
  odgovoru** vrne vsebino in dokazni žeton.
- Odjemalec žeton shrani (brskalnik: `sessionStorage`). Kasnejši `GET /service` z glavo
  `X-Payment: proof_…` vrne **200 s potrdilom**, da je bilo plačilo že opravljeno
  (`authorized`, `consumed`, `expiresAt`) — brez novega plačila.
- V brskalniškem demu klient po potrditvi MetaMask **samodejno** pošlje `txHash` (sporočilo 3);
  uporabnik ne klika dodatnega koraka.

### Robni primeri

- **Izpad zunanjega API-ja po uspešnem preverjanju:** plačilo je že unovčeno, zato strežnik
  vrne **502 skupaj s `proofToken`** — dokaz o plačilu ostane pri odjemalcu.
- **Dosežena dnevna kapica AI:** **503 z NEporabljenim `proofToken`**; žeton se unovči kasneje
  prek **rezervne poti** `POST /service` z glavo `X-Payment` (semantika mape 01 je ohranjena kot
  rezervna pot za prav te primere).
- **Ponovitev istega `txHash`:** tabela `redeemed_tx_hashes` (ista zaščita kot v 01) → **400**.
- **Ponovna poraba žetona:** žeton je enkraten in se porabi *pred* klicem navzdol, zato drugi
  poskus vrne **403**.

### Primerjava s protokoloma

| | sporočila (odjemalec) | plačilo potuje | kdo poravna |
|---|---|---|---|
| 01 lastni | 6 | izven HTTP (nativni ETH) | odjemalec |
| **06 združeni** | **4** | izven HTTP (nativni ETH) | odjemalec |
| uradni x402 v2 | 4 | v glavi (podpis EIP-3009) | strežnik / posrednik |

Združena različica se po **številu sporočil** izenači z uradnim x402, ostane pa lasten protokol:
plačilo je poravnano izven pasu (nativni ETH ne pozna `transferWithAuthorization`), strežnik
verigo le bere.

## Zahteve

- **Node.js ≥ 20** in **npm** (strežnik in klient).
- **Python ≥ 3.9** za analizo (`matplotlib`, `pandas`, `numpy`).
- Za **realni način**: financirana denarnica na omrežju **Ethereum Sepolia** (testni ETH iz
  javnega faucet-a) za znesek plačila in gas. Repozitorij **ne vsebuje nobenih ključev** —
  denarnico si ustvariš sam.
- Mock način deluje **brez denarnice, brez sredstev in brez dostopa do verige**.

## Struktura mape

```
streznik/    Express strežnik (ponudnik), vrata 3300, MetaMask demo na /
  server.js        združeni tok: GET /service (402 / potrdilo), POST /service (preverjanje + dostava)
  db.js            SQLite: payment_requests, payment_proofs, redeemed_tx_hashes, openai_usage
  x402.js          vzporedni uradni protokol x402 v2 (privzeto izklopljen)
  db_x402.js       ločena baza za x402 v2
  public/          brskalniški demo (index.html, app.js, x402-klient.js, x402-ui.js, styles.css)
  .env.example     predloga nastavitev
  wallet.example.json  predloga: samo NASLOV prejemnika

klient/      headless merilni klient
  merilni_klient.js    meritev latence po fazah + varnostni testi
  x402-odjemalec.js    odjemalec za vzporedni način x402 v2
  generate-wallet.js   ustvari novo klient/wallet.json
  config.json          MERCHANT_URL, ENDPOINT, NETWORK, RPC_URL, CONFIRMATIONS
  wallet.example.json  predloga: privatni ključ plačnika (samo za --real)

analiza/     analiza_latence.py, slog.py, requirements.txt
```

Mape `meritve/`, `streznik/data/`, `analiza/slike/`, `node_modules/` ter datoteki `wallet.json`
in `.env` v repozitoriju **ne obstajajo** in so gitignorirane: mape nastanejo ob zagonu,
`wallet.json` in (neobvezni) `.env` pa si ustvariš sam po navodilih spodaj.

## Namestitev

```bash
# strežnik
cd streznik
npm ci                                   # ali: npm install
cp .env.example .env                     # neobvezno — vsi privzetki so v kodi
cp wallet.example.json wallet.json       # OBVEZNO: vpiši naslov prejemnika

# klient
cd ../klient
npm ci                                   # ali: npm install
```

**Strežniška `wallet.json` je obvezna tudi v mock načinu.** Če datoteke ni, `server.js` zabeleži
`fatal` in se konča z izhodno kodo 1. Vsebuje **samo naslov** prejemnika — nikoli privatnega
ključa:

```json
{ "address": "0xTvojNaslovPrejemnika" }
```

Za mock zadošča katerikoli veljaven naslov; za realni tek vpiši naslov, na katerem želiš videti
prejeta plačila.

**Klientova denarnica** je potrebna **samo za `--real`**. Ustvari si jo sam:

```bash
cd klient
npm run gen-wallet     # ustvari klient/wallet.json (mode 0600, obstoječe ne prepiše)
```

Izpisani naslov napolni iz javnega faucet-a za Sepolio. Alternativno prekopiraj
`wallet.example.json` v `wallet.json` in vpiši privatni ključ že financirane denarnice.
Datotek `wallet.json` in `.env` **nikoli ne dodajaj v git** (pokriva ju `.gitignore`).

## Lokalni zagon — mock (brez sredstev)

Mock preskoči branje verige: strežnik transakcijo sestavi iz telesa zahteve. Meri se torej
**čista protokolna latenca**, ponovljivo in brezplačno.

**Terminal 1 — strežnik:**

```bash
cd streznik
npm run mock            # NODE_ENV=development MOCK_VERIFY=true, vrata 3300
```

**Terminal 2 — klient:**

```bash
cd klient
npm run mock            # 50 ponovitev → ../meritve/zdruzena_mock.csv
# ali: npm start        # 30 ponovitev, ista izhodna datoteka
```

Brskalniški demo je na `http://localhost:3300/`, zdravje strežnika na `http://localhost:3300/health`,
nastavitve na `http://localhost:3300/config`.

**Omejitev hitrosti:** `POST /service` sprejme **60 zahtev na minuto** z istega naslova IP
(`RATE_VERIFY_PER_MIN`), `GET /service` pa 120 (`RATE_SERVICE_PER_MIN`). Dva zaporedna
`npm run mock` (2 × 50 zahtev POST) v isti minuti zato zadeneta **429**. Med tekoma počakaj
minuto ali zvišaj `RATE_VERIFY_PER_MIN` (spremenljivke ni v `.env.example` — vrstico dodaj
v `.env` ali jo podaj v ukazni vrstici: `RATE_VERIFY_PER_MIN=300 npm run mock`).

Uporabne zastavice klienta:

| zastavica | privzeto | pomen |
|---|---|---|
| `--real` | brez = mock | pravi tek (zahteva `klient/wallet.json` s `privateKey`) |
| `--runs N` | 30 | število ponovitev |
| `--pause-ms N` | 1000 (real), 0 (mock) | premor med fazami in med ponovitvami |
| `--prompt "…"` | testni poziv | vsebina naročila v sporočilu 3 |
| `--out POT` | glej *Pričakovani izhodi* | ročno določena izhodna datoteka CSV |
| `--security` | izklop | varnostni testi namesto meritve |
| `--x402` | izklop | vzporedni uradni način x402 v2 |

## Lokalni zagon — realne meritve (Sepolia)

Vsaka ponovitev pošlje **pravo transakcijo** na Sepolio in porabi testni ETH (privzeta cena
`SERVICE_PRICE_ETH=0.0000001` + gas). Pred realnim tekom **pobriši mock rezultate** — datoteke
CSV se **pripenjajo**, sicer se teki pomešajo v isti datoteki:

```bash
rm -f ../meritve/zdruzena_mock.csv ../meritve/zdruzena_mock_povzetek.json
```

**Terminal 1 — strežnik:**

```bash
cd streznik
npm start                                     # brez MOCK_VERIFY, pravo branje verige
curl -s localhost:3300/config | grep -o '"mockVerify":[a-z]*'   # mora biti false
```

**Terminal 2 — klient:**

```bash
cd klient
npm run real            # = node merilni_klient.js --real --runs 5 --pause-ms 1500
```

Rezultat: `../meritve/zdruzena_real.csv` (z dejansko porabo gasa in številkami blokov) in
`zdruzena_real_povzetek.json`.

Če želiš potek posneti z Wiresharkom, zajem zaženi **pred** klientom in uporabi navaden
`http://` (glej [zajem z Wiresharkom](../README.md#zajem-z-wiresharkom)). Plačani potek mora
imeti natanko **dva** para zahteva/odgovor — to je merljiva razlika proti trem parom v mapi 01.
Uvodni `GET /health` merilnega klienta pri štetju ne šteje; v Wiresharku ga izloči s filtrom
`http.request.uri != "/health"`.

Zunanji API (OpenAI) je **neobvezen**. Brez `OPENAI_API_KEY` strežnik vrne determinističen demo
odgovor, kar je za merjenje latence zaželeno, ker odstrani šum tuje storitve.

## Zagon na oddaljenem strežniku

Tipična postavitev: **strežnik na oddaljenem računalniku (VM), klient lokalno.**

```bash
# na VM
ssh <UPORABNIK>@<IP_STREZNIKA>
git clone <URL_REPOZITORIJA> x402
cd x402/testna-okolja/06_x402/streznik
npm ci
cp .env.example .env
cp wallet.example.json wallet.json      # vpiši naslov prejemnika
sudo ufw allow 3300/tcp                 # odpri vrata
npm run mock                            # ali: npm start za realni tek
```

Klient teče lokalno; edina spremenljivka, ki jo potrebuje, je **`MERCHANT_URL`**:

```bash
cd klient
MERCHANT_URL=http://<IP_STREZNIKA>:3300 npm run mock
MERCHANT_URL=http://<IP_STREZNIKA>:3300 node merilni_klient.js --real --runs 5 --pause-ms 1500
```

Namesto okoljske spremenljivke lahko `MERCHANT_URL` trajno vpišeš v `klient/config.json`
(privzeto `http://127.0.0.1:3300`). Okoljska spremenljivka ima prednost pred datoteko. Enako
velja za `ENDPOINT`, `NETWORK`, `RPC_URL` in `CONFIRMATIONS`.

Priporočeno je **ime gostitelja** namesto naslova IP: ob menjavi naslova strežnika
konfiguracije ni treba spreminjati.

> **Opozorilo.** Strežnik namenoma teče po navadnem **HTTP brez TLS**, da sta v zajemu
> Wireshark vidna odgovor 402 in glava `X-Payment`. To je merilna postavitev, ne produkcijska:
> dostop do vrat 3300 omeji na svoj naslov IP (npr. `sudo ufw allow from <TVOJ_IP> to any port
> 3300 proto tcp`) in strežnika ne puščaj odprtega dlje, kot traja meritev. V tej mapi ni
> Dockerfile ne obratnega posrednika — strežnik se poganja neposredno z `npm`.

Ta mapa **nima skrbniške prijave** in ne uporablja `ADMIN_TOKEN` — oboje potrebujejo scenariji
02–05 (glej [skrbniška prijava](../README.md#skrbniška-prijava)).

## Merjene faze

| faza | pomen |
|---|---|
| `t_izziv` | `GET /service` → 402 (sporočili 1 + 2) |
| `t_oddaja` | podpis in oddaja transakcije (do `txHash`); v mock načinu **samo lokalni podpis** navidezne transakcije, brez oddaje |
| `t_potrditev` | čakanje na blok (real; v mock načinu vedno 0) |
| `t_zdruzeno` | `POST /service` → 200 (sporočili 3 + 4: preverjanje + dostava) |
| `t_skupaj` | od začetka do konca poteka |

Strežnik ob **vsakem** odgovoru vrne `X-Server-Ms` in `X-Request-Id`. Glavo `X-Chain-Read-Ms`
doda samo `POST /service` v ne-mock načinu, `X-Downstream-Ms` pa samo odgovor, ki dejansko
dostavi vsebino (na 402, 400, 403 in 502 je ni). Vse štiri so izpostavljene prek CORS, zato so
berljive tudi v brskalniškem demu.

## Analiza rezultatov

```bash
cd analiza
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 analiza_latence.py
```

Brez argumenta skripta sama poišče vhodno datoteko po vrstnem redu
`../meritve/zdruzena_real.csv` → `../meritve/zdruzena_mock.csv` →
`../meritve/_vzorec/zdruzena_real.csv` → `../meritve/_vzorec/zdruzena_mock.csv` — **realne
meritve imajo prednost pred mock**. Zato pred novim mock tekom pobriši star
`zdruzena_real.csv`, če želiš graf mock meritev, ali datoteko navedi izrecno:

```bash
python3 analiza_latence.py ../meritve/zdruzena_mock.csv
python3 analiza_latence.py ../meritve/zdruzena_real.csv --out slike
```

Če skripta ne najde nobene datoteke CSV, izpiše navodilo in se konča z izhodno kodo 1.

Skripta pozna tudi zastavico `--vzorec`, ki grafe označi z vodnim žigom
„SIMULIRANI PRIMER — NE PRAVE MERITVE“. Žig se doda tudi samodejno, kadar je v poti vhodne
datoteke `_vzorec`. Mapa `../meritve/_vzorec/` v repozitoriju **ne obstaja** in je generator v
[`../primerjava/generiraj_vzorec.py`](../primerjava/generiraj_vzorec.py) **ne ustvarja** za
scenarij 06 (pozna samo scenarije 01–03) — vhodne podatke si ustvariš z dejanskim tekom.

Datoteke `x402_zdruzena_*.csv` (vzporedni način x402 v2) imajo **drugačno glavo**; samodejno
iskanje jih ne pobere in `analiza_latence.py` jih ne zna obdelati.

## Pričakovani izhodi

Vse merilne datoteke nastanejo v `06_x402/meritve/` (mapa se ustvari sama):

| ukaz | CSV | povzetek JSON |
|---|---|---|
| `npm run mock` / `npm start` (klient) | `zdruzena_mock.csv` | `zdruzena_mock_povzetek.json` |
| `npm run real` | `zdruzena_real.csv` | `zdruzena_real_povzetek.json` |
| `node merilni_klient.js --x402` | `x402_zdruzena_mock.csv` | `x402_zdruzena_mock_povzetek.json` |
| `npm run security` | `varnostni_testi_mock.csv` | — |
| `node merilni_klient.js --security --real` | `varnostni_testi_real.csv` | — |
| `node merilni_klient.js --x402 --security` | `varnostni_testi_x402_mock.csv` | — |

Merilni CSV se **pripenjajo** (glava se zapiše samo ob prvem nastanku), varnostni CSV se
prepiše. Če želiš čist tek, prejšnjo datoteko pobriši.

Glava `zdruzena_*.csv` (18 stolpcev):
`zap, cas_iso, nacin, t_izziv_ms, t_oddaja_ms, t_potrditev_ms, t_zdruzeno_ms, t_skupaj_ms,
streznik_zdruzeno_ms, veriga_branje_ms, zunanji_api_ms, gas_enote, cena_gas_wei, provizija_wei,
provizija_eth, blok, tx_hash, status`

Analiza zapiše v `analiza/slike/`:

- `01_latenca_boxplot.png` — škatlasti diagram po fazah (samodejna logaritemska skala, če je
  razpon večji od 50×)
- `02_sestava_faz.png` — medianska sestava poteka (naložen vodoravni stolpec)
- `03_povzetek_tabela.png` — tabela min / mediana / povprečje / p95 / maks
- `povzetek_latenca.csv` — ista tabela v obliki CSV

Rišejo se samo faze z vsoto nad 0, zato se v mock načinu `t_potrditev` (vedno 0) samodejno
izpusti.

Signali uspeha: strežnik ob zagonu izpiše vrata in način (`mockVerify`), klient med tekom
izpisuje zaporedne ponovitve in na koncu povzetek s statistiko faz ter potjo do CSV. Baza
`streznik/data/x402_zdruzena.db` nastane ob prvem zagonu.

## Varnostni testi

```bash
cd klient
npm run security        # 10 testov v mock načinu → ../meritve/varnostni_testi_mock.csv
```

Preverjeno je: T1 dostop brez plačila → 402 · T2 napačen format `txHash` → 400 · T3 neobstoječ
`requestId` → 400 · T4 ponarejen žeton na `POST /service` → 403 · T5 ponarejen žeton na
`GET /service` → 403 · T6 pokvarjen JSON → 400 (in ne 500) · T7 združena izmenjava → 200 z
žetonom · T8 ponovitev istega `txHash` → 400 · T9 potrdilo o plačilu prek `GET /service` → 200
(`authorized`, `consumed`) · T10 ponovna poraba žetona → 403.

Različica proti pravi verigi:

```bash
node merilni_klient.js --security --real     # → ../meritve/varnostni_testi_real.csv
```

Zapiše 9 vrstic: testi T1–T6 se dejansko izvedejo, zadnji trije (napačen prejemnik, prenizek
znesek, neujemanje plačnika) pa se zapišejo kot **`preskočeno`** in štejejo za uspešne — v
tem CSV torej niso dejanske meritve.

Klient pred vsakim tekom pokliče `GET /health`. Če strežnik ni dosegljiv, izpiše „Je strežnik
zagnan?“ in se konča z izhodno kodo 1.

## x402 v2 (vzporedni način)

Poleg lastnega protokola strežnik ponuja **vzporedno izvedbo uradnega protokola x402 v2** na
ločenih poteh `GET /x402/config`, `GET /x402/service` in `GET /x402/payment/:id`. Priklopijo se
samo, kadar `X402_MODE` ni `off`. Datoteke `x402.js`, `db_x402.js`, `x402-odjemalec.js` in
`x402-klient.js` so enake kot v mapi 01 (konvencija vzporednega načina). Podrobnosti:
[uradni protokol x402 v2](../README.md#uradni-protokol-x402-v2).

```bash
# strežnik
cd streznik
X402_MODE=self X402_MOCK=true npm run mock

# klient
cd ../klient
node merilni_klient.js --x402 --runs 30       # → ../meritve/x402_zdruzena_mock.csv
node merilni_klient.js --x402 --security      # → ../meritve/varnostni_testi_x402_mock.csv
```

Dve omejitvi, ki ju je treba poznati:

- **Pravi (ne-mock) tek x402 je zaklenjen.** Ob `X402_MODE≠off` in `X402_MOCK≠true` se strežnik
  ob zagonu namerno konča z napako, dokler je `X402_USDC_ADDRESS` ničelni naslov: nativni ETH
  ne pozna `transferWithAuthorization`, zato x402 v tej mapi teče **izključno mock** (poravnave
  so sintetične, `tx_hash` ima predpono `0x6d6f636b6d6f636b`). Za pravi tek bi bil potreben
  žeton EIP-3009 (npr. USDC) in nastavitve `X402_ASSET_*`.
- **Testa T11 in T12** od 14 varnostnih testov x402 zahtevata še `X402_MOCK_FAULTS=true` na
  strežniku; brez tega padeta in proces se konča z izhodno kodo 1:

  ```bash
  X402_MODE=self X402_MOCK=true X402_MOCK_FAULTS=true npm run mock
  ```

Kombinacija `--x402 --security --real` se takoj konča z izhodno kodo 1 (varnostni testi x402 so
samo za mock). Kombinacija `--x402 --real` (meritev) se konča z izhodno kodo 1, dokler v
`klient/wallet.json` ni ključa `x402PayerPrivateKey` — pravi tek pa je tako ali tako zaklenjen
že na strežniku (glej prvo omejitev zgoraj).

Uradni x402 v2 ima na žici prav tako **4 sporočila** — razlika je v tem, **kaj** potuje v drugem
paru: pri x402 podpisano pooblastilo EIP-3009 (poravna strežnik), tu pa dokaz o že poravnani
transakciji (poravnal je odjemalec).

## Odpravljanje težav

| simptom | vzrok in rešitev |
|---|---|
| strežnik se takoj konča (`fatal … wallet.json`) | manjka `streznik/wallet.json` — `cp wallet.example.json wallet.json` in vpiši naslov |
| klient: „Je strežnik zagnan?“ | strežnik ne teče ali je `MERCHANT_URL` napačen; preveri `curl http://<IP_STREZNIKA>:3300/health` |
| odgovor **429** | presežena omejitev 60 zahtev `POST /service` na minuto — počakaj minuto ali zvišaj `RATE_VERIFY_PER_MIN` |
| grafi kažejo napačen tek | `analiza_latence.py` daje prednost `zdruzena_real.csv`; navedi datoteko izrecno ali pobriši staro |
| v CSV je več tekov skupaj | merilni CSV se pripenjajo — pred novim tekom datoteko pobriši |
| `--real` se konča takoj | manjka `klient/wallet.json` s `privateKey` — `npm run gen-wallet` in napolni denarnico iz faucet-a |
| strežnik z `X402_MODE` se ne zažene | pričakovano: pravi x402 tek je zaklenjen, dodaj `X402_MOCK=true` |

Splošna navodila so v skupnem [`testna-okolja/README.md`](../README.md) — namestitev, postavitev
na oddaljenem strežniku in zaporedje ukazov za vse scenarije. Posamezni razdelki:
[zajem z Wiresharkom](../README.md#zajem-z-wiresharkom),
[uradni protokol x402 v2](../README.md#uradni-protokol-x402-v2) in
[skrbniška prijava](../README.md#skrbniška-prijava) (velja za scenarije 02–05, ne za tega).
