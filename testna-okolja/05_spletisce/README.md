# 05 — Spletišče, neposredna topologija (a)

En sam strežniški proces postreže spletišče s **tremi zavihki** — enkratno plačilo, avtomatska
plačila po transakciji in merjena predplačniška seja — vse na enem naslovu in z živim izpisom
poteka. Namen mape je **prikaz vseh treh plačilnih tokov v enem sistemu** (demonstracija,
slikovna dokazila, zajem v Wiresharku), ne zbiranje merilnih vzorcev.

> **Arhitektura (a) — neposredna.** Trgovec plačila preverja **sam**, neposredno na verigi prek
> svojega ponudnika RPC; na plačilni poti ni tretje osebe. Primerjalna različica s
> **posrednikom** (topologija (b)) je v mapi
> [`../04_spletisce_posrednik/`](../04_spletisce_posrednik/); mapi 04 in 05 sta merilni par za
> primerjavo obeh topologij.

**Brez pametnih pogodb** — merjeni način temelji na off-chain podpisih EIP-191 (pametne pogodbe
so nadaljnje delo).

## Kaj poskus meri

Mapa 05 **ne izvaja meritev in ne ustvari nobene datoteke z rezultati** (ne CSV, ne povzetka
JSON, ne slik). Časi in dogodki zavihkov se prikazujejo samo v živo prek SSE v brskalniku in se
nikamor ne izvozijo; strežnik v SQLite pod `streznik/data/` hrani le obratovalno stanje
(plačilne zahteve, dokazne žetone, seje in bremenitve), ki ga potek potrebuje. Kar poskus pokaže:

| Zavihek | Klasična kartica (domači tok ETH) | Kartica x402 v2 |
|---|---|---|
| **1 · Enkratno plačilo** | človek plača ~0,0000001 ETH prek MetaMaska → dostop do storitve; v načinu mock JS doda gumb **Demo (mock, brez MetaMask)** | MetaMask podpiše pooblastilo EIP-3009, strežnik poravna sam |
| **2 · Avtomatska plačila (20 tx)** | gumb **Zaženi**: vgrajeni agent M2M za vsak odčitek IoT izvede **eno transakcijo na verigi**, dogodki v živo (SSE) | gumb **Zaženi (x402)**: ena poravnava x402 na poizvedbo |
| **3 · Merjena seja** | gumb **Zaženi**: **1 polnitev** + N podpisov EIP-191 brez novih transakcij; prikaz dobroimetja, proračuna in veljavnosti | gumb **Zaženi (x402)**: 1 polnitev + N lokalnih podpisov; dogodki ločijo ON-CHAIN POLNITEV od OFF-CHAIN BREMENITEV z oznako `veriga` |

Za **natančne meritve in grafe** uporabi mape 01–03 (ločeni merilni klienti in analize)
ter mapo 04 za primerjavo topologij. To spletišče logiko iz teh map podvaja v en gostovan
strežnik za živ prikaz.

Kaj se torej da pokazati tu: celoten protokolni potek (402 → plačilo → dokazilo → 200) v enem
brskalniku, primerjavo klasičnega toka in x402 na isti strani, obnašanje seje ob menjavi omrežja
in zajem sporočil v Wiresharku po navadnem HTTP.

## Zahteve

- **Node.js ≥ 20** in **npm** (`better-sqlite3` se prevede iz izvorne kode; na golem sistemu
  potrebuješ tudi `python3`, `make`, `g++`).
- **Brskalnik z dostopom do interneta** — `public/app.js` (celoten klasični del strani) uvaža
  knjižnico `viem` z omrežja CDN `https://esm.sh`. Brez dostopa do interneta se ta modul sploh
  ne naloži, zato odpovejo tudi preklapljanje med zavihki, obe klasični kartici M2M in razdelek
  „Seja in identiteta“. Kartice x402 uporabljajo lokalni sveženj `public/x402-klient.js` in CDN
  ne potrebujejo.
