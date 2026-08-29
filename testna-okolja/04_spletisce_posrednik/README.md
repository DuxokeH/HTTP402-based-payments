# 04 — Spletišče s posrednikom, topologija (b)

Isti tokovi in isti odjemalski vmesnik kot v mapi [`../05_spletisce`](../05_spletisce), le da
**trgovec nima dostopa do verige**. Vse plačilno stanje in vsa preverjanja opravi ločen
proces — **posrednik** (facilitator).

Kodni bazi trgovca nista dobesedno isti — v tej mapi je vsak klic verige zamenjan s klicem
posredniku (gl. [`streznik/posrednik.js`](streznik/posrednik.js)) — enako pa je natanko
tisto, kar meritev primerja: poti in glave, ki jih vidi odjemalec, cene in postopek
preverjanja. Nadzorovana spremenljivka je zato topologija, z omejitvami, naštetimi spodaj.

Mapa vsebuje **tri procese**: `posrednik/` (vrata 4000, edini z dostopom do verige),
`streznik/` (trgovec, vrata 8081) in `agent/` (merilni odjemalec). Posrednik se zažene
prvi, ker trgovec ob zagonu prevzame njegov strojni žeton.

```
        topologija (a) — mapa 05                 topologija (b) — ta mapa
   ┌──────────┐        ┌──────────┐        ┌──────────┐   ┌──────────┐   ┌──────────┐
   │ plačnik  │◄──────►│ trgovec  │        │ plačnik  │◄─►│ trgovec  │◄─►│posrednik │
   └────┬─────┘        └────┬─────┘        └────┬─────┘   └──────────┘   └────┬─────┘
        │  veriga (RPC)     │                   │  POST /submit-payment (HTTP)│
        └───────────────────┘                   │  in veriga (RPC): plačnik   │
                                                │  piše, posrednik bere       │
   2 razmerji · 3 izmenjave                     └─────────────────────────────┘
                                                3 razmerja · 5 izmenjav
```

Tretje razmerje je v (b) **neposredno**: plačnik pošlje `POST /submit-payment` posredniku
mimo trgovca (to je edina javna plačilna pot posrednika), verigo pa plačnik in posrednik
uporabljata vsak zase — plačnik odda transakcijo, posrednik jo prebere.

## Kaj poskus meri

| Poskus | Kaj meri | Primerja s |
|---|---|---|
| **plačilo na odčitek — mock** | posredniška veja, mock, plačilo na odčitek | mapa 02 (ista meritev brez posrednika) |
| **plačilo na odčitek — real** | posredniška veja, prava Ethereum Sepolia | mapa 02, realni tek |
| **merjena seja** | **posrednik × merjena seja** | mapa 03 (neposredna merjena bremenitev) |
| **štetje sporočil** | število sporočil na plačilni tok, obe veji | trditev 3-proti-5 izmenjav |

Vsaka vrstica CSV loči tri čase: kar meri odjemalec, `X-Server-Ms` (delo trgovca) in
`X-Downstream-Ms` (čakanje na posrednika). Zadnji je v neposredni veji vedno 0 — razlika
je merjeni strošek topologije. Celica **posrednik × merjena seja** je najbolj zgovorna:
merjena bremenitev sploh ne čaka na potrditev bloka (nove transakcije ni), zato dodaten
procesni skok tam ni utopljen v čakanju na verigo.

### Česa poskus ne meri

Posrednik je tu **lokalen in samogostovan** — na istem gostitelju kot trgovec, pod istim
skrbnikom. Trije stroški, ki jih literatura pripisuje posrednikom (odvisnost od
**razpoložljivosti**, odvisnost od **pravilnosti** in **privilegiran opazovalec**),
predpostavljajo *tujo, gostovano* storitev in pri lastnem posredniku ne nastopajo.

To poskus naredi **ožji, a strožji**: ker je zaupanje konstantno, ostane spremenljiva samo
procesna meja. Ob branju številk je treba upoštevati dvoje:

1. številke **niso** merilo za stroške zaupanja gostovanega ekosistema x402;
2. ker sta procesa na istem gostitelju, v številkah **ni omrežne razdalje** — izmerjeni
   pribitek je zato **spodnja meja** za pravega, oddaljenega posrednika.

### Izveden protokol

