# Identiteta seje in neodvisnost od IP — izvedba

> Ta dokument opisuje, **kaj je vgrajeno v kodo**, zakaj je tako zasnovano in kako se to
> preizkusi.
>
> **Sorodno:** mape 02, 03 in 04 so poleg tega zaprte s skrbniško prijavo — glej
> [skrbniška prijava](../README.md#skrbniška-prijava). Prijava se prav tako **ne veže na IP**, zato menjava omrežja
> prijavljenega uporabnika ne odjavi. Mapa 01 je ostala odprta, da obstaja tudi merilna
> pot brez prijave.

## 0. Zakaj identiteta ni vezana na IP

Naravna prva zamisel je, da si strežnik ob prvem `GET` zapomni odjemalčev IP in kasneje
preveri, ali gre za „isto osebo". Ta pristop je zavrnjen iz treh razlogov:

- IP se med potekom spreminja (mobilno omrežje ↔ wifi, NAT, CGNAT) — vezava bi zavrnila
  ravno pravega uporabnika.
- `X-Forwarded-For` je ponaredljiv, za posrednikom ali NAT pa več uporabnikov deli isti IP.
- Kriptografska identiteta (denarnica) in enkratni žetoni so močnejši **in** neodvisni od
  omrežja.

**Pravilo: IP se sme uporabljati kvečjemu kot mehka telemetrija ali zapis v dnevnik, nikoli
kot pogoj za dostop.** Zamisel „ob GET shrani žeton, kasneje preveri" je zato izvedena s
sejnim piškotkom `sid` (razdelek B spodaj) — ta potuje z brskalnikom in ne z omrežjem.

## 1. Načelo

Identiteta v tem sistemu **ni vezana na IP naslov**. „Ista oseba" se prepozna prek:

| Mehanizem | Kje | Kaj dokazuje |
|---|---|---|
| `requestId` (UUID, TTL) | 402 → `/verify` | povezavo izziv → preverjanje |
| naslov denarnice (`X-Payer` / `tx.from`) | preverjanje transakcije | kriptografsko identiteto plačnika |
| `proofToken` (enkraten, TTL, vezan na vir) | glava `X-Payment` | plačan dostop do točno tega vira |
| `sessionId` + EIP-191 podpis (`X-Signature`) | vsaka merjena bremenitev | „ima privatni ključ" ob *vsaki* zahtevi |
| **`sid` (piškotek, TTL)** — *novo* | mapa 05 | **korelacijo** dogodkov iste seje |

Vse to potuje **z odjemalcem** (glave/telo HTTP, piškotek), ne z omrežjem — zato menjava IP
(mobilno ↔ wifi, NAT, CGNAT) poteka ne prekine.

**IP se v kodi nikjer ne uporablja kot merilo identitete ali avtorizacije.** Rabi sta le dve:

- **Omejevanje pogostosti** (`express-rate-limit`) v mapah 01–03 — zato `app.set('trust proxy', 1)`.
  Natančneje: to *je* edino mesto, kjer IP vpliva na odgovor (`429`), a omejuje
  **hitrost**, ne **kdo si**. Enkratna zahteva pravega uporabnika po menjavi omrežja ne more
  biti zavrnjena zaradi tega. Mapa 05 omejevalnika nima.
- **Mehka telemetrija** v mapi 05 — števec zaznanih menjav IP znotraj ene `sid` seje. Obstaja
  izključno zato, da je mogoče *pokazati*, da menjava IP na dostop ne vpliva.

## 2. Kaj je bilo dodano

### A — HTTPS/TLS za javni dostop

`proofToken` je „bearer" žeton: kdor ga prestreže, dostopa. Pravi popravek je **TLS**,
ne vezava na IP. Nove namestitvene datoteke v `05_spletisce/streznik/`:

```
Caddyfile           reverse-proxy s TLS (Let's Encrypt), HSTS, flush_interval -1 za SSE
docker-compose.yml  Node aplikacija + Caddy (enak vzorec kot testna-okolja/00_demo/server)
Dockerfile          node:20-alpine, prevede better-sqlite3, teče kot nekorenski uporabnik
.dockerignore
```

Aplikacijske kode za to ni bilo treba spreminjati. Ker je `trust proxy` že nastavljen,
`req.secure` pravilno odraža `X-Forwarded-Proto` izza Caddyja, zato piškotek `sid` za
javnim HTTPS samodejno dobi zastavico `Secure` (lahko pa jo vsiliš z `COOKIE_SECURE=true`).

> **Wireshark:** pod TLS vsebina v zajemu ni vidna. Za slikovna dokazila poteka pusti
> dostop po navadnem HTTP na LAN/loopback (v `docker-compose.yml` odkomentiraj `ports`).

### B — Sejni žeton `sid` (piškotek) namesto sklicevanja na IP

To je pravilna izvedba ideje „ob GET shrani žeton, kasneje preveri, ali je ista oseba",
a **odporna na menjavo IP**.

- Ob prvi zahtevi brez veljavnega piškotka strežnik izda
  `Set-Cookie: sid=<uuid>; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax` (+ `Secure` pod HTTPS).
- `sid` se hrani v novi tabeli `sessions_web`, povezani dogodki pa v `sessions_web_links`
  (`request_id`, `proof_token`, `metered_session`). Oboje čisti obstoječi `sweep()`.
- **Ključno pravilo:** manjkajoč, neveljaven ali spremenjen `sid` **nikoli** ne povzroči
  zavrnitve. Celotna korelacija teče v `try`/`catch` in vedno pokliče `next()`; tudi napaka
  baze ne prekine zahteve. Zaradi tega je nemogoče ponoviti težavo IP-vezave.
- Novi `GET /seja` vrne pogled na sejo. Ker je piškotek `HttpOnly`, vrne **le okrajšan
  `sid`** (prvih 8 znakov) in **število menjav IP** — nikoli samih IP naslovov. Brez
  piškotka odgovori `200` z `seja: null`, nikoli `403`.
- V spletišču je nov razdelek **„Seja in identiteta"**, ki to prikaže v živo (gumb *Osveži sejo*).
- Vgrajeni M2M agent (`runner.js`) svoje klice označi z glavo `X-Demo-Agent: runner` in
  sejnega piškotka **ne** dobi: stroj ni brskalnik, njegova identiteta je denarnica + podpis.

Spremenjene datoteke: `05_spletisce/streznik/server.js`, `db.js`, `runner.js`,
`public/index.html`, `public/app.js`, `.env.example`. Nobene nove odvisnosti
(piškotek se bere ročno iz `req.headers.cookie`, brez `cookie-parser`).

Nove nastavitve:

| Spremenljivka | Privzeto | Pomen |
|---|---|---|
| `WEB_SESSION_TTL_SECONDS` | `1800` | življenjska doba piškotka `sid` in seje |
| `COOKIE_SECURE` | `false` | `true` = piškotku vedno dodaj `Secure` (za TLS proxy) |

### C — Ime gostitelja namesto vpisanega IP

`MERCHANT_URL` / `IOT_URL` sta bila že prej nastavljiva prek okoljske spremenljivke, ki ima
prednost pred `config.json`. Privzeta vrednost ostaja `127.0.0.1`, **da mock meritve tečejo
brez nastavljanja**; v vseh treh `config.json` je zdaj izrecno dokumentirano, kako se namesto
IP uporabi ime gostitelja:

```bash
MERCHANT_URL=http://x402.tvoja-domena.si:3000 npm run mock     # mapa 01
IOT_URL=http://iot.tvoja-domena.si:3100 npm run mock           # mapa 02
IOT_URL=http://iot.tvoja-domena.si:3200 npm run mock           # mapa 03
```

Brskalnik (mapi 01 in 04) sprememb ne potrebuje — vse klice na lasten strežnik dela po
**relativnih poteh** (`/config`, `/enkratno/service`, `/run/tx`, `/seja`), zato v strani ni
vpisanega nobenega naslova. Edini absolutni URL-ji so tuji viri: `esm.sh` (knjižnica viem),
RPC ponudnik in `sepolia.etherscan.io`.

## 3. Preizkus „deluje ob menjavi IP"

1. Zaženi mapo 05: `cd 05_spletisce/streznik && npm run mock`, odpri `http://<naslov>:8080`.
2. Na dnu strani odpri razdelek **Seja in identiteta** — `sid` je izdan ob prvem obisku,
   „Zaznanih menjav IP" kaže `0 (isti IP)`.
3. Začni potek (zavihek 1 prek MetaMask ali gumba *Demo*, ali zavihek 2/3).
4. **Med potekom zamenjaj omrežje naprave** (wifi → mobilni internet), da se IP spremeni.
5. Nadaljuj potek oz. klikni *Osveži sejo*.
6. **Pričakovano:** ni nobenega `403`. „Zaznanih menjav IP" se poveča na `1`, `sid` in
   povezani dogodki ostanejo isti — strežnik prepozna isto sejo kljub drugemu IP.

Preizkus brez piškotka (dokaz, da `sid` ni avtorizacija): odpri stran v zasebnem oknu ali
zavrni piškotke — potek deluje enako, le razdelek seje ostane prazen.

Iz ukazne vrstice:

```bash
# 1) prvi GET izda piškotek
curl -si http://localhost:8080/config | grep -i set-cookie

# 2) ista seja ob naslednjih zahtevah
curl -s -c jar.txt http://localhost:8080/config > /dev/null
curl -s -b jar.txt http://localhost:8080/seja

# 3) ponarejen/tuj sid -> NI 403, strežnik le začne novo korelacijo
curl -si -H 'Cookie: sid=00000000-0000-0000-0000-000000000000' \
     http://localhost:8080/enkratno/service | head -1     # HTTP/1.1 402, ne 403
```

## 4. Česa namenoma NI

- **Nobene vezave dostopa na IP ali `X-Forwarded-For`.** IP se med potjo spreminja, za
  posrednikom/NAT ga več uporabnikov deli, `X-Forwarded-For` pa je ponaredljiv.
- **Nobene spremembe identitetne logike v merilnih mapah 01–03**, ki bi vplivala na latenco.
  Tam sta spremenjena samo pojasnjevalna zapisa v `config.json` (`_opomba*`), ki ju koda ne
  bere kot nastavitev.
- Mape `testna-okolja/00_demo/` se nismo dotaknili (originali).

## 5. Ugotovitve pregleda kode

Ob izvedbi je bila koda pregledana po mapah. Dvoje je bilo prej opisanega preširoko.
Nič od tega ni bilo popravljeno v mapah 01–03, ker se identitetne logike merilnih map
namenoma ne dotikamo (poseg bi vplival na izmerjeno latenco) — gre pa za znani
pomanjkljivosti, ki ju je treba poznati.

| Pričakovano vedenje | Dejansko stanje |
|---|---|
| „`requestId` … obvezen pri `/verify-payment`" | Drži za mapi **01** in **02**. Mapa **03** `requestId` in poti `/verify-payment` sploh **nima** — njen `402` je brez stanja, povezavo izziv → seja pa nosi enkratni `txHash` (tabela `redeemed_tx_hashes`). |
| „če je `402` vezal plačnika, se mora ujemati tudi ta" | Drži za mapo **01** (`server.js:432`). Mapa **02** `payer_address` iz plačilne zahteve **shrani, a ga pri preverjanju nikoli ne prebere** — primerja le `tx.from` s poljem `payerAddress` iz telesa. Mapa **03** to rešuje drugače (in strožje): plačnik je pripet iz verige ob odprtju seje in dokazan s podpisom pri vsaki bremenitvi. |

Dodatno, kar podpira odločitev za **TLS namesto vezave na IP** (razdelek A zgoraj):

- `proofToken` je pri unovčenju **čist „bearer" žeton** — ob dostopu se ne preverja ne
  denarnica ne podpis. Kdor ga prestreže, ga lahko porabi. To je natanko razlog, zakaj je
  pravi popravek TLS.
- V mapi 03 je bil `GET /session/:id` **brez podpisa in brez omejevalnika**; `sessionView` vrne
  naslov plačnika, polog, proračun in stanje. To je zdaj zaprto s skrbniško prijavo
  (glej [skrbniška prijava](../README.md#skrbniška-prijava)), sam podpis pa te poti še vedno ne varuje.
- Ločena, s tem nepovezana napaka: `01_enkratna_placila/streznik/public/app.js:54`
  kliče `createPublicClient({ chain: sepolia, transport: http() })` brez naslova, zato viem
  uporabi privzeti RPC, ki ga lasten CSP (`server.js:156`) blokira. Mapa 05 tega nima
  (uporablja `CFG.rpcUrl`). Popravek je enovrstičen, a posega v mapo 01 — odločitev je tvoja.

Znane omejitve izvedene korelacije (namerne, ker `sid` ni avtorizacija):

- `X-Forwarded-For` je ponaredljiv, zato je **števec menjav IP le telemetrija** in ne dokaz.
  Če strežnik teče brez posrednika, `trust proxy, 1` pomeni, da lahko IP javi kar odjemalec.
- Vsaka zahteva brez piškotka odpre novo vrstico v `sessions_web`. Vrstice so majhne in jih
  vsako minuto pobriše obstoječi `sweep()` po `expires_at`; `/health` je izvzet.
- Glavo `X-Demo-Agent` lahko pošlje kdorkoli — s tem se odpove le lastni korelaciji,
  pridobi pa nič (dostop od `sid` ni odvisen).

## 6. Ključne poante

Bistvo varnostnega modela in arhitekture v treh točkah:

- Identiteta je **kriptografska in prenosljiva z odjemalcem**, ne omrežna. Vezava na IP bi
  zavrnila pravega uporabnika ob vsaki menjavi omrežja, hkrati pa ne bi ustavila napadalca
  za istim NAT/posrednikom — zato je slabša na obeh oseh.
- Sejni piškotek je **korelacijski, ne avtorizacijski**. Ta ločnica je poanta: seja izboljša
  sledljivost in beleženje, ne da bi ustvarila nov način zavrnitve.
- Zaupnost „bearer" žetona (`proofToken`) se rešuje s **TLS**, ne z omejevanjem po omrežnem
  naslovu.