- Razširitev **MetaMask**: za klasično kartico zavihka 1 v pravem načinu (financirana denarnica
  na Ethereum Sepolia), za kartico **x402 v2** zavihka 1 pa vedno — ta nima gumba Demo in
  pooblastilo EIP-3009 podpiše MetaMask tudi v načinu mock.
- Za realni način: **financirana testna denarnica** na omrežju Ethereum Sepolia (testni ETH iz
  javnega faucet-a). Repozitorij ne vsebuje nobenih ključev — denarnico si ustvariš sam.
- Neobvezno za oddaljeno namestitev: **Docker** in **Docker Compose** (priložena sta `Dockerfile`
  in `docker-compose.yml` s Caddyjem za TLS).
- Python **ni** potreben — ta mapa nima analize.

## Struktura mape

```
streznik/                      edina komponenta — en proces Node (vrata 8080)
  server.js                    združen strežnik (vsi trije tokovi + SSE + sejni piškotek + statična stran)
  runner.js                    vgrajeni agent M2M (pravi HTTP prek loopbacka + dogodki SSE)
  auth.js                      skrbniška prijava (geslo + strojni žeton + zaščita CSRF) — glej ../README.md
  db.js                        SQLite za vse tri klasične tokove (+ korelacija sej brskalnika)
  x402.js                      x402 v2 — samofacilitirano preverjanje in poravnava
  db_x402.js                   ločena SQLite baza za x402 plačila in seje
  x402-odjemalec.js            plačnik x402 za vgrajeni agent (strani strežnika)
  public/
    index.html                 tri zavihki, vsak z dvema karticama (klasično + x402)
    app.js                     klasične kartice (MetaMask prek viem z esm.sh) + SSE + pogled seje
    x402-ui.js                 kartice x402 (potrebuje `window.X402Klient`)
    x402-klient.js             ZGRAJEN sveženj za brskalnik (izhod esbuilda, ne urejaj)
    styles.css
  src/
    x402-klient-vir.js         vir, iz katerega esbuild zgradi public/x402-klient.js
  package.json  package-lock.json  .env.example  wallet.example.json
  Dockerfile  docker-compose.yml  Caddyfile  .dockerignore
```

Mapa `streznik/data/` ne obstaja v repozitoriju — strežnik jo ustvari ob prvem zagonu.
Map `analiza/` in `meritve/` v tem scenariju ni.

## Namestitev

```bash
cd streznik
npm ci                                  # oz. npm install; vključuje devDependency esbuild
npm run build:klient                    # samo ob spremembi src/ (glej opombo)
cp .env.example .env
cp wallet.example.json wallet.json
```

**Korak `npm run build:klient` je posebnost te mape.** Ukaz z esbuildom zgradi
`public/x402-klient.js` iz `src/x402-klient-vir.js`:

```
esbuild src/x402-klient-vir.js --bundle --minify --format=iife --outfile=public/x402-klient.js
```

`index.html` sveženj nalaga brezpogojno (`<script src="/x402-klient.js">`), zato brez njega
kartice x402 ne delujejo. Zgrajen sveženj je v repozitoriju priložen, tako da prvi zagon deluje
tudi brez gradnje; ukaz zaženi znova samo, ko spremeniš `src/x402-klient-vir.js` ali datoteko
izbrišeš. **Docker slika esbuilda ne poganja in mape `src/` ne kopira** (`Dockerfile` kopira le
`public/`), zato mora biti sveženj na gostitelju prisoten **pred** `docker compose build`.

**Denarnica.** `wallet.json` si ustvariš sam; repozitorij ne vsebuje nobenega ključa in
`.gitignore` to datoteko izloči. Strežnik bere:

| ključ | pomen |
|---|---|
| `address` | **obvezen** — naslov prejemnika plačil. V načinu mock zadošča poljuben veljaven naslov. |
| `payerPrivateKey` | privatni ključ **financirane** denarnice, s katero vgrajeni agent plačuje v zavihkih 2 in 3 (samo realni način). |
| `x402PayerPrivateKey` | plačnik za kartici x402 v zavihkih 2 in 3 — potreben **samo v pravem načinu**; pri `X402_MOCK=true` si vgrajeni agent za vsak tek ustvari enkratno naključno denarnico. |
| `x402Address` | neobvezni prejemnik x402 (`payTo`); brez njega se uporabi `address`. |
| `x402SettlerPrivateKey` | poravnalni ključ strežnika za x402 (potrebuje ETH za gas); v načinu mock ni potreben — takrat se uporabi determinističen navidezni račun. |

Privatnega ključa nikoli ne deli in ne nalagaj v git.

> **Past pri nastavitvah: `NODE_ENV`.** Pusti `NODE_ENV=development`. Pri `production`
> strežnik **ignorira** `MOCK_VERIFY=true` in `X402_MOCK=true` (razen z `FORCE_MOCK=1`),
> `helmet` pa doda `upgrade-insecure-requests`, zaradi česar dostop po navadnem HTTP — torej
> ravno zajem za Wireshark — ne deluje. Enako pusti `COOKIE_SECURE=false`: zastavica `Secure`
> se doda samodejno, ko zahteva pride po HTTPS (tudi izza Caddyja prek `X-Forwarded-Proto`).

## Lokalni zagon — mock (brez sredstev)

En sam terminal:

```bash
cd streznik
npm run mock                            # NODE_ENV=development MOCK_VERIFY=true, vrata 8080
```

Nato v brskalniku odpri `http://localhost:8080`. Ker je celotno spletišče zaprto, te preusmeri
na `/prijava`; geslo prebereš iz `data/admin-credentials.txt` (glej razdelek o prijavi spodaj).

V načinu mock delujeta oba zavihka M2M takoj in brez sredstev, v zavihku 1 pa JavaScript doda
gumb **Demo (mock, brez MetaMask)** — gumb obstaja samo, kadar `/config` vrne `mockVerify: true`.

Vzporedni način x402 (prav tako brez sredstev):

```bash
X402_MODE=self X402_MOCK=true npm run mock
```

Ukaza `npm start` (`node server.js`) in `npm run dev` (`NODE_ENV=development node server.js`)
zaženeta isti strežnik, le da `MOCK_VERIFY` ne nastavita sama — vrednost vzameta iz `.env`.
Ker je v `.env.example` privzeto `MOCK_VERIFY=true`, tudi `npm start` po `cp .env.example .env`
teče v načinu mock; za pravi tek moraš v `.env` sam nastaviti `MOCK_VERIFY=false`.

## Lokalni zagon — realne meritve (Sepolia)

1. V `wallet.json` vpiši `address` (prejemnik) in `payerPrivateKey` financirane denarnice na
   Ethereum Sepolia.
2. V `.env` nastavi `MOCK_VERIFY=false` in po potrebi svoj `RPC_URL`. `NODE_ENV` pusti
   `development`.
3. Zaženi `npm start` in odpri `http://localhost:8080`.
4. **Zavihek 1** plačaj z MetaMaskom (denarnica v brskalniku mora biti financirana na Sepoliji).
   **Zavihka 2 in 3** poženeš z gumbom **Zaženi**; agent M2M plačuje iz `payerPrivateKey`.

> **Poraba sredstev.** Zavihek 2 v pravem načinu izvede toliko pravih transakcij, kolikor
> poizvedb nastaviš (privzeto 20), vsako s svojim gas. Trajanje je vezano na čas bloka Sepolije
> (red velikosti deset sekund na transakcijo) — to je **ocena, ne meritev iz te mape**. Za hiter
> prikaz zmanjšaj število poizvedb ali ostani v načinu mock.

