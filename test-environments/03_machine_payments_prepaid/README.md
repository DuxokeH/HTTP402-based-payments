# 03 — Merjena predplačniška seja z dobroimetjem

**Scenarij:** ista IoT postavitev kot mapa `02`, a agent izvede **eno samo on-chain polnitev
(top-up)**, ki odpre **predplačniško sejo**, nato pa vsak odčitek plača s **kriptografskim
podpisom EIP-191** — brez nove transakcije. **20 odčitkov = 1 transakcija + 20 podpisov.**

Mapa `02` je namenoma draga osnova (kumulativni gas raste linearno z N). Ta mapa je njeno
nasprotje: strošek verige je konstanten, ne glede na število odčitkov. Skupaj tvorita ključno
primerjavo, ki jo združi `../primerjava/`.

## Kaj poskus meri

Za vsako podpisano bremenitev se izmeri:

- `t_podpis_ms` — čas izdelave podpisa EIP-191 pri odjemalcu,
- `t_zahteva_ms` — čas omrežja in strežnika (HTTP krožna pot),
- `streznik_ms` — čas obdelave na strani naprave (glava `X-Server-Ms`),
- `cena_wei` — zaračunana cena (glava `X-Charged-Wei`),
- `dobroimetje_wei` in `proracun_ostanek_wei` — preostanek dobroimetja in proračuna po bremenitvi.

Prva vrstica meritve je **polnitev** — edina vrstica, ki lahko nosi `gas_enote` in
`provizija_eth`; izpolnjena sta samo v realnem načinu, v mock načinu ostaneta prazna.
Poudarek poskusa: **on-chain transakcija je natanko ena**, latenca posamezne bremenitve pa ne
vsebuje čakanja na potrditev na verigi (dejanske vrednosti so odvisne od strojne opreme in
omrežja — izmeriš jih z zagonom).

Seja izpolnjuje tri zahteve — omejeno dobroimetje, proračun in čas veljavnosti:

| Zahteva | V kodi |
|---|---|
| omejeno **dobroimetje** | `deposit_wei` (preostanek = `deposit − spent`) |
| **proračun** | `budget_wei` (poraba ga nikoli ne sme preseči) |
| **čas veljavnosti** | `expires_at` (bremenitve po poteku so zavrnjene) |

Podpisano sporočilo veže vse elemente skupaj:

```
x402-debit:{payer}:{session}:{nonce}:{path}:{maxWei}
```

Nedvoumno povezuje plačnika, sejo, enkratno kodo (nonce), vir in cenovno mejo. Zahteva nosi
glave `X-Payer`, `X-Session`, `X-Nonce`, `X-Signature` in `X-Max-Wei`; odgovor vrne
`X-Charged-Wei`, `X-Balance-Wei`, `X-Budget-Remaining-Wei`, `X-Session-Expires`,
`X-Server-Ms` in `X-Request-Id`. Glavo `X-Chain-Read-Ms` (čas branja verige) doda samo odgovor
na `POST /session/open`, in še to le v realnem načinu, ko se polnitev res preveri prek RPC.

## Zahteve

- **Node.js ≥ 20** in **npm** (za `iot_naprava/` in `agent/`).
- **Python ≥ 3.9** za analizo (`matplotlib`, `pandas`, `numpy`).
- Za **realni način**: financirana denarnica na omrežju **Ethereum Sepolia** z nekaj testnega ETH
  (iz javnega faucet-a). Potrebna je le za **eno** polnitev in njen gas — bremenitve so brezplačne.
- Za zajem prometa v Wiresharku: dostop do vmesnika, po katerem teče HTTP promet (glej
  `../README.md`).

Repozitorij **ne vsebuje nobenih zasebnih ključev ali poverilnic** — denarnice si ustvariš sam.

## Struktura mape

```
iot_naprava/   Express IoT ponudnik s sejami (vrata 3200)
               server.js, auth.js, db.js, db_x402.js, x402.js,
               .env.example, wallet.example.json
agent/         agent.js (1 polnitev + N podpisanih bremenitev, varnostni testi),
               x402-odjemalec.js, generate-wallet.js, config.json, wallet.example.json
analiza/       analiza_dobroimetje.py, slog.py, requirements.txt
meritve/       izhodni CSV in povzetki JSON — mapo skripte ustvarijo same
```