Ime „posrednik“ nosita dva različna protokola. Ta mapa izvaja lastni posredniški tok,
opisan spodaj, in ne uradnega toka x402:

| | **izvedeno tu** | uradni x402 — ni izvedeno |
|---|---|---|
| poti | `payment-request` → `submit-payment` → `verify-proof` | `verify` + `settle` |
| kdo plača gas | **plačnik**, za svojo transakcijo | **posrednik**, odda pooblastilo EIP-3009 |
| vloga posrednika na verigi | samo **bere** | **piše** — odda pooblastilo |
| sredstvo / omrežje | domači ETH na Ethereum Sepolia | žeton EIP-3009 (npr. USDC/EURC) |

Izbran je ta posredniški tok, ker ostane primerljiv z neposredno vejo, ker
teče na omrežju, ki ga projekt že uporablja, in ker so primerjalne trditve te mape izrečene
prav proti njemu. EIP-3009 (in s tem uradni tok z gostovanim posrednikom) ostaja
nadaljnje delo; delna izvedba je v razdelku [x402 v2](#x402-v2) spodaj.

Potek (5 izmenjav / 10 sporočil / 3 razmerja):

```
C → M   GET /tx/reading                        M → F   POST /payment-request
F → M   201 {requestId, paymentInfo}           M → C   402 {…, facilitatorUrl}
C → B   plačilna transakcija                   C → F   POST /submit-payment {requestId, txHash}
F → B   getTransaction + getTransactionReceipt F → C   200 {proof.token}
C → M   GET /tx/reading + X-Payment            M → F   POST /verify-proof {token}
F → M   200 {verified:true}                    M → C   200 vsebina
```

Merjene seje zgornji potek ne pokriva (je razširitev), zato sledi njegovemu
načelu — posrednik „preveri podpis, plačnikovo dobroimetje in ujemanje z navedenimi
zahtevami“:

- `POST /session/open` — trgovec posreduje polnitev; posrednik jo potrdi na verigi in odpre
  sejo (hrani dobroimetje, proračun, veljavnost);
- `POST /debit` — trgovec posreduje podpisano bremenitev; posrednik preveri podpis EIP-191,
  svežino nonca, proračun in podpisani maksimum ter odobri.

Odjemalčev vmesnik je pri tem **nespremenjen** (iste poti, iste glave kot v mapi 05) — prav
zato poskus z merjeno sejo osami topologijo in ne primerja dveh različnih API-jev.

### Popravki glede na zgodnejšo izvedbo posrednika

Zgodnejša izvedba posrednika (ni del tega repozitorija) je imela pet napak, ki bi vsaka
zase pokvarila primerjavo. Vse so v tej mapi popravljene:

| # | Napaka | Popravek tukaj |
|---|---|---|
| 1 | dokazni žeton se **nikoli ne porabi** — `/verify-proof` je bilo golo branje, en žeton je odklepal vir neomejeno | enkratna uporaba, pogoj `consumed_at IS NULL` je v SQL (varno tudi ob sočasnosti), TTL 600 s — enako kot v neposredni veji |
| 2 | **ni preverjanja ponovitve `txHash`** — ena transakcija je lahko zadostila N različnim `requestId` | `redeemed_tx_hashes` s PRIMARY KEY, unovčenje in izdaja dokazila v isti transakciji baze |
| 3 | **primerjava s plavajočo vejico** (`parseFloat(formatUnits(...)) >= parseFloat(amount)`) | izključno celoštevilski `BigInt` wei |
| 4 | `MIN_CONFIRMATIONS` **dokumentiran, a neuveljavljen** — obstoj potrdila je veljal za dovolj | globina se res izračuna (`latest − blockNumber + 1`) in zavrne prepliten vpis |
| 5 | **brez avtentikacije, brez omejevanja, trda vrata, stanje v pomnilniku** | strojni žeton za trgovca, omejitev hkratnih branj verige, `POSREDNIK_PORT`, SQLite namesto struktur v pomnilniku |

Popravki 1, 2, 3 in 5 so pokriti z `node agent.js --security`; popravek 4 preveriš ročno
(glej [Varnostni testi](#varnostni-testi)).

## Zahteve

- **Node.js ≥ 20** in npm (posrednik, trgovec, agent).
- **Python ≥ 3.9** za analizo (`matplotlib`, `pandas`, `numpy`).
- Za mock način: nič drugega — nobenih sredstev, nobene verige.
- Za realni način (prave transakcije): **financirana denarnica na omrežju Ethereum Sepolia** in dostopna
  končna točka JSON-RPC. Testni ETH dobiš iz javnega faucet-a za Sepolio. Repozitorij ne
  vsebuje nobenih ključev in nobene denarnice — te si ustvariš sam.
- Za Docker varianto: Docker in `docker compose`.

## Struktura mape

```
04_spletisce_posrednik/
├─ posrednik/          EDINI z dostopom do verige (vrata 4000)
│  ├─ server.js · db.js · auth.js · x402.js · db_x402.js
│  ├─ Dockerfile · .env.example · wallet.example.json · package.json
│  └─ data/            nastane ob zagonu: posrednik.db, admin-credentials.txt
├─ streznik/           trgovec — spletišče BREZ verige (vrata 8081)
│  ├─ server.js · posrednik.js · runner.js · db.js · auth.js · x402.js · db_x402.js
│  ├─ public/          index.html · app.js · styles.css
│  ├─ Dockerfile · .env.example · wallet.example.json · package.json
│  └─ data/            nastane ob zagonu: spletisce_posrednik.db, admin-credentials.txt
├─ agent/              merilni odjemalec
│  ├─ agent.js         plačilo na odčitek / merjena seja / varnostni testi / x402
│  ├─ count-proxy.js   števni posredovalnik (štetje sporočil)
│  └─ x402-odjemalec.js · config.json · wallet.example.json · package.json
├─ analiza/            analiza_posrednik.py · slog.py · requirements.txt
│  └─ slike/           nastane šele ob zagonu analize
├─ meritve/            CSV in JSON rezultati (nastanejo šele ob meritvi) + README.md
├─ docker-compose.yml  tri storitve: posrednik · trgovec · caddy
├─ Caddyfile
└─ README.md           (ta datoteka)
```

Ključna datoteka za razumevanje topologije je [`streznik/posrednik.js`](streznik/posrednik.js):
je natanko preslikava „vsak klic verige → klic posredniku“ in nič drugega.

## Namestitev

```bash
cd testna-okolja/04_spletisce_posrednik

# posrednik
cd posrednik && npm ci && cp .env.example .env && cd ..

# trgovec
cd streznik && npm ci && cp .env.example .env
cp wallet.example.json wallet.json      # vpiši SVOJ naslov prejemnika (address)
cd ..

# merilni agent
cd agent && npm ci && cd ..
```

`npm ci` uporabi priložen `package-lock.json`; če ta iz kakršnega koli razloga ne ustreza,
uporabi `npm install`.

Denarnice:

- **trgovec** potrebuje `streznik/wallet.json` z naslovom prejemnika, sicer se ne zažene;
  privatni ključ tam ni potreben (v mock načinu ga ne vpisuj).
- **posrednik denarnice nima** — verigo samo bere. `posrednik/wallet.example.json` je
  potreben šele za poravnalni ključ vzporednega načina x402.
- **agent** potrebuje `agent/wallet.json` samo za `--real`; v mock načinu si ustvari
  enkratno denarnico brez sredstev.

Ključe si ustvariš sam. Repozitorij jih ne vsebuje in `.gitignore` `wallet.json` ter `.env`
namenoma izključuje.

## Lokalni zagon — mock (brez sredstev)

Trije terminali. **Posrednika zaženi prvega**, ker trgovec ob zagonu prebere njegov strojni
žeton iz `../posrednik/data/admin-credentials.txt`. (Če vrstni red obrneš, trgovec žeton ob
prvi zavrnitvi 401/403 prebere naknadno — a le, kadar je posrednikova mapa `data/` na istem
gostitelju in dosegljiva. V Dockerju to ne velja, tam je `POSREDNIK_TOKEN` obvezen.)

```bash
# 1) posrednik
cd testna-okolja/04_spletisce_posrednik/posrednik
npm run mock                       # → http://localhost:4000

# 2) trgovec
cd testna-okolja/04_spletisce_posrednik/streznik
npm run mock                       # → http://localhost:8081
```

Če procesa ločiš (drug gostitelj, Docker), žeton prenesi ročno:

```bash
grep ZETON posrednik/data/admin-credentials.txt   # → POSREDNIK_TOKEN v streznik/.env
```

Skrbniško geslo spletišča (obe komponenti imata **ločeni** prijavi):

```bash
grep GESLO streznik/data/admin-credentials.txt    # prijava v spletišče trgovca
grep GESLO posrednik/data/admin-credentials.txt   # ločena prijava posrednika
```

Preveri, da je veja skladna:

```bash
curl -s localhost:8081/health | python3 -m json.tool
#   "veriga": "ni dostopa (samo posrednik)"
#   "posrednik": "ok",  "neskladjeMock": false
```

Obe mock meritvi v tretjem terminalu:

```bash
cd testna-okolja/04_spletisce_posrednik/agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../streznik/data/admin-credentials.txt | cut -d= -f2)

npm run mock            # plačilo na odčitek prek posrednika (20 poizvedb)
npm run mock-merjeno    # merjena seja prek posrednika (20 bremenitev)
```

`ADMIN_TOKEN` je žeton **trgovca** (spletišče je zaprto s skrbniško prijavo). Posrednikova
pot `/submit-payment` je javna in žetona ne potrebuje.

Zastavice agenta (CLI prepiše okoljsko spremenljivko, ta pa `agent/config.json`):
`--mock` / `--real`, `--tx` / `--merjeno`, `--queries N` (20), `--debits N` (20),
`--pause-ms N`, `--topup-wei`, `--merchant-url`, `--posrednik-url`, `--rpc-url`,
`--confirmations`, `--out <pot.csv>`, `--security`, `--x402`.

### Štetje sporočil

Posredniška veja potrebuje **dva** števca, ker ima tri razmerja. Trgovca je treba pognati
**skozi** števec posrednika, sicer se izmenjavi `payment-request` in `verify-proof` sploh
ne preštejeta in namesto petih izmenjav jih naštejemo tri.

```bash
# 1) števca (dve okni)
cd testna-okolja/04_spletisce_posrednik/agent
node count-proxy.js --listen=3101 --target=http://127.0.0.1:8081 --tag=trgovec
node count-proxy.js --listen=3102 --target=http://127.0.0.1:4000 --tag=posrednik

# 2) trgovca ponovno zaženi TAKO, da posrednika kliče skozi števec 3102
cd ../streznik && POSREDNIK_URL=http://127.0.0.1:3102 npm run mock

# 3) en sam plačilni tok skozi oba števca
cd ../agent && node agent.js --mock --tx --queries 1 \
    --merchant-url http://127.0.0.1:3101 --posrednik-url http://127.0.0.1:3102

# 4) Ctrl+C v obeh števcih → izpis povzetka in meritve/e9_<oznaka>.csv
```

Za neposredno vejo isto z enim števcem pred mapo 05 (tam mora teči njen strežnik na 8080):

```bash
node count-proxy.js --listen=3101 --target=http://127.0.0.1:8080 --tag=neposredno
```

Pričakovano: **posredniška 5 izmenjav / 10 sporočil**, **neposredna 3 / 6**. Števec posluša
samo na `127.0.0.1`. Pripravljalne poti (`/config`, `/health`, `/prijava`, `/odjava`,
`/seja`, `/run/*`, `/favicon*`) in dolgo živeči pretoki SSE so v CSV zabeleženi s stolpcem
`placilna=0` in se v plačilni tok ne štejejo.

### Zajem z Wiresharkom

Ta veja ima **dva** prometna para, zato zajemi oba: vrata **8081** (odjemalec ↔ trgovec) in
**4000** (odjemalec ↔ posrednik in trgovec ↔ posrednik). Šele oboje skupaj pokaže vseh pet
izmenjav. Splošna navodila za zajem (vmesnik, prijava, sejni piškotek) so v
[zajem z Wiresharkom](../README.md#zajem-z-wiresharkom), filtri za to vejo pa so spodaj; ker Wireshark privzeto
kot HTTP razbira le znana vrata, na 4000 in 8081 uporabi **Decode As → HTTP**.

```
tcp.port == 8081 || tcp.port == 4000
http.request.uri contains "submit-payment"    # puščica plačnik → posrednik
http.request.uri contains "verify-proof"      # puščica trgovec → posrednik
```

### Preverjanje: trgovec res nima verige

Najostrejši preizkus, da topologija (b) ni le poimenovanje. Trgovcu daj **pokvarjen**
`RPC_URL`, agentu pa pravega — plačila morajo teči naprej, ker trgovec verige nikoli ne
kliče. Dokaz je prepričljiv samo v realnem načinu: v mock načinu agent verige sploh ne
uporablja, zato tam `--rpc-url` ničesar ne dokazuje.

V **obeh** `.env` mora biti `MOCK_VERIFY=false` (posrednik mora res brati verigo). Če se
načina razlikujeta, agent meritev zavrne z „Neskladje načina“ in ne dokaže ničesar.

```bash
# trgovec z nesmiselnim RPC (posrednik teče normalno)
cd streznik && RPC_URL=http://127.0.0.1:1 npm start

# agent s pravim RPC in financirano denarnico
cd agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../streznik/data/admin-credentials.txt | cut -d= -f2)
node agent.js --real --tx --queries 5 --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

Isto pokaže statična preveritev, ki ne stane nič:

```bash
grep -n "JsonRpcProvider" streznik/server.js    # samo v komentarjih
grep -n "JsonRpcProvider" posrednik/server.js   # tu je edini pravi
```

Izjema, ki jo je pošteno navesti: `streznik/runner.js` **ima** `JsonRpcProvider`. To ni
trgovčeva vloga, ampak vgrajeni plačnik za gumba `/run/tx` in `/run/merjeno` (puščica C→B
na diagramu) — isti posel kot zunanji agent, le da teče v istem procesu. Trgovčeva pot
zahteve (`server.js`, `posrednik.js`) verige ne doseže; zunanji agent zato dokaže več kot
`grep`.

## Lokalni zagon — realne meritve (Sepolia)

Realni tek zahteva **financirano testno denarnico**; brez nje ga ni mogoče izvesti.

1. V `agent/wallet.json` vpiši privatni ključ financirane denarnice na Sepolii
   (`cp wallet.example.json wallet.json`). Testni ETH dobiš iz javnega faucet-a.
2. V `streznik/wallet.json` vpiši naslov prejemnika (lahko druga tvoja denarnica).
3. V **obeh** `.env` nastavi `MOCK_VERIFY=false` in delujoč `RPC_URL`
   (`posrednik/.env` je edini, kjer se `RPC_URL` res uporabi; trgovčev je le namig, ki ga
   posreduje plačniku).
4. Zaženi posrednika in trgovca z `npm start` (namesto `npm run mock`), nato agenta:

```bash
cd testna-okolja/04_spletisce_posrednik/posrednik && npm start     # → :4000
cd testna-okolja/04_spletisce_posrednik/streznik  && npm start     # → :8081

cd testna-okolja/04_spletisce_posrednik/agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../streznik/data/admin-credentials.txt | cut -d= -f2)
npm run real            # plačilo na odčitek · prave transakcije na Sepolii
npm run real-merjeno    # merjena seja s pravo polnitvijo
```

Vsaka poizvedba v `--real` počaka na potrditev bloka, zato tek 20 poizvedb traja nekaj
minut in porabi testni ETH (gas + `PRICE_WEI_PER_READING`). Agent globino potrditev
privzeto prevzame od posrednika; z `--confirmations N` jo lahko prisiliš.

Varnostni testi v realnem načinu **ne delujejo** (`--real --security` se konča z napako) —
namenoma, ker bi napadalni scenariji porabljali prava sredstva.

## Zagon na oddaljenem strežniku

Strežniška procesa (posrednik in trgovec) poslušata na `0.0.0.0` in tečeta po **navadnem
HTTP** — tako je zato, da je promet berljiv z Wiresharkom. Dostop zato omeji na svoj IP ali
uporabi Docker + Caddy varianto s TLS spodaj.

```bash
ssh <UPORABNIK>@<IP_STREZNIKA>
git clone <naslov-repozitorija> x402
cd x402/testna-okolja/04_spletisce_posrednik

# namestitev je enaka kot lokalno (npm ci + .env + wallet.json)

sudo ufw allow 4000/tcp    # posrednik — plačnik pošlje /submit-payment NARAVNOST sem
sudo ufw allow 8081/tcp    # trgovec
```

V `streznik/.env` je za oddaljenega plačnika **obvezna** ena nastavitev:

```bash
POSREDNIK_PUBLIC_URL=http://<IP_STREZNIKA>:4000   # to trgovec zapiše v odgovor 402
POSREDNIK_URL=http://127.0.0.1:4000               # kamor kliče trgovec sam
```

Brez `POSREDNIK_PUBLIC_URL` zunanji agent ali brskalnik dobi v odgovoru 402 naslov
`http://127.0.0.1:4000` in `POST /submit-payment` ne more oddati.

Strežnika tečeta na VM, **agent poženeš lokalno** z ustreznima naslovoma:

```bash
export ADMIN_TOKEN=<ZETON iz streznik/data/admin-credentials.txt na strežniku>
node agent.js --mock --tx --queries 20 \
    --merchant-url http://<IP_STREZNIKA>:8081 \
    --posrednik-url http://<IP_STREZNIKA>:4000
```

### Docker in Caddy (s TLS)

`docker-compose.yml` je v **korenu te mape** (ne v `streznik/`), ker sta aplikacijski
storitvi dve. Ime projekta je izrecno `x402-posrednik`: sicer bi ga Compose izpeljal iz
imena mape in bi si ta veja tiho delila omrežje in nosilce z mapo 05.

```bash
cp posrednik/.env.example posrednik/.env
cp streznik/.env.example  streznik/.env
cp streznik/wallet.example.json streznik/wallet.json   # vpiši naslov prejemnika
# v Caddyfile vpiši svojo domeno (privzeto je zapisana kot tvoja-domena.si)

docker compose up -d posrednik
grep ZETON posrednik/data/admin-credentials.txt        # → POSREDNIK_TOKEN v streznik/.env
docker compose up -d
```

V vsebnikih trgovec ne more brati posrednikove mape `data/`, zato je `POSREDNIK_TOKEN`
tam **obvezen**. `POSREDNIK_URL=http://posrednik:4000` nastavi Compose sam.

Caddy posrednika izpostavi pod predpono `/posrednik` (`handle_path` jo odstrani, poti
posrednika ostanejo nespremenjene), ker plačnik pošlje `POST /submit-payment` naravnost
njemu. V `streznik/.env` zato nastavi
`POSREDNIK_PUBLIC_URL=https://<tvoja-domena>/posrednik` in `COOKIE_SECURE=true`.

Vrata obeh aplikacijskih storitev so v `docker-compose.yml` **zakomentirana**: odkomentiraj
jih samo za zajem po navadnem HTTP (Wireshark, LAN). Pod TLS vsebina ni vidna, zato zajem
delaj po naslovu `<IP_STREZNIKA>:8081` in `<IP_STREZNIKA>:4000`, ne po domeni.

Poti `/run/tx` in `/run/merjeno` sprožita vgrajenega agenta in v realnem načinu porabljata
prava sredstva. Aplikacija ju zapira s skrbniško prijavo; v `Caddyfile` je pripravljen še
zakomentiran `basic_auth` za `/run/*`.

## Analiza rezultatov

```bash
cd testna-okolja/04_spletisce_posrednik/analiza
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 analiza_posrednik.py             # → analiza/slike/
```

Argumenta: `--nacin mock|real` (privzeto poskusi oba, kar najde) in `--out <mapa>`
(privzeto `analiza/slike`, mapa nastane sama). Permutacijski test je lastna implementacija
(20 000 ponovitev, fiksno seme), zato `scipy` ni potreben.

**Vhodi.** Skripta bere lastne `meritve/posrednik_tx_*.csv`, `meritve/posrednik_merjeno_*.csv`
in `meritve/e9_*.csv`, za **primerjalni sliki** pa še CSV iz sosednjih map:

- plačilo na odčitek → `../../02_avtomatska_placila_transakcije/meritve/transakcije_*.csv`
- merjena seja → `../../03_avtomatska_placila_dobroimetje/meritve/dobroimetje_*.csv`

Če teh ni, nastanejo samo `e7_faze_<nacin>.png` (in `e9_sporocila.png`, če je bilo izvedeno
štetje sporočil), primerjalnih slik pa ne — v izpisu to pove vrstica
„neposredne meritve (mapa 02/03) ni“.
Nadomestne vzorčne podatke za mape 01–03 lahko ustvariš z
`../../primerjava/generiraj_vzorec.py`; slike, narisane iz njih, dobijo vodni žig. Za mapo
04 vzorčnih podatkov ni — te si ustvariš z lastnim tekom.

Če ni nobene meritve, skripta izpiše navodilo in se konča z izhodno kodo 1.

## Pričakovani izhodi

CSV in JSON v `meritve/` (mapa je ob prevzemu brez rezultatov — v njej je le `README.md`):

| Datoteka | Nastane z |
|---|---|
| `posrednik_tx_mock.csv` / `posrednik_tx_real.csv` | `agent.js --tx` (plačilo na odčitek, mock / real) |
| `posrednik_merjeno_mock.csv` / `posrednik_merjeno_real.csv` | `agent.js --merjeno` (merjena seja) |
| `posrednik_tx_*_povzetek.json`, `posrednik_merjeno_*_povzetek.json` | isto — strnjena statistika teka |
| `posrednik_varnost.csv` | `agent.js --security` (stolpci `test,pricakovano,dejansko,uspeh`) |
| `e9_trgovec.csv`, `e9_posrednik.csv`, `e9_neposredno.csv` | `count-proxy.js --tag=<oznaka>` → `e9_<oznaka>.csv` |
| `x402_posrednik_tx_mock.csv` | `agent.js --x402` (brez `_povzetek.json`) |
| `x402_posrednik_varnost.csv` | `agent.js --x402 --security` |

> **Meritvene CSV se DOPOLNJUJEJO, ne prepisujejo.** Pred ponovitvijo istega poskusa staro
> datoteko izbriši, sicer se dva teka zlijeta v enega in analiza ju obravnava kot en vzorec.
> Varnostni CSV se ob vsakem teku prepišeta.

Slike v `analiza/slike/` (150 dpi; mapa nastane ob prvem zagonu analize):
`e7_faze_<mock|real>.png`, `e7_topologija_<nacin>.png`, `e8_merjeno_topologija_<nacin>.png`,
`e9_sporocila.png` in zbirna tabela `posrednik_povzetek.csv`.

Signali uspeha:

- `/health` trgovca vrne `"veriga": "ni dostopa (samo posrednik)"`, `"posrednik": "ok"` in
  `"neskladjeMock": false`;
- agent ob koncu teka izpiše povzetek in pot do zapisane CSV;
- vsi varnostni testi izpišejo `✓` in izhodna koda je 0;
- analiza za vsako sliko izpiše vrstico `✓ slika: …`.

## Varnostni testi

```bash
cd testna-okolja/04_spletisce_posrednik/agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../streznik/data/admin-credentials.txt | cut -d= -f2)
npm run security          # = node agent.js --security
```

Zahteve: oba strežniška procesa tečeta, `ADMIN_TOKEN` trgovca je nastavljen in veja je v
**mock** načinu — `--real --security` se namenoma konča z napako. Zbirka ima **20 testov**:
trgovec brez verige, `/tx/verify` vrne 404, enkratnost dokazila (napaka 1), ponovna uporaba
`txHash` (napaka 2), celoštevilska primerjava wei (napaka 3), avtentikacija posrednika
(napaka 5), `/health` ostaja javen, ter merjena seja (manjkajoč podpis → 402, ponovitev
nonca → 403, ponarejen podpis → 403, zastarel nonce → 400, presežen proračun → 402,
izčrpano dobroimetje → 402, podpis za drugo sejo → 403). Če kateri test pade, je izhodna
koda 1.

Popravek napake 4 (`MIN_CONFIRMATIONS`) v zbirki ni, ker zahteva prirejen RPC. Preveri ga
ročno: globinski test se sproži šele pri `MIN_CONFIRMATIONS > 1`, zato v mapi `posrednik`
poženi `MOCK_VERIFY=false MIN_CONFIRMATIONS=3 RPC_URL=<prirejen> npm start` — vpis v plitvem
bloku mora vrniti sporočilo `Premalo potrditev (N < M)`.

Razdelitev pooblastil je namenoma stroga in jo testi preverjajo:

- **posrednik** — javno je samo `/health`, `/config`, `/submit-payment`, `/x402/supported`,
  `/prijava`, `/odjava`; vse ostalo (`/payment-request`, `/verify-proof`, `/session/*`,
  `/debit`, `/x402/verify`, `/x402/settle`, `/x402/reconcile`, `/x402/payment/:id`)
  zahteva `Authorization: Bearer <ZETON>`;
- **trgovec** — zaprto je vse razen `/health`, `/prijava` in `/odjava`.

## x402 v2

Posrednik poleg lastnega protokola (nedotaknjen; osnova za vse meritve te mape) izvaja tudi **prave
facilitatorske poti x402**: `POST /x402/verify`, `POST /x402/settle` (oboje s strojnim
žetonom), javni `GET /x402/supported` in dodatek `POST /x402/reconcile`. Posrednik poseduje
poravnalni ključ in edini dostop do verige. Trgovec (`X402_MODE=facilitated`) streže
`GET /x402/enkratno/service` in `GET /x402/tx/reading` ter ob zagonu **odkloni**
`X402_RPC_URL` in vsak drug način kot `facilitated` — brez verige ostane v obeh načinih.
Merjeni tok ostane izključno na lastnem protokolu.

```bash
# posrednik:  X402_MODE=self X402_MOCK=true npm run mock
# trgovec:    X402_MODE=facilitated npm run mock

cd agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../streznik/data/admin-credentials.txt | cut -d= -f2)
node agent.js --x402 --queries 20     # → meritve/x402_posrednik_tx_mock.csv
node agent.js --x402 --security       # 11 testov (T1–T11)
```

Konfiguracija je **testna**: denominirana v domačem ETH na Ethereum Sepolii, poravnava pa je
sintetična (mock). Pravi, ne-mock tek je zaklenjen namenoma — domači ETH nima pogodbe
EIP-3009, zato bi ga bilo treba priklopiti na žeton (USDC/EURC). Podrobnosti so v
[uradni protokol x402 v2](../README.md#uradni-protokol-x402-v2).

## Prenosljivost na druga omrežja

Ali bi ta veja tekla na Sepolii, produkcijskem Ethereumu, Bitcoinu ali z žetoni USDC/EURC —
in kaj bi bilo treba za to spremeniti — je opisano v [`../docs/OMREZJA.md`](../docs/OMREZJA.md). Na
kratko: posredniška veja je za preskok na žetone **najkrajša pot**, ker se ob prehodu
spremeni samo posrednik, trgovec pa ostane nedotaknjen.

## Odpravljanje težav

| Simptom | Vzrok in rešitev |
|---|---|
| trgovec se ob zagonu ustavi z `Copy wallet.example.json -> wallet.json` | manjka `streznik/wallet.json` z naslovom prejemnika |
| `/health` vrne `"posrednik": "down"` | posrednik ne teče ali je `POSREDNIK_URL` napačen — posrednika **zaženi prvega** |
| `/health` vrne `"neskladjeMock": true` | `MOCK_VERIFY` se med trgovcem in posrednikom razlikuje; poenoti obe `.env` |
| trgovec vrača 401 na vsem razen `/health`, `/prijava` in `/odjava` | agentu manjka `ADMIN_TOKEN` trgovca (ne posrednikov) |
| posrednik vrača 401 na `/payment-request` | trgovcu manjka `POSREDNIK_TOKEN` (obvezen, kadar ne more brati posrednikove mape `data/`) |
| zunanji plačnik ne more oddati `/submit-payment` | v `streznik/.env` manjka `POSREDNIK_PUBLIC_URL=http://<IP_STREZNIKA>:4000` |
| števec našteje 3 izmenjave namesto 5 | trgovec ni pognan skozi števec — `POSREDNIK_URL=http://127.0.0.1:3102 npm run mock` |
| trgovec se ustavi z napako o `X402_RPC_URL` | v topologiji (b) trgovec verige ne sme imeti; spremenljivko odstrani |
| analiza nariše samo `e7_faze_*.png` | manjkajo CSV iz map 02 in 03 (glej [Analiza rezultatov](#analiza-rezultatov)) |
| analiza se konča z izhodno kodo 1 | v `meritve/` ni nobene CSV — najprej poženi meritev |

Splošna navodila: [`testna-okolja/README.md`](../README.md) — razdelka
[Kaj pokaže katero okolje](../README.md#kaj-pokaže-katero-okolje) in
[Priporočen vrstni red poskusov](../README.md#priporočen-vrstni-red-poskusov);
[skrbniška prijava](../README.md#skrbniška-prijava) (skrbniške prijave in žetoni);
[`../docs/IDENTITETA.md`](../docs/IDENTITETA.md) (seje in omejevanje). Recept za štetje
sporočil je v razdelku [Štetje sporočil](#štetje-sporočil) zgoraj.