> **Meja merjene seje.** Klasična kartica zavihka 3: privzeto je `TOPUP_WEI=2500000000000` in
> `PRICE_WEI_PER_CALL=100000000000`, kar da **največ 25 bremenitev na sejo**. Vnosno polje sicer
> dovoli do 200; pri več kot 25 se tek ustavi z `insufficient_balance` („Nezadostno
> dobroimetje“) — `budget_exceeded` se pojavi le, če pri odprtju seje sam pošlješ nižji
> `budgetWei` od pologa. V **pravem** načinu mejo dvigneš tako, da povečaš `TOPUP_WEI`; v načinu
> **mock** `TOPUP_WEI` ne učinkuje — strežnik tam polog izračuna kot `PRICE_WEI_PER_CALL × 25`
> (`server.js`, `/merjeno/session/open`), zato mock vedno dovoli natanko 25 bremenitev.
> Kartica **x402** zavihka 3 ima svojo mejo: `X402_SESSION_DEPOSIT_ATOMIC=2000000000000` deljeno
> z `X402_PRICE_ATOMIC=100000000000` da **20 bremenitev na sejo**.

> **x402 v pravem načinu.** S privzeto testno nastavitvijo (domači ETH, ki pogodbe EIP-3009
> nima) pravi (ne-mock) tek x402 ni mogoč: če je `X402_MODE=self` brez `X402_MOCK=true` in
> naslov sredstva ostane ničelni, se strežnik ob zagonu ustavi z napako (`x402.js`). Poravnava
> x402 je zato tu vedno sintetična (hash s predpono `0x6d6f636b6d6f636b`). Za pravi tok x402
> uporabi mapo [`../06_x402/`](../06_x402/).

## Zagon na oddaljenem strežniku

Strežnik teče na oddaljenem gostitelju, brskalnik pa lokalno na tvojem računalniku — ta mapa
nima ločenega odjemalca, agent M2M teče v istem procesu in kliče `http://127.0.0.1:<PORT>`.

```bash
ssh <UPORABNIK>@<IP_STREZNIKA>
git clone <naslov-repozitorija> x402
cd x402/testna-okolja/05_spletisce/streznik

npm ci
npm run build:klient                    # le ob spremembi src/; sveženj se vedno gradi na gostitelju
cp .env.example .env
nano .env                               # NODE_ENV=development (PUSTI!), COOKIE_SECURE=false
cp wallet.example.json wallet.json
nano wallet.json                        # address + po potrebi payerPrivateKey

sudo ufw allow 8080/tcp                 # aplikacija
npm start                               # oz. npm run mock
```

Nato odpri `http://<IP_STREZNIKA>:8080`.

### Različica z Dockerjem in Caddyjem

Priložena sta `Dockerfile` in `docker-compose.yml` (aplikacija + Caddy s TLS). Vrstni red je
pomemben, ker slika teče pod neprivilegiranim uporabnikom in mora imeti pisljivo `data/`:

```bash
cp .env.example .env  &&  nano .env
cp wallet.example.json wallet.json  &&  nano wallet.json
npm ci && npm run build:klient           # sveženj mora obstajati PRED gradnjo slike
                                         # (priložen je; gradi ga le ob spremembi src/)

docker compose build
UID_V=$(docker run --rm --entrypoint id x402-spletisce-neposredno:latest -u)
GID_V=$(docker run --rm --entrypoint id x402-spletisce-neposredno:latest -g)
mkdir -p data && sudo chown -R "$UID_V":"$GID_V" data

nano Caddyfile                           # namesto tvoja-domena.si vpiši svojo domeno
nano docker-compose.yml                  # za zajem odkomentiraj  ports: - "8080:8080"
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
docker compose up -d
docker compose ps                        # obe storitvi "running"
```

`Caddyfile` si sam pridobi certifikat Let's Encrypt (odprta morata biti vrata 80 in 443) in ima
`flush_interval -1`, da živi prikaz (SSE) ni medpomnjen. Aplikacija je v `docker-compose.yml`
privzeto samo `expose: 8080` in ni objavljena na gostitelja; objava vrat je zakomentirana in jo
za zajem po HTTP odkomentiraš sam.

Slika ima v `Dockerfile` `NODE_ENV=production`; vrednost iz `env_file: .env` jo prepiše, zato je
`NODE_ENV=development` v `.env` obvezen, če hočeš način mock ali dostop po navadnem HTTP.