Mapa `meritve/` je v repozitoriju prazna in je po `git clone` ne bo; agent jo ustvari ob prvem
zagonu. Enako velja za `analiza/slike/`, ki jo ustvari skripta za analizo. Rezultati
(`meritve/*.csv`, `meritve/*_povzetek.json`) in slike so v korenskem `.gitignore` in v git ne
pridejo. Izjema so simulirani vzorci v `meritve/_vzorec/` — teh `.gitignore` ne pokriva, zato
jih, če si jih ustvaril, ne dodajaj v git.

## Namestitev

```bash
cd iot_naprava
npm ci                                  # oz. npm install
cp wallet.example.json wallet.json      # OBVEZNO — brez tega se strežnik takoj ustavi
cp .env.example .env                    # neobvezno; vrednosti so enake privzetkom v kodi
                                        # (izjema: LOG_LEVEL, v kodi `debug`, v .env `info`)
```

V `iot_naprava/wallet.json` vpiši **samo naslov** denarnice, ki naj prejema polnitve (ista vloga
kot v mapi `02`). Privatni ključ tu ni potreben in ga ne vpisuj.

```bash
cd ../agent
npm ci
```

Za **realni način** potrebuje agent plačnikovo denarnico z zasebnim ključem:

```bash
cd agent
npm run gen-wallet         # ustvari agent/wallet.json (obstoječe ne prepiše)
```

Naslov iz `agent/wallet.json` nato financiraj iz javnega faucet-a za Sepolio. V **mock** načinu
denarnica ni potrebna — agent podpisuje z efemerno denarnico brez sredstev.

## Lokalni zagon — mock (brez sredstev)

Naprava je zaprta s **skrbniško prijavo** (glej `../README.md`). Poverilnice se ustvarijo ob
**prvem** zagonu in se shranijo v `iot_naprava/data/admin.json`; berljiv izvod se ob vsakem
zagonu osveži v `iot_naprava/data/admin-credentials.txt` (pravice 0600), zato žeton preberi
**po** zagonu strežnika. Ob ponovnih zagonih se žeton in geslo **ne** spremenita — nov par
dobiš tako, da izbrišeš `data/admin.json` in strežnik znova zaženeš.

**Terminal 1 — IoT naprava:**

```bash
cd iot_naprava
npm run mock          # NODE_ENV=development MOCK_VERIFY=true node server.js
```

Naprava posluša na vratih **3200** (`IOT_PORT`), na vseh vmesnikih.

**Terminal 2 — agent:**

```bash
cd agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../iot_naprava/data/admin-credentials.txt | cut -d= -f2)
npm run mock          # node agent.js --mock --debits 20
```

Nastane `meritve/dobroimetje_mock.csv` in `meritve/dobroimetje_mock_povzetek.json`.

V mock načinu je polog seje fiksno `PRICE_WEI_PER_CALL × 25`, torej **največ 25 bremenitev**;
z `--debits 30` bi zadnjih pet vrnilo `402 insufficient_balance`. Zastavica `--topup-wei` v
mock načinu nima učinka (uporabi se le za resnično transakcijo v realnem načinu).

V brskalniku se lahko prijaviš na `http://127.0.0.1:3200/prijava` (uporabniško ime in geslo sta
v isti datoteki, polji `UPORABNIK=` in `GESLO=`) in pogledaš npr. `/config`. Odprto geslo je v
polju `GESLO=` zapisano samo ob zagonu, ki ga je ustvaril; pri kasnejših zagonih je tam le
opomba, da je nespremenjeno. Brez žetona agent takoj javi `401` in izpiše točen ukaz za `grep`.

## Lokalni zagon — realne meritve (Sepolia)

Predpogoj: `agent/wallet.json` s financirano denarnico in `iot_naprava/wallet.json` z naslovom
prejemnika. V `iot_naprava/.env` naj bo `MOCK_VERIFY=false` (privzetek v `.env.example`).

**Terminal 1:**

```bash
cd iot_naprava
npm start             # node server.js — polnitev se preveri na verigi prek RPC_URL
```

**Terminal 2:**

```bash
cd agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../iot_naprava/data/admin-credentials.txt | cut -d= -f2)
npm run real          # node agent.js --real --debits 20 --pause-ms 200
```

Nastane `meritve/dobroimetje_real.csv` in `meritve/dobroimetje_real_povzetek.json`.

Privzeta polnitev je `--topup-wei 2500000000000` (0.0000025 ETH), kar pri ceni
`100000000000 wei` na odčitek zadošča za **natanko 25 bremenitev**. Za več bremenitev polnitev
sorazmerno dvigni, sicer strežnik zavrne z `402 insufficient_balance`:

