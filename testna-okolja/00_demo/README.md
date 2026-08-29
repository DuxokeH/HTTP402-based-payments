# Testno spletno okolje x402

Samostojno okolje za prikaz plačila po protokolu **x402** nad statusno kodo
**HTTP 402 Payment Required**. Strežnik ponuja plačljivo storitev, odjemalec plača na
testnem omrežju **Ethereum Sepolia**, plačilo se preveri neposredno na verigi — brez
posrednika in brez pametnih pogodb.

Okolje je namenjeno temu, da si protokol lahko **sam poženeš in opazuješ**. Promet teče po
navadnem HTTP (brez TLS), da je vsako sporočilo berljivo v Wiresharku. Za merilne poskuse
glej sosednje scenarije v [`..`](..).

## Protokolni potek

Plačilo in dostava vsebine sta **združena v dve izmenjavi oziroma štiri sporočila**:
preverjanje transakcije in dostava vsebine se zgodita v istem `POST /service`.

```
odjemalec                        strežnik                        Sepolia
    │                                │                               │
 1  │──── GET /service ─────────────►│                               │
    │                                │                               │
 2  │◄─── 402 Payment Required ──────│  {requestId, prejemnik, znesek, omrežje}
    │                                │                               │
    │──── plačilna transakcija ──────┼──────────────────────────────►│
    │◄─── txHash ────────────────────┼───────────────────────────────│
    │                                │                               │
 3  │──── POST /service ────────────►│  {requestId, txHash, payerAddress, prompt}
    │                                │──── getTransaction ──────────►│
    │                                │◄─── potrdilo ─────────────────│
 4  │◄─── 200 OK ────────────────────│  {vsebina, proofToken}
```

Strežnik pri koraku 3 preveri, da se ujemajo prejemnik, znesek in plačnik, da je transakcija
potrjena v zahtevanem številu blokov in da isti `txHash` **ni bil unovčen že prej**. Dokazni
žeton (`proofToken`) je enkraten, ima omejeno veljavnost in je vezan na vir; z njim lahko
odjemalec kasneje samo še potrdi, da je plačilo opravljeno (neobvezna zastavica `--ack`).

## Zahteve

- **Node.js ≥ 20** in npm
- za **realni** način: denarnica na omrežju Ethereum Sepolia s testnim ETH iz javnega
  faucet-a (za mock način ni potrebna)
- neobvezno: brskalnik z razširitvijo **MetaMask** za spletni odjemalec
- neobvezno: **Wireshark** za zajem poteka

## Namestitev

### 1. Ustvari testni denarnici

Repozitorij namenoma **ne vsebuje nobenih denarnic ali ključev**. Ustvariš si ju sam:

```bash
npm ci                     # naloži ethers za generator
node generate-wallet.js
```

Skripta ustvari dve neodvisni denarnici in ju zapiše s pravicami `0600`:

| Datoteka | Vloga | Potrebuje sredstva |
|---|---|---|
| `server/wallet.json` | trgovec — **prejema** plačila | ne |
| `klient/wallet.json` | odjemalec — **pošilja** plačila | da, za realni način |

Če datoteki že obstajata, se skripta ustavi in ju ne prepiše. Obe sta v `.gitignore`.

> **Uporabljaj izključno namensko testno denarnico.** Nikoli ne vpisuj ključa denarnice s
> pravimi sredstvi. Testni ETH za Sepolio dobiš brezplačno iz javnega faucet-a; nima
> vrednosti.

### 2. Namesti odvisnosti

```bash
cd server && npm ci && cp .env.example .env
cd ../klient && npm ci
```

## Lokalni zagon — mock (brez sredstev)

V mock načinu strežnik verige ne bere, odjemalec pa ne pošlje prave transakcije. Potek HTTP
sporočil je identičen realnemu, zato je ta način primeren za zajem z Wiresharkom.

```bash
# terminal 1 — strežnik
cd server
npm run mock            # MOCK_VERIFY=true, posluša na vratih 3000

# terminal 2 — odjemalec
cd klient
npm run mock
```

Pričakovani izpis odjemalca: `402 Payment Required`, nato `200 OK` z vsebino in dokaznim
žetonom. Strežnik brez nastavljenega `OPENAI_API_KEY` vrne označen nadomestni odgovor
(`[DEMO MODE]`) — potek HTTP je pri tem enak.