> **Opozorilo o izpostavljenosti.** Za slikovna dokazila poteka (402, `X-Payment`, `X-Signature`)
> je potreben **navaden HTTP**, ker pod TLS Wireshark vsebine ne vidi. Dostop na vratih 8080 zato
> omeji na LAN, loopback ali svoj naslov IP (`sudo ufw allow from <tvoj-IP> to any port 8080
> proto tcp`) in ga po zajemu spet zapri. Zajem delaj po naslovu `http://<IP_STREZNIKA>:8080`,
> **ne** po domeni: HSTS iz `Caddyfile` brskalniku leto dni prepove `http://` na tej domeni.

> **⚠ Poraba denarnice.** Gumba *Zaženi* v zavihkih 2 in 3 sprožita vgrajenega agenta prek poti
> `/run/tx` in `/run/merjeno`. V **pravem** načinu (`MOCK_VERIFY=false` + `payerPrivateKey`) to
> porablja pravo denarnico. Skrbniška prijava te poti zapira, zato jih anonimen obiskovalec ne
> more sprožiti — **geslo hrani skrbno** in za javno dostopno demonstracijo pusti
> `MOCK_VERIFY=true`.

## Skrbniška prijava (celotno spletišče je zaprto)

Javne ostanejo samo poti `GET /health`, `GET|POST /prijava` in `POST /odjava` — vse ostalo
zahteva prijavo. Poverilnice si strežnik **ob prvem zagonu ustvari sam** in jih ob **vsakem**
zagonu osveži v datoteko s pravicami 0600:

```bash
grep GESLO data/admin-credentials.txt      # za prijavo v brskalniku
grep ZETON data/admin-credentials.txt      # strojni žeton (Authorization: Bearer)
```

Odpri spletišče → preusmeri te na `/prijava` → vpiši uporabnika in geslo. Gumb **Odjava** je
zgoraj. Vgrajeni agent M2M žeton dobi sam, zato zavihka 2 in 3 delujeta brez dodatnih nastavitev.
Če v `.env` nastaviš `ADMIN_USER`, `ADMIN_PASSWORD` in `ADMIN_TOKEN`, se `admin.json` ne zapiše,
geslo pa nikoli ne pride na disk v odprti obliki (v `admin-credentials.txt` je namesto njega
opomba `(iz okoljske spremenljivke ADMIN_PASSWORD)`). Datoteka `admin-credentials.txt` se
kljub temu prepiše ob vsakem zagonu in vsebuje `UPORABNIK=` in `ZETON=`.

Zaganjalniki `/run/*` porabljajo denarnico, zato poleg prijave zahtevajo še žeton CSRF trenutne
seje (`GET /run/zeton`), ki ga stran doda v naslov `EventSource`, in zavrnejo zahteve, ki so
videti kot krmarjenje (`Sec-Fetch-Mode: navigate`) ali prihajajo z druge strani (`Sec-Fetch-Site`
ni `same-origin`). To prepreči, da bi tuja stran prijavljenemu skrbniku sprožila plačila (CSRF).
Strojni dostop z glavo `Authorization: Bearer <ZETON>` je CSRF izvzet.