```bash
node agent.js --real --debits 40 --pause-ms 200 --topup-wei 5000000000000
```

Zastavice, ki jih agent bere: `--real` (sicer mock), `--debits <N>` (privzeto 20),
`--pause-ms <ms>` (privzeto 0), `--topup-wei <wei>`, `--security`, `--x402`, `--out <pot>`.

## Zagon na oddaljenem strežniku

Postavitev: **IoT naprava teče na strežniku**, **agent lokalno** (tako gre plačilni promet čez
omrežje in ga je mogoče zajeti z Wiresharkom). Podrobnosti so v `../README.md`.

```bash
ssh <UPORABNIK>@<IP_STREZNIKA>
git clone <URL_REPOZITORIJA>
cd HTTP402-based-payments/testna-okolja/03_avtomatska_placila_dobroimetje/iot_naprava
npm ci
cp wallet.example.json wallet.json     # vpiši naslov prejemnika
cp .env.example .env
sudo ufw allow 3200/tcp                # odpri vrata naprave
npm run mock                           # ali npm start za realni način
```

Nato **lokalno** poženi agenta in ga usmeri na strežnik z okoljsko spremenljivko `IOT_URL`
(prednost ima pred `agent/config.json`); žeton preberi na strežniku:

```bash
# na strežniku:
grep '^ZETON=' iot_naprava/data/admin-credentials.txt | cut -d= -f2

# lokalno:
cd agent
export IOT_URL=http://<IP_STREZNIKA>:3200
export ADMIN_TOKEN=<ZETON_S_STREZNIKA>
npm run mock
```

Ta mapa nima Dockerfile-a ne Caddyfile-a — naprava se zaganja neposredno z `npm`.
Vsebnikirano različico s HTTPS imata mapi `04` in `05`.

> **Opozorilo:** naprava namenoma teče po **navadnem HTTP** (brez TLS), da je plačilni tok viden
> v Wiresharku. Dostop do vrat 3200 omeji na svoj IP (npr. `sudo ufw allow from <TVOJ_IP> to any
> port 3200 proto tcp`), strežnik po meritvah ustavi in vrata zapri. Skrbniški žeton in geslo se
> po HTTP prenašata v čistopisu in ostaneta ista tudi po ponovnem zagonu, zato ju po meritvah
> zavrzi: izbriši `data/admin.json` in `data/admin-credentials.txt`.

## Analiza rezultatov

```bash
cd analiza
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 analiza_dobroimetje.py
```

Brez argumenta skripta poišče prvo obstoječo datoteko po vrstnem redu
`../meritve/dobroimetje_real.csv`, `../meritve/dobroimetje_mock.csv`, nato še različici v
`../meritve/_vzorec/`. Datoteko lahko podaš tudi izrecno:

```bash
python3 analiza_dobroimetje.py ../meritve/dobroimetje_real.csv
python3 analiza_dobroimetje.py --out /pot/do/slik --vzorec
```

`--out` določa ciljno mapo (privzeto `analiza/slike`), `--vzorec` doda čez sliko rdeč diagonalni
vodni žig „SIMULIRANI PRIMER — NE PRAVE MERITVE". Če meritve še ne obstajajo, si lahko
simulirane vhodne CSV ustvariš z `../primerjava/generiraj_vzorec.py`, ki jih zapiše v
`meritve/_vzorec/`; nastale slike so takrat samodejno označene kot vzorec in **niso** rezultat
meritve.

Skripta `analiza_dobroimetje.py` obdela samo vrstice z `vrsta=debit` in bere stolpce domačega
toka (`t_podpis_ms`, `t_zahteva_ms`, `streznik_ms`, `cena_wei`, `dobroimetje_wei`,
`proracun_ostanek_wei`, `nacin`). Datotek `x402_dobroimetje_*.csv` ne obdela (imajo atomske
stolpce namesto wei) — te obdela `../primerjava/primerjava_x402.py`. Za združeno primerjavo z
mapo `02` (amortizacija, latenca on/off-chain) glej `../primerjava/`.

Opomba: `analiza/slog.py` je namerno podvojen v vsaki mapi `analiza/`, da je vsaka mapa
samostojna.

## Pričakovani izhodi

V `meritve/`:

| Datoteka | Nastane pri |
|---|---|
| `dobroimetje_mock.csv` + `dobroimetje_mock_povzetek.json` | `npm run mock` (agent) |
| `dobroimetje_real.csv` + `dobroimetje_real_povzetek.json` | `npm run real` |
| `varnostni_testi_mock.csv` | `npm run security` |
| `x402_dobroimetje_mock.csv` / `_real.csv` | `node agent.js --x402` |
| `varnostni_testi_x402_mock.csv` | `node agent.js --x402 --security` |

CSV domačega toka ima 17 stolpcev: `dogodek, cas_iso, nacin, vrsta, t_podpis_ms, t_zahteva_ms,
streznik_ms, t_skupaj_ms, cena_wei, dobroimetje_wei, proracun_ostanek_wei, gas_enote,
provizija_eth, temperatura_c, vlaga_pct, nonce, seja`. Prva vrstica je `polnitev` (`topup`),
sledijo `bremenitev_1 … bremenitev_N` z `vrsta=debit`.
CSV varnostnih testov ima stolpce `test, pricakovano, dejansko, uspeh, opomba`; v `uspeh` piše
domača zbirka `da`/`ne`, zbirka za x402 pa `1`/`0`.

V `analiza/slike/`:

- `01_latenca_bremenitve.png` — latenca posamezne bremenitve (podpis + zahteva) z mediano,
- `02_poraba_dobroimetja.png` — upadanje dobroimetja skozi sejo. Krivulja preostalega proračuna
  se nariše le, kadar se od dobroimetja razlikuje; pri privzetem zagonu je proračun enak pologu,
  zato je krivulja ena sama (ločen proračun uporabljata varnostna testa T7 in T9).

**Signal uspeha:** agent ob odprtju seje izpiše njeno oznako (`seja=sess_…`), ob koncu pa
vrstico `uspešnih N/N`, povzetek latenc (`t_podpis`, `t_zahteva`) in končno stanje seje,
skripta za analizo pa vrstici `Latenca bremenitve [ms]: min=… median=…` in
`On-chain transakcij v seji: 1 (polnitev) za N odčitkov`, ter na koncu `Končano.`

## Varnostni testi

Preverjajo zaščitne mehanizme seje. Tečejo **samo v mock načinu** — z `--real` se
zavrnejo:

```bash
cd agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../iot_naprava/data/admin-credentials.txt | cut -d= -f2)
npm run security          # node agent.js --security
```

Izvede se **9 testov**:

| # | Test | Pričakovano |
|---|---|---|
| T1 | manjkajoče podpisne glave | `402` |
| T2 | veljavna bremenitev | `200` |
| T3 | ponovitev nonce (replay) | `403` |
| T4 | ponarejen podpis (druga denarnica) | `403` |
| T5 | cena čez podpisani maksimum `X-Max-Wei` | `400` |
| T6 | zastarel nonce (izven `DEBIT_MAX_AGE_MS`) | `400` |
| T7 | presežen proračun (`budgetWei = 2 × cena`) | `402` |
| T8 | nezadostno dobroimetje (polog `2 × cena`) | `402` |
| T9 | potekla seja (`ttlSeconds: 1`) | `403` |

Izhod: `meritve/varnostni_testi_mock.csv` (stolpec `uspeh` z vrednostma `da`/`ne`); v konzoli je
izpisan števec uspešnih testov. Izhodno kodo, različno od 0, ob neuspehu nastavi le različica
testov za x402 (`--x402 --security`), zato pri tej zbirki rezultat preveri v izpisu ali v CSV.

## x402 v2 (vzporedni način — samo financiranje seje)

V tem načinu se protokol x402 uporabi **izključno za polnitev**: plačilo zahteve
`POST /x402/session/open` (ena poravnava sheme *exact* v ETH) odpre sejo, vseh N bremenitev pa
nato teče lokalno s podpisi EIP-191 v **sporočilu v2**:

```
metered-debit-v2:{payer}:{session}:{nonce}:{path}:{maxAtomic}:{network}:{asset}
```

Glave so `X-Max-Atomic`, `X-Charged-Atomic`, `X-Balance-Atomic` in
`X-Budget-Remaining-Atomic` — vrednosti so **atomske enote sredstva** (testni ETH), nikoli „wei".
Za odčitke **ni nobene dodatne poravnave na verigi**. Podedovani tok in njegovo sporočilo
`x402-debit:…:{maxWei}` sta nespremenjena; formata se vzajemno zavračata (test T3 spodaj).
Lokalno merjenje samo po sebi **ni** x402 — pravilen opis je „x402 financiranje seje + lastno
lokalno merjenje".