## Lokalni zagon — realno plačilo na Sepoliji

Zahteva financirano denarnico `klient/wallet.json`.

```bash
# terminal 1 — strežnik
cd server && npm start

# terminal 2 — odjemalec
cd klient
node run.js --pause-ms 1500 --prompt "Kaj je protokol x402?"
```

Odjemalec pošlje pravo transakcijo in počaka na potrditev; celoten potek zato traja nekaj
deset sekund. Transakcijo lahko preveriš na raziskovalcu blokov za omrežje Sepolia.

### Argumenti odjemalca

| Argument | Pomen |
|---|---|
| `--mock` | ne pošlje prave transakcije, uporabi fabriciran `txHash` |
| `--prompt <besedilo>` | vprašanje, ki se pošlje storitvi |
| `--pause-ms <n>` | premor med izmenjavama (preglednejši zajem v Wiresharku) |
| `--ack` | doda neobvezno tretjo izmenjavo: `GET /service` z glavo `X-Payment` |

## Spletni odjemalec (MetaMask)

Ob zagnanem strežniku odpri `http://127.0.0.1:3000`. Stran opravi isti potek prek MetaMask.
Potrebuje dostop do interneta (knjižnica `viem` se naloži z omrežja) in MetaMask, preklopljen
na omrežje Sepolia.

## Zagon na oddaljenem strežniku

```bash
ssh <UPORABNIK>@<IP_STREZNIKA>
git clone <url-repozitorija>
cd <ime-repozitorija>/testna-okolja/00_demo

npm ci && node generate-wallet.js     # denarnici ustvari NA strežniku ali ju prenesi varno
cd server && npm ci && cp .env.example .env
npm start
```

Odpri vrata in omeji dostop:

```bash
sudo ufw allow 3000/tcp
```

Odjemalca nato poženeš lokalno proti oddaljenemu strežniku — naslov nastavi v
`klient/config.json` (`MERCHANT_URL`).

> **Opozorilo.** Strežnik privzeto teče po navadnem HTTP, ker mora biti promet berljiv za
> zajem. Dokazni žeton je „bearer" poverilnica — kdor ga prestreže, dostopa do vsebine. Na
> javnem naslovu zato bodisi omeji dostop na svoj IP bodisi postavi TLS.

Za produkcijsko postavitev s TLS, vsebnikom in obratnim posrednikom Caddy sta priložena
`server/Dockerfile` in `server/docker-compose.yml`:

```bash
cd server
cp .env.example .env                     # brez te datoteke Compose ne steče
# server/wallet.json mora obstajati (node ../generate-wallet.js) — sicer Docker
# na njegovem mestu ustvari prazno MAPO in strežnik se ne zažene
# v Caddyfile vpiši svojo domeno namesto your-domain.example
docker compose up -d
```

Podroben postopek postavitve na oddaljen strežnik (vključno z omejevanjem stroškov,
požarnim zidom, HTTPS in varnostnimi kopijami) je v [`docs/POSTAVITEV.md`](docs/POSTAVITEV.md).

## Konfiguracija

Vse nastavitve so v `server/.env` (predloga: `server/.env.example`).

| Spremenljivka | Privzeto | Pomen |
|---|---|---|
| `MERCHANT_PORT` | `3000` | vrata strežnika |
| `NETWORK` | `sepolia` | omrežje |
| `RPC_URL` | javno vozlišče Sepolia | dostopna točka JSON-RPC |
| `MIN_CONFIRMATIONS` | `1` | zahtevana globina potrditve |
| `SERVICE_PRICE_ETH` | `0.0001` | cena ene uporabe storitve |
| `PROOF_TOKEN_TTL_SECONDS` | `600` | veljavnost dokaznega žetona |
| `PAYMENT_REQUEST_TTL_SECONDS` | `1800` | veljavnost plačilne zahteve |
| `ALLOWED_ORIGINS` | prazno | dovoljene izvorne strani za CORS |
| `OPENAI_API_KEY` | prazno | brez njega strežnik vrne nadomestni odgovor |
| `OPENAI_DAILY_USD_CAP` | `5` | dnevna zgornja meja porabe |
| `MOCK_VERIFY` | — | `true` = ne beri verige (samo razvoj) |