Podrobnosti: [skrbniška prijava](../README.md#skrbniška-prijava).

## Poti strežnika

| dostop | poti |
|---|---|
| javno | `GET /health`, `GET\|POST /prijava`, `POST /odjava` |
| za prijavljenega | `/`, `/config`, `/seja`, `/enkratno/config`, `/enkratno/service` (GET, POST), `/enkratno/verify`, `/tx/reading`, `/tx/verify`, `/merjeno/session/open`, `/merjeno/session/:id`, `/merjeno/reading-metered` |
| za prijavljenega (vir žetona CSRF) | `GET /run/zeton` |
| zaganjalniki (prijava + žeton CSRF) | `/run/tx`, `/run/merjeno`, `/run/x402-tx`, `/run/x402-merjeno` |
| samo pri `X402_MODE=self` | `/x402/config`, `/x402/enkratno/service`, `/x402/tx/reading`, `/x402/merjeno/session/open`, `/x402/merjeno/session/:id`, `/x402/merjeno/reading-metered`, `/x402/payment/:id` |

## Seja in identiteta (odpornost na menjavo IP)

Strežnik ob prvem obisku shrani kratkoživ žeton `sid` v piškotek
(`HttpOnly; SameSite=Lax`, privzeto 30 min) in ga kasneje bere **samo za povezovanje**
dogodkov iste seje: plačilna zahteva (402) → dokazni žeton → dostop → merjena seja.

**`sid` ni avtorizacija.** Manjkajoč, neveljaven ali spremenjen piškotek nikoli ne povzroči
zavrnitve — dostop odloča denarnica (podpis oz. pošiljatelj transakcije) in enkratni žeton.
Ker žeton potuje z brskalnikom in ne z omrežjem, potek **preživi menjavo IP** (wifi ↔ mobilni
internet, NAT). Razdelek **„Seja in identiteta“** na dnu strani to pokaže v živo; `GET /seja`
vrne isti pogled v JSON (le okrajšan `sid`, brez naslovov IP).

Nastavitvi: `WEB_SESSION_TTL_SECONDS` (privzeto 1800) in `COOKIE_SECURE` (pusti na `false` —
`Secure` se doda samodejno pod HTTPS, tudi izza Caddyja; vsiljen `true` onemogoči prijavo po
navadnem HTTP, torej ravno pri zajemu za Wireshark).

Načelo in postopek preizkusa: [`../docs/IDENTITETA.md`](../docs/IDENTITETA.md).

## Wireshark

Spletišče privzeto teče po **navadnem HTTP**, zato Wireshark vidi statusni odgovor 402, glave
`X-Payment`, `X-Signature` in časovne glave `X-Server-Ms`. Filtri so v
[zajem z Wiresharkom](../README.md#zajem-z-wiresharkom). Pod TLS (Caddy) Wireshark vsebine ne vidi, zato za dokazila
uporabi dostop po HTTP na vratih 8080.

## Analiza rezultatov

Ta mapa **nima analize** — ni skripte Python, ni `requirements.txt` in ne nastane nobena slika.
Rezultati zavihkov obstajajo samo kot dogodki SSE v brskalniku. Za grafe in tabele
uporabi analize v mapah [`../01_enkratna_placila/`](../01_enkratna_placila/),
[`../02_avtomatska_placila_transakcije/`](../02_avtomatska_placila_transakcije/) in
[`../03_avtomatska_placila_dobroimetje/`](../03_avtomatska_placila_dobroimetje/), za primerjavo
topologij pa [`../04_spletisce_posrednik/`](../04_spletisce_posrednik/).

## Pričakovani izhodi

**Ne nastane noben CSV, povzetek JSON ali PNG.** Ob zagonu se v `streznik/data/` ustvarijo samo:

| datoteka | kdaj |
|---|---|
| `spletisce_neposredno.db` (+ `-wal`, `-shm`) | vedno; pot lahko spremeniš z `DB_PATH` |
| `x402_placila.db` (+ `-wal`, `-shm`) | samo pri `X402_MODE=self`; pot lahko spremeniš z `X402_DB_PATH` |
| `admin.json` (0600) | uporabnik, sol, izvleček gesla in žeton |
| `admin-credentials.txt` (0600) | prepiše se ob **vsakem** zagonu; vsebuje `UPORABNIK=`, `GESLO=`, `ZETON=` |

Vse to izloči korenski `.gitignore`.

**Signali uspeha:**

- v izpisu strežnika `Wallet loaded` z naslovom prejemnika in nato poslušanje na vratih 8080;
- `curl -fsS http://localhost:8080/health` vrne odgovor 200 (brez prijave);
- v brskalniku se po prijavi prikaže stran s tremi zavihki;
- zavihek 2 v živo izpiše po eno vrstico na poizvedbo in konča z dogodkom `konec`;
- zavihek 3, klasična kartica: vrstica `Seja odprta (1 on-chain transakcija)` in nato po ena
  vrstica na bremenitev z upadajočim `dobroimetje=… wei`;
- zavihek 3, kartica x402 (samo pri `X402_MODE=self`): vrstica `⛓ ON-CHAIN POLNITEV` in nato
  N vrstic `✎ OFF-CHAIN bremenitev …` z upadajočim ostankom (dnevnik izpisuje najnovejše zgoraj).

## x402 v2 (vzporedni način — samofacilitirano)

Vsi trije zavihki imajo poleg klasične še kartico x402 (ETH, Ethereum Sepolia — testno; poravnava
je sintetična/mock). Strežnik preverja in poravnava **sam** — v tej mapi ni nobenega klica
facilitatorju. Podpisi se preverijo zares (off-chain), poravnavo pa v načinu `X402_MOCK=true`
opravi vgrajeni zamašek in `X402_RPC_URL` se ne kliče; v pravem načinu bi šla poravnava prek
`X402_RPC_URL` (glej opombo o pravem načinu zgoraj):

- zavihek 1: kartica „x402 v2“ — MetaMask podpiše pooblastilo EIP-3009;
- zavihka 2 in 3: gumba **Zaženi (x402)** (SSE prek `/run/x402-tx` in `/run/x402-merjeno`);
  merjeni dogodki ločijo ON-CHAIN POLNITEV od OFF-CHAIN BREMENITEV z oznako `veriga`.

Zagon: `X402_MODE=self X402_MOCK=true npm run mock`. Sveženj za brskalnik zgradiš z
`npm run build:klient`.

Dve trdi varovalki v kodi (`server.js`, znotraj `if (x402.enabled)`): če je x402 vklopljen z
drugačno vrednostjo kot `X402_MODE=self` ali če je ob tem nastavljen `X402_FACILITATOR_URL`, se
proces ob zagonu namerno konča — mapa 05 je po definiciji brez posrednika. Pri privzetem
`X402_MODE=off` se ne sproži nobena od njiju. Podrobnosti protokola: [uradni protokol x402 v2](../README.md#uradni-protokol-x402-v2).

## Odpravljanje težav

| simptom | vzrok in rešitev |
|---|---|
| stran se naloži, kartice x402 pa ne delujejo | manjka `public/x402-klient.js` → `npm ci && npm run build:klient` |
| stran se ne odziva (zavihki se ne preklapljajo), konzola javi napako uvoza | ni dostopa do `https://esm.sh` (CDN za `viem`); brez njega odpove celoten `app.js`, torej vse klasične kartice in razdelek o seji |
| gumba **Demo (mock, brez MetaMask)** ni | strežnik ne teče v načinu mock — `/config` mora vrniti `mockVerify: true` |
| `MOCK_VERIFY=true` nima učinka | `NODE_ENV=production` mock razveljavi; nastavi `NODE_ENV=development` |
| brskalnik vztraja pri `https://` na vratih 8080 | `NODE_ENV=production` doda `upgrade-insecure-requests`; nastavi `development` |
| prijava se vrti v krogu po navadnem HTTP | `COOKIE_SECURE=true` — nastavi na `false` |
| zavihek 3 se ustavi z `insufficient_balance` | presežen polog seje (klasična kartica 25, x402 kartica 20 bremenitev); zmanjšaj število bremenitev ali — v pravem načinu — povečaj `TOPUP_WEI` |
| proces se ob zagonu takoj konča | x402 je vklopljen (`X402_MODE` ni `off`) z drugo vrednostjo kot `self`, ali pa je ob vklopljenem x402 nastavljen `X402_FACILITATOR_URL`; z `X402_MODE=off` (privzeto) obe varovalki mirujeta |
| v Dockerju ni `data/admin-credentials.txt` | mapa `data/` ni pisljiva za uporabnika v sliki — popravi lastništvo (glej zgoraj) |

Splošna navodila in ukazi po korakih: [`testna-okolja/README.md`](../README.md) ·
prijava in poverilnice: [skrbniška prijava](../README.md#skrbniška-prijava).
