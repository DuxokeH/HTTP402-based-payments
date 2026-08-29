# 01 — Enkratno mikroplačilo za dostop do storitve

Strežnik je **ponudnik** zaščitene storitve (demo odgovor ali zunanji API). Uporabnik za **eno**
uporabo storitve opravi **eno** on-chain transakcijo na omrežju Ethereum Sepolia in s tem odklene
dostop. Plačnik je lahko človek z **MetaMask** v brskalniku ali **headless merilni klient**
(agent M2M) — protokolni potek je v obeh primerih enak.

Protokolni potek — **3 izmenjave / 6 sporočil HTTP** (vsaka vrstica z metodo je par zahteva +
odgovor; vmesna vrstica je transakcija na verigi, ne sporočilo HTTP):

```
GET  /service                    → 402 Payment Required  (payment.requestId, znesek, prejemnik)
     plačilo na Sepolii          → txHash
POST /verify-payment             → 200 { proofToken }     (strežnik prebere verigo)
POST /service  (X-Payment)       → 200 + vsebina
```

Dokazni žeton je vezan na vir (`resource`), zato ga ni mogoče uporabiti za drug vir; vsak `txHash`
je porabljen največ enkrat. Ta mapa je hkrati izhodišče za primerjavo z združeno izmenjavo
(mapa [`06_x402`](../06_x402)) in z uradnim protokolom x402 v2 (razdelek [x402 v2](#x402-v2)).

## Kaj poskus meri

Za vsako ponovitev se izmeri latenca po fazah (v ms):

| Stolpec | Faza |
|---|---|
| `t_izziv_ms` | `GET /service` → odgovor **402** |
| `t_oddaja_ms` | oddaja transakcije v omrežje (v mock načinu samo lokalni podpis navidezne transakcije, brez oddaje) |
| `t_potrditev_ms` | čakanje na potrditev v bloku (v mock načinu vedno `0` — veriga se ne uporablja) |
| `t_preverjanje_ms` | `POST /verify-payment` → dokazni žeton |
| `t_dostop_ms` | `POST /service` → vsebina |
| `t_skupaj_ms` | skupni čas ene ponovitve, merjen zvezno od izziva do prejete vsebine (ne vsota zgornjih faz) |

> `t_skupaj_ms` je merjen zvezno, zato **vključuje tudi premore `--pause-ms`**: klient počaka
> `--pause-ms` po vsaki od treh izmenjav znotraj ponovitve in še enkrat med ponovitvami. Pri
> `npm run real` (`--pause-ms 1500`) je `t_skupaj_ms` zato ≈ 4,5 s večji od dejanskega poteka; za
> primerjave uporabite vsoto faz ali tečite z `--pause-ms 0`.

Strežnik odgovorom dodaja merilne glave, kar omogoča ločitev **strežniškega časa**, **branja
verige (RPC)** in **klica zunanjega API** od omrežne latence:

| Glava | Kje nastane |
|---|---|
| `X-Request-Id` | v vsakem odgovoru |
| `X-Server-Ms` | v vsakem odgovoru poti `/service`, `/verify-payment`, `/config`, `/health` |
| `X-Chain-Read-Ms` | samo `POST /verify-payment` in samo, kadar se veriga res prebere (torej **ne** pri `MOCK_VERIFY=true`) |
| `X-Downstream-Ms` | samo `POST /service` (demo odgovor ali klic zunanjega API) |

V načinu `--real` se beležijo še `gas_enote`, `cena_gas_wei`, `provizija_wei`, `provizija_eth`
in številka bloka.

Poskus torej pokaže, kateri del skupne latence odpade na protokol HTTP 402 (nekaj ms) in kateri na
verigo (potrditev bloka, tipično večina skupnega časa), ter kolikšen je strošek ene transakcije.

## Zahteve

- **Node.js ≥ 20** in **npm** (strežnik in klient).
- **Python ≥ 3.9** za analizo (`analiza/`).
- Za **realni način**: financirana denarnica na omrežju **Ethereum Sepolia** (testni ETH iz
  javnega faucet-a) in dostop do javnega RPC ponudnika. Repozitorij **ne vsebuje nobenih ključev**
  — denarnico si ustvarite sami (glej [Namestitev](#namestitev)).
- Mock način ne potrebuje ne sredstev ne dostopa do verige.

## Struktura mape

```
01_enkratna_placila/
├─ streznik/      Express strežnik (ponudnik) + spletni vmesnik za MetaMask
│  ├─ server.js         poti /config, /health, /service, /verify-payment
│  ├─ x402.js           vzporedni način x402 v2 (poti /x402/*)
│  ├─ db.js, db_x402.js hramba zahtevkov, žetonov in porabljenih txHash (SQLite)
│  ├─ .env.example      predloga nastavitev
│  ├─ wallet.example.json  predloga za naslov prejemnika (brez ključa)
│  └─ public/           statična stran: index.html, app.js, styles.css,
│                       x402-ui.js, x402-klient.js
├─ klient/        headless merilni klient
│  ├─ merilni_klient.js    meritve latence in varnostni testi
│  ├─ x402-odjemalec.js    odjemalec za x402 v2
│  ├─ generate-wallet.js   ustvari klient/wallet.json
│  ├─ config.json          privzeti naslov strežnika in omrežje
│  └─ wallet.example.json  predloga za plačnikovo denarnico
├─ analiza/       analiza_latence.py, slog.py, requirements.txt
└─ meritve/       izhodne datoteke CSV/JSON (mapa nastane ob prvem zagonu klienta;
                  rezultati niso del repozitorija)
```

Opomba: `streznik/public/x402-klient.js` je **predzgrajen sveženj (~420 kB)**, priložen zato, da
gradnja v brskalniku ni potrebna. `public/app.js` pa knjižnico `viem` uvozi neposredno z
`https://esm.sh` (politika CSP to izrecno dovoljuje), zato demo **v brskalniku** potrebuje dostop
do interneta. Headless merilni klient tega ne potrebuje — vse meritve tečejo brez njega.

## Namestitev

```bash
cd streznik && npm ci     # ali: npm install
cd ../klient  && npm ci
```

Nastavitve strežnika:

```bash
cp streznik/.env.example streznik/.env
```

Za mock način `.env` ni nujen (`npm run mock` sam nastavi `MOCK_VERIFY=true`), za realni tek pa
preverite vsaj `RPC_URL`, `MIN_CONFIRMATIONS` in `SERVICE_PRICE_ETH`.

### Denarnici (obvezen korak pred prvim zagonom)

- **Strežnik — samo naslov prejemnika, nikoli privatnega ključa:**

  ```bash
  cp streznik/wallet.example.json streznik/wallet.json
  # v wallet.json vpišite polje "address": naslov, ki prejema plačila
  ```

  Brez datoteke `streznik/wallet.json` se strežnik **ob zagonu takoj konča** z napako.

- **Klient — samo za `--real`:**

  ```bash
  cd klient && npm run gen-wallet     # ustvari wallet.json s pravicami 0600
  ```

  Skripta obstoječe datoteke ne prepiše. Namesto tega lahko kopirate `wallet.example.json` v
  `wallet.json` in vpišete privatni ključ **financirane** denarnice Sepolia (potrebuje testni ETH
  za znesek in gas). V **mock** načinu klientova denarnica ni potrebna.

Obe datoteki `wallet.json` sta izključeni z `.gitignore` in se nikoli ne objavita.

### Pomembne nastavitve v `streznik/.env`

| Spremenljivka | Privzeto | Pomen |
|---|---|---|
| `MERCHANT_PORT` | `3000` | vrata strežnika (posluša na `0.0.0.0`) |
| `NETWORK` | `sepolia` | omrežje |
| `RPC_URL` | javni Sepolia RPC | ponudnik za branje verige |
| `MIN_CONFIRMATIONS` | `1` | zahtevano število potrditev |
| `MOCK_VERIFY` | `false` | `true` preskoči branje verige |
| `SERVICE_PRICE_ETH` | `0.0000001` | cena ene uporabe storitve |
| `ETH_EUR_RATE` | `2500` | tečaj **samo za prikaz** v EUR |
| `PROOF_TOKEN_TTL_SECONDS` | `600` | veljavnost dokaznega žetona |
| `PAYMENT_REQUEST_TTL_SECONDS` | `1800` | veljavnost plačilne zahteve (znižajte za test poteka) |
| `OPENAI_API_KEY` | prazno | prazno = determinističen demo odgovor; nastavljen ključ vklopi pravi zunanji klic in poveča `t_dostop_ms` |
| `RATE_VERIFY_PER_MIN` | `60` | omejitev zahtev na `POST /verify-payment` (na naslov IP, okno 60 s) |
| `RATE_SERVICE_PER_MIN` | `120` | omejitev zahtev na `/service` (na naslov IP, okno 60 s) |

Zadnji dve omejitvi neposredno omejujeta število ponovitev v eni minuti: ena ponovitev porabi
**eno** zahtevo `verify-payment` in **dve** zahtevi `/service`. Mock tek brez premora zato brez
spremembe nastavitev zdrži največ **60 ponovitev na minuto**; za več ponovitev zvišajte
`RATE_VERIFY_PER_MIN` in `RATE_SERVICE_PER_MIN` ali uporabite `--pause-ms`.

Privzeta cena `0.0000001` ETH pri `ETH_EUR_RATE=2500` znese ≈ **0,00025 EUR** (0,025 centa).
Gre za **testni** ETH brez denarne vrednosti; pretvorba v EUR je zgolj poročevalska.

## Lokalni zagon — mock (brez sredstev)

Mock način meri **protokolno latenco** brez branja verige, zato je ponovljiv in ne troši sredstev.

**Terminal 1 — strežnik:**

```bash
cd streznik
npm run mock          # NODE_ENV=development MOCK_VERIFY=true, vrata 3000
```

**Terminal 2 — merilni klient:**

```bash
cd klient
npm run mock          # 50 ponovitev
# ali: npm start      # 30 ponovitev
# ali: node merilni_klient.js --mock --runs 50 --out ../meritve/enkratna_mock.csv
```

Brskalnik (MetaMask demo): `http://127.0.0.1:3000` — panel „Meritve" prikaže čase posameznih faz.

## Lokalni zagon — realne meritve (Sepolia)

Zahteva financirano denarnico v `klient/wallet.json` in naslov prejemnika v `streznik/wallet.json`.

**Terminal 1 — strežnik:**

```bash
cd streznik
npm start             # brez MOCK_VERIFY: vsako plačilo se preveri na verigi
# razvojni izpis:  npm run dev
```

**Terminal 2 — klient:**

```bash
cd klient
npm run real          # = node merilni_klient.js --real --runs 5 --pause-ms 1500
```

Število ponovitev držite nizko (5–10): vsaka ponovitev je prava transakcija in porabi testni ETH
ter čaka na potrditev bloka. Premor `--pause-ms` prepreči težave z zaporedjem `nonce` (in se
šteje v `t_skupaj_ms` — glej opombo pri tabeli faz).

Za zajem v Wiresharku uporabljajte **navadni HTTP** (brez TLS), sicer glave `X-Payment`,
`X-Server-Ms` in telo odgovora **402** v zajemu niso vidni. Postopek zajema je opisan v
`../README.md`.

### Argumenti merilnega klienta

| Argument | Privzeto | Pomen |
|---|---|---|
| `--mock` / `--real` | `--mock` | način delovanja |
| `--runs N` | `30` | število ponovitev |
| `--pause-ms N` | `1000` (real), `0` (mock) | premor **med izmenjavami znotraj ponovitve (3×) in med ponovitvami**; šteje se v `t_skupaj_ms` |
| `--prompt "…"` | demo besedilo | vsebina zahteve za storitev |
| `--x402` | izklopljeno | uporabi poti x402 v2 |
| `--security` | izklopljeno | zaženi varnostne teste namesto meritve |
| `--out <pot>` | privzeto ime v `meritve/` | pot izhodnega CSV |

## Zagon na oddaljenem strežniku

Ponudnik (`streznik/`) teče na strežniku, plačnik (`klient/`) na lokalnem računalniku — povezavo
vedno vzpostavi plačnik, zato mora biti dosegljiv le strežnik.

**Na strežniku:**

```bash
ssh <UPORABNIK>@<IP_STREZNIKA>
git clone <naslov-repozitorija>
cd <repozitorij>/testna-okolja/01_enkratna_placila/streznik
npm ci
cp .env.example .env
cp wallet.example.json wallet.json     # vpišite naslov prejemnika
sudo ufw allow 3000/tcp                # odprite vrata strežnika
npm run mock                           # ali: npm start (realni način)
```

Preverjanje z lokalnega računalnika: `curl http://<IP_STREZNIKA>:3000/health`.

**Lokalno — klient meri proti oddaljenemu strežniku.** Zadošča ena okoljska spremenljivka
`MERCHANT_URL` (ima prednost pred `klient/config.json`):

```bash
cd klient
MERCHANT_URL=http://<IP_STREZNIKA>:3000 npm run mock
MERCHANT_URL=http://<IP_STREZNIKA>:3000 npm run real
```

Ta mapa nima skrbniške prijave, zato dodatni žetoni niso potrebni. Priporočeno je namesto
naslova IP uporabiti ime gostitelja — ob menjavi naslova ni treba spreminjati konfiguracije.

> **Opozorilo.** Strežnik teče po **navadnem HTTP** (namenoma, da je promet viden v Wiresharku),
> zato dostop omejite na svoj naslov IP (npr. `sudo ufw allow from <vaš-IP> to any port 3000
> proto tcp`) in strežnik po končanih meritvah ugasnite. Ne izpostavljajte ga javno dlje, kot je
> potrebno, in ne uporabljajte pravih sredstev.

## Analiza rezultatov

```bash
cd analiza
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 analiza_latence.py
```

Brez argumenta skripta sama poišče CSV v `../meritve/` po vrstnem redu **`enkratna_real.csv`,
nato `enkratna_mock.csv`** (realne meritve imajo prednost). Datoteko lahko podate tudi izrecno:

```bash
python3 analiza_latence.py ../meritve/enkratna_mock.csv
python3 analiza_latence.py ../meritve/enkratna_real.csv --out slike
```

Zastavica `--vzorec` doda na slike vodni žig „SIMULIRANI PRIMER" (za slike iz sintetičnih
podatkov). Privzeti izhodni imenik je `analiza/slike/`.

Skripta obdela **samo** CSV lastnega protokola. Datoteke `x402_enkratna_*.csv` analizira
`../primerjava/primerjava_x402.py`.

## Pričakovani izhodi

Vse merilne datoteke nastanejo v `01_enkratna_placila/meritve/`:

| Datoteka | Nastane pri |
|---|---|
| `enkratna_mock.csv` + `enkratna_mock_povzetek.json` | `npm run mock` / `npm start` (klient) |
| `enkratna_real.csv` + `enkratna_real_povzetek.json` | `npm run real` |
| `x402_enkratna_mock.csv` + `x402_enkratna_mock_povzetek.json` | `--x402` |
| `varnostni_testi_mock.csv` / `varnostni_testi_real.csv` | `--security` |
| `varnostni_testi_x402_mock.csv` | `--x402 --security` |

Klient v obstoječi CSV **dopisuje** vrstice (glavo zapiše le ob prvem nastanku datoteke),
datoteko `_povzetek.json` pa vsakič prepiše. Pred novo serijo meritev staro datoteko izbrišite
(`rm ../meritve/enkratna_mock.csv`), sicer se ponovitve seštevajo, povzetek JSON pa opisuje samo
zadnji tek.

Standardni CSV ima 20 stolpcev:

```
zap,cas_iso,nacin,t_izziv_ms,t_oddaja_ms,t_potrditev_ms,t_preverjanje_ms,t_dostop_ms,
t_skupaj_ms,streznik_preverjanje_ms,veriga_branje_ms,streznik_dostop_ms,zunanji_api_ms,
gas_enote,cena_gas_wei,provizija_wei,provizija_eth,blok,tx_hash,status
```

CSV za x402 ima 25 stolpcev (`protokol`, `topologija`, `omrezje`, `sredstvo`, `placnik_gasa`,
`t_402_ms`, `t_podpis_ms`, `t_placilo_http_ms`, `preveri_ms`, `poravnaj_ms`, `idempotenca`,
`sinteticni_tx` idr.).

Analiza zapiše v `analiza/slike/`: `01_latenca_boxplot.png`, `02_sestava_faz.png`,
`03_povzetek_tabela.png` in `povzetek_latenca.csv`.

**Signal uspeha.** Klient sproti izpisuje vrstico na ponovitev in na koncu povzetek
(`min / mediana / povprečje / p95 / maks` po fazah) ter pot do zapisanega CSV in JSON. Stolpec
`status` nosi statusno kodo HTTP zadnjega koraka, pri uspešnih ponovitvah torej `200`; neuspešna
ponovitev se v CSV **ne zapiše** (izpiše se kot `✗ ZAP <n> napaka: …`), zato je merilo uspeha
vrstica `POVZETEK · uspešnih <n>/<runs>`. Strežnik ob zagonu izpiše poslušalna vrata in naslov
prejemnika. Analitična skripta izpiše `✓` za vsako ustvarjeno datoteko.

Strežnik si ob prvem zagonu ustvari podatkovno bazo `streznik/data/x402_enkratna.db` (in
`x402_placila.db` pri `X402_MODE=self`); mapa `data/` je izključena z `.gitignore`.

## Varnostni testi

Preverjajo, da protokol zavrne napačne, ponovljene in ponarejene vhode.

**Lastni protokol:**

```bash
# strežnik za mock nabor mora teči z MOCK_VERIFY=true:
cd streznik && npm run mock
# klient:
cd klient
npm run security                             # mock (7 testov)
node merilni_klient.js --security --real     # realni način (strežnik: npm start)
```

Mock izvede 7 testov: dostop brez plačila → **402**, napačen format `txHash` → **400**,
neobstoječ `requestId` → **400**, ponarejen dokazni žeton → **403**, ponovna uporaba istega
`txHash` (replay) → **400**, prva poraba žetona → **200**, ponovna poraba istega žetona → **403**.
V načinu `--real` so zadnji trije nadomeščeni s testi napačnega prejemnika, prenizkega zneska in
neujemanja plačnika; ti so v izpisu označeni kot **preskočeni** (izvedba bi zahtevala namerno
napačne transakcije), a se štejejo kot uspeh.

Izhod: `meritve/varnostni_testi_{mock,real}.csv` s stolpci `test,pricakovano,dejansko,uspeh,opomba`.

**x402 v2 (14 testov T1–T14, samo mock):**

```bash
# strežnik:
cd streznik && X402_MODE=self X402_MOCK=true X402_MOCK_FAULTS=true npm run mock
# klient:
cd klient && node merilni_klient.js --x402 --security
```

`X402_MOCK_FAULTS=true` je **obvezen** — testa T11 in T12 (vsiljene napake poravnave) brez njega
padeta. Klient nastavi izhodno kodo `1`, če ni uspešnih vseh 14 testov.
Izhod: `meritve/varnostni_testi_x402_mock.csv`.

## x402 v2

Poleg lastnega toka (A1, domači ETH) mapa podpira **uradni protokol x402 v2** (A2) kot vzporedni
način: `GET /x402/service` v **samofacilitirani** topologiji — strežnik plačilo sam preveri **in**
poravna, odjemalec pa samo podpiše pooblastilo **EIP-3009**. Namesto ločene izmenjave za dokazni
žeton se plačilo prenese v glavah protokola x402 v2: strežnik izziv opiše v glavi
`PAYMENT-REQUIRED` odgovora 402, odjemalec podpisano pooblastilo pošlje v `PAYMENT-SIGNATURE`,
strežnik pa izid poravnave vrne v `PAYMENT-RESPONSE`. Potek ima zato **2 izmenjavi / 4 sporočila**
(glava `X-Payment` iz lastnega toka se tu ne uporablja).

```bash
# strežnik (mock — brez sredstev):
cd streznik && X402_MODE=self X402_MOCK=true npm run mock
# klient:
cd klient && node merilni_klient.js --x402 --runs 30     # → meritve/x402_enkratna_mock.csv
```

Ob `X402_MODE=self` se priklopijo poti `GET /x402/config`, `GET /x402/service` in
`GET /x402/payment/:id`; odgovori nosijo dodatne glave `X-Verify-Ms`, `X-Settle-Ms` in
`X-X402-Idempotent-Replay`.

> **Omejitev testne konfiguracije.** V tej postavitvi so zneski v **ETH na Ethereum Sepolii**,
> domači ETH pa nima pogodbe **EIP-3009**. Zato je mogoč **samo mock/sintetični** tek: strežnik z
> `X402_MODE=self` **brez** `X402_MOCK=true` in brez naslova prave pogodbe EIP-3009 ob zagonu
> namenoma **vrže napako**. Pravi tek zahteva žeton s podporo EIP-3009 (nastavitve
> `X402_USDC_ADDRESS`, `X402_ASSET_*`) in financirano poravnalno denarnico.

V brskalniku je na strani kartica „x402 v2" (MetaMask podpiše pooblastilo; uporablja sveženj
`public/x402-klient.js`). Podrobna razlaga protokola in vseh spremenljivk `X402_*`: `../README.md`.

## Odpravljanje težav

| Simptom | Vzrok in rešitev |
|---|---|
| Strežnik se takoj konča | manjka `streznik/wallet.json` — ustvarite ga iz `wallet.example.json` |
| Klient javi manjkajočo denarnico | `--real` brez `klient/wallet.json` — poženite `npm run gen-wallet` **v mapi `klient/`** |
| Klient meri `127.0.0.1` namesto strežnika | nastavite `MERCHANT_URL=http://<IP_STREZNIKA>:3000` |
| `EADDRINUSE` na vratih 3000 | vrata zaseda drug proces — spremenite `MERCHANT_PORT` v `.env` |
| Ponovitve padajo s **429** | dosežena omejitev `RATE_VERIFY_PER_MIN` (60) ali `RATE_SERVICE_PER_MIN` (120) — zmanjšajte `--runs`, dodajte `--pause-ms` ali zvišajte omejitvi |
| Realni tek se ustavi ali poteče | počasen ali omejen javni RPC — zamenjajte `RPC_URL`, povečajte `--pause-ms` |
| Nezadostna sredstva | denarnica potrebuje testni ETH za znesek **in** gas (javni faucet Sepolia) |
| Analiza javi „Ni najdenega CSV" | najprej poženite meritev: `cd ../klient && npm run mock` |
| x402 varnostna testa T11/T12 padeta | manjka `X402_MOCK_FAULTS=true` pri zagonu strežnika |

Splošna navodila: [`testna-okolja/README.md`](../README.md) — namestitev, postavitev strežnika in
pregled vseh ukazov; [zajem z Wiresharkom](../README.md#zajem-z-wiresharkom) (zajem prometa);
[uradni protokol x402 v2](../README.md#uradni-protokol-x402-v2);
[skrbniška prijava](../README.md#skrbniška-prijava) (velja za mape 02–05, ne za to mapo).