## Zajem z Wiresharkom

1. **Vmesnik:** `lo` (Loopback), če strežnik in odjemalec tečeta na istem računalniku;
   `wlan0` oziroma `eth0`, če je odjemalec na drugem stroju v omrežju.
2. **Decode As (obvezno):** Wireshark vrat 3000 privzeto ne prepozna kot HTTP. Desni klik na
   paket → *Decode As…* → TCP port 3000 → HTTP.
   Za `tshark`: `-d tcp.port==3000,http`.
3. **Prikazni filter:**
   ```
   tcp.port == 3000 && http
   ```
   Uporabno še: `http.response.code == 402`, `http contains "proof_"`, `http contains "txHash"`.
4. Najprej zaženi zajem, nato odjemalca s premorom, da so sporočila lepo ločena:
   ```bash
   node run.js --mock --pause-ms 1500
   ```
5. V zajemu vidiš natanko **štiri sporočila HTTP** iz sheme zgoraj. Z `--ack` se doda še
   neobvezni par `GET` + `X-Payment` → `200`.

Hitri preizkus brez grafičnega vmesnika:

```bash
sudo tshark -i lo -f "tcp port 3000" -d tcp.port==3000,http -Y http
```

## Vmesnik HTTP

| Metoda | Pot | Opis |
|---|---|---|
| `GET` | `/service` | brez dokazila vrne **402** s plačilno zahtevo; z veljavno glavo `X-Payment` potrdi opravljeno plačilo |
| `POST` | `/service` | preveri transakcijo **in** dostavi vsebino (združena izmenjava) |
| `GET` | `/config` | javna konfiguracija za spletni odjemalec (omrežje, cena, naslov prejemnika) |
| `GET` | `/health` | stanje strežnika, baze in povezave do verige |

## Struktura

```
generate-wallet.js     generator testnih denarnic (trgovec + odjemalec)
server/
  server.js            strežnik Express: 402, preverjanje plačila, dostava vsebine
  db.js                SQLite: plačilne zahteve, dokazni žetoni, unovčene transakcije, poraba
  public/              spletni odjemalec (MetaMask)
  Dockerfile           vsebnik za produkcijsko postavitev
  docker-compose.yml   aplikacija + Caddy (TLS)
  Caddyfile            obratni posrednik — vpiši svojo domeno
  systemd/x402.service alternativa Dockerju
klient/
  run.js               odjemalec CLI (mock in realni način)
  config.json          naslov strežnika
docs/PROTOCOL_SPEC.md       formalna specifikacija protokola
docs/POSTAVITEV.md          postavitev na oddaljen strežnik po korakih
```

## Varnostni mehanizmi

- **Preprečevanje ponovitve** — vsak `txHash` je lahko unovčen samo enkrat; drugi poskus
  vrne `400 Transaction already redeemed`. Preverjanje in izdaja dokazila sta ena
  transakcija baze, zato tudi hkratni zahtevi ne moreta obe uspeti.
- **Enkratni dokazni žeton** — pogoj „še ni porabljen" je v stavku SQL, z omejeno
  veljavnostjo in vezavo na vir.
- **Preverjanje ujemanja** — prejemnik, znesek in plačnik se preverijo proti plačilni
  zahtevi; naslovi se normalizirajo, `txHash` se primerja v mali pisavi.
- **Omejevanje pogostosti**, `helmet`, validacija vhodov z `zod`, dnevna zgornja meja porabe
  za zunanji API.

## Odpravljanje težav

| Težava | Rešitev |
|---|---|
| `wallet.json not found` ob zagonu | poženi `node generate-wallet.js` v korenu te mape |
| Odjemalec javi premalo sredstev | napolni `klient/wallet.json` iz faucet-a za Sepolio (za preizkus zadošča `npm run mock`) |
| Wireshark ne prikaže sporočil HTTP | manjka *Decode As* za vrata 3000 (glej zgoraj) |
| `429 Too Many Requests` | omejevalnik pogostosti — počakaj minuto ali podaljšaj premor z `--pause-ms` |
| `/health` vrne 503 | ni povezave do vozlišča JSON-RPC; preveri `RPC_URL` in dostop do interneta |

## Licenca

MIT — glej [LICENSE](LICENSE).