Poravnava je v tej konfiguraciji **sintetična (mock)**: pravi tek bi zahteval žeton s podporo
EIP-3009, ki ga domači ETH nima.

**Terminal 1 — naprava z vklopljenim x402:**

```bash
cd iot_naprava
X402_MODE=self X402_MOCK=true npm run mock
```

**Terminal 2 — agent:**

```bash
cd agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../iot_naprava/data/admin-credentials.txt | cut -d= -f2)
node agent.js --x402 --debits 20      # → meritve/x402_dobroimetje_mock.csv
node agent.js --x402 --security       # → meritve/varnostni_testi_x402_mock.csv
```

Varnostni testi x402 zahtevajo napravo, ki teče z **obema** spremenljivkama
`X402_MODE=self` **in** `X402_MOCK=true` — sicer se takoj ustavijo. Izvedejo 9 testov:
T1 polnitev odpre sejo; T2 pet bremenitev brez nove poravnave; T3 podpis v1 na poti v2 → `403`;
T4 podpis v2 za drugo sredstvo → `403`; T5 ponovitev nonce → `403`; T6 cena nad maksimumom →
`400`; T7 izčrpano dobroimetje → `402`; T8 ponovitev iste polnitve vrne isto sejo (idempotentno
predvajanje); T9 pokvarjen JSON → `400`.

Privzeti polog x402 seje je `X402_SESSION_DEPOSIT_ATOMIC=2000000000000` = 20 plačil pri ceni
`X402_PRICE_ATOMIC=100000000000`. Zbrane x402 meritve obdela `../primerjava/primerjava_x402.py`.
Širši opis protokola je v `../README.md`.

## Prilagoditve

- **Cena na odčitek:** `PRICE_WEI_PER_CALL` (privzeto `100000000000` wei = 0.0000001 ETH —
  enako kot v mapi `02`, kar omogoča neposredno primerjavo). Po želji še `PRICE_WEI_PER_BYTE`
  (privzeto 0) in spodnja meja `MIN_PRICE_WEI`.
- **Proračun in veljavnost seje:** agent ju lahko zahteva ob polnitvi (`budgetWei`,
  `ttlSeconds`). Proračun strežnik omeji navzgor s pologom (privzeto je enak pologu), čas
  veljavnosti pa s `SESSION_TTL_DEFAULT` (privzetek) in `SESSION_TTL_MAX` (zgornja meja).
  To izkoriščata testa T7 in T9. Privzeti zagon agenta ne pošlje ne enega ne drugega.
- **Svežina enkratne kode:** `DEBIT_MAX_AGE_MS` (privzeto 120000 ms).
- Vse spremenljivke so opisane v `iot_naprava/.env.example`. Podatkovni bazi SQLite nastaneta v
  `iot_naprava/data/` (`iot_dobroimetje.db`, `x402_placila.db`).

## Odpravljanje težav

| Simptom | Vzrok in rešitev |
|---|---|
| Strežnik se takoj ustavi | Manjka `iot_naprava/wallet.json` — `cp wallet.example.json wallet.json` in vpiši naslov. |
| Agent javi `401` | Manjka ali napačen `ADMIN_TOKEN`. Preberi ga iz `data/admin-credentials.txt` na napravi; nov par dobiš z brisanjem `data/admin.json` in ponovnim zagonom. |
| `402 insufficient_balance` | Polog ne pokrije vseh bremenitev: v mock načinu je meja 25, v realnem dvigni `--topup-wei`. |
| Agent trka na `127.0.0.1` | Za oddaljeno napravo nastavi `export IOT_URL=http://<IP_STREZNIKA>:3200`. |
| `Ni CSV. Najprej poženi meritev…` | Analiza ne najde vhodne datoteke — najprej `cd ../agent && npm run mock`. |

Podrobnejša navodila so v [`testna-okolja/README.md`](../README.md):
[postavitev na dveh napravah](../README.md#postavitev-na-dveh-napravah),
[priporočen vrstni red poskusov](../README.md#priporočen-vrstni-red-poskusov),
[skrbniška prijava in žetoni](../README.md#skrbniška-prijava),
[zajem z Wiresharkom](../README.md#zajem-z-wiresharkom) in
[uradni protokol x402 v2](../README.md#uradni-protokol-x402-v2).
