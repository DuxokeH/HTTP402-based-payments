# Testna okolja

Sedem samostojnih okolij za plačevanje po protokolu x402 nad HTTP 402 in orodje za primerjavo
njihovih rezultatov. Vsako okolje ima svoj strežnik, svojega odjemalca ali agenta, merilno
instrumentacijo in analitične skripte ter ga je mogoče pognati ločeno od drugih.

Najpreprostejše je [`00_demo`](00_demo) — če protokola še ne poznaš, začni tam.

Vse teče na testnem omrežju **Ethereum Sepolia**; vsak scenarij ima tudi **mock način**, ki
deluje brez denarnice in brez dostopa do verige, zato je ponovljiv in brezplačen.

Ta datoteka je skupni pregled. **Točni ukazi, vrata in posebnosti so v README posamezne mape** —
tam so tudi navodila za zagon na oddaljenem strežniku, analizo in odpravljanje težav.

## Kaj pokaže katero okolje

| Mapa | Okolje | Kaj pokaže |
|---|---|---|
| [`00_demo`](00_demo) | Najpreprostejši prikaz: strežnik, odjemalec v ukazni vrstici in stran za brskalnik z MetaMask. Ni merilno. | Celoten potek v dveh izmenjavah — dobra vstopna točka in najlažji zajem z Wiresharkom. |
| [`01_enkratna_placila`](01_enkratna_placila) | Enkratno plačilo za dostop do storitve (zunanji API). Plačnik je človek z MetaMask **ali** headless merilni klient. | Latenca po fazah (402 → transakcija → potrditev → preverjanje → dostop), poraba gasa, varnostni testi. |
| [`02_avtomatska_placila_transakcije`](02_avtomatska_placila_transakcije) | M2M: agent plača IoT napravi **eno on-chain transakcijo za vsako poizvedbo**. 20 poizvedb = 20 transakcij. | Draga osnova: kumulativni strošek raste linearno z N. |
| [`03_avtomatska_placila_dobroimetje`](03_avtomatska_placila_dobroimetje) | M2M: **ena polnitev** odpre predplačniško sejo z dobroimetjem, proračunom in veljavnostjo; nato 20 bremenitev, podpisanih po EIP-191, brez novih transakcij. | Amortizacija: ena transakcija za N odčitkov, latenca nekaj ms, uveljavljanje proračuna in poteka. |
| [`04_spletisce_posrednik`](04_spletisce_posrednik) | Spletišče v **topologiji (b)**: trgovec nima dostopa do verige, vse preverja ločen **posrednik**. | Vpliv posredniške arhitekture na latenco in število sporočil. |
| [`05_spletisce`](05_spletisce) | Isto spletišče v **topologiji (a)**: trgovec bere verigo sam. Vsi trije tokovi na enem naslovu. | Živ prikaz vseh treh tokov (SSE). |
| [`06_x402`](06_x402) | Različica mape 01 z **združeno izmenjavo**: preverjanje in dostava vsebine v istem `POST /service` → **2 izmenjavi / 4 sporočila**. | Koliko latence in sporočil stane ločena izmenjava za dokazni žeton. |
| [`primerjava`](primerjava) | Združi rezultate map 02 in 03. | Ključna primerjava: N transakcij proti eni polnitvi; amortizacija; latenca on-chain proti off-chain. |

Mapi **04 in 05 sta merilni par za topologijo**: ista stran, isti trije tokovi. Razlika je samo v
tem, ali trgovec verigo bere sam (05) ali to zanj počne ločen posrednik (04). Posrednik je v tej
postavitvi **lokalen in samogostovan**, zato izmerjeni pribitek ne vključuje omrežne razdalje —
je **spodnja meja** za pravega, oddaljenega posrednika.

## Zahteve

- **Node.js ≥ 20** in npm (razvito na v20 in v22)
- **Python ≥ 3.9** za analizo (`matplotlib`, `pandas`, `numpy`)
- neobvezno **Docker** in Docker Compose (mapi 04 in 05)
- neobvezno **Wireshark** za zajem poteka
- za **prave** meritve: denarnica na omrežju Sepolia s testnim ETH iz javne pipe (faucet)

## Hitri začetek (mock — brez denarnice, brez sredstev)

```bash
# 1) strežnik (prvi terminal)
cd 01_enkratna_placila/streznik
npm ci
cp .env.example .env
cp wallet.example.json wallet.json      # vpiši naslov prejemnika (za mock lahko ostane privzet)
npm run mock                            # MOCK_VERIFY=true → brez dostopa do verige

# 2) meritev (drugi terminal)
cd 01_enkratna_placila/klient
npm ci
npm run mock                            # 50 ponovitev protokolne latence → CSV

# 3) slike
cd 01_enkratna_placila/analiza
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 analiza_latence.py              # slike v analiza/slike/
```

## Denarnice — štiri vloge, financirati je treba tri

**Repozitorij namenoma ne vsebuje nobenih ključev.** Ustvariš si jih sam z `npm run gen-wallet`
(oz. `node generate-wallet.js`) v mapi plačnika. Prejemnik **nikoli** ne potrebuje privatnega
ključa in nikoli ne potrebuje sredstev.

| # | Vloga | Živi na | Vsebina `wallet.json` | Financiraj |
|---|---|---|---|---|
| **W1** | prejemnik (trgovec / IoT naprava / spletišče) | strežnik | samo `address` | **ne** |
| **W2** | plačnik za poskuse 01, 02, 03 in 06 | prenosnik | `address` + `privateKey` | da |
| **W3** | MetaMask (človek, prvi zavihek spletišča) | brskalnik | obstoječa | da, malo |
| **W4** | plačnik spletišč (mapi 04 in 05) | strežnik | `payerPrivateKey` | da, malo |

**W2 je ena sama denarnica za štiri poskuse** — ustvariš jo enkrat in kopiraš v `01/klient`,
`02/agent`, `03/agent` in `06/klient`; oblika `{address, privateKey}` je povsod enaka. Ker
poskuse poganjaš zaporedno, ni prekrivajočih se transakcij.

**W4 je namenoma ločena od W2**: leži v trajno delujoči storitvi na strežniku, zato njeno
razkritje ne sme ogroziti tudi merilne denarnice.

Vrednost samih plačil je zanemarljiva (privzeto `1e-7` ETH) — **prevladuje gas**: 21 000 enot na
nakazilo, kar je pri 20 gwei približno `0,00042` ETH. Ena polnitev iz javne pipe za Sepolio
zadošča za mnogo ponovitev.

> Uporabljaj **izključno namensko testno denarnico**. Nikoli ne vpisuj ključa denarnice, ki
> hrani prava sredstva. Datoteke `wallet.json` in `.env` so v `.gitignore`.

## Postavitev na dveh napravah

Vlogo določa program, ne naprava: **plačnik** (`klient/`, `agent/`) teče na **prenosniku**,
**ponudnik** (`streznik/`, `iot_naprava/`, `posrednik/`) na **strežniku**. Razlog ni estetski:
povezavo vedno vzpostavi plačnik, zato mora biti dosegljiv le ponudnik — prenosnik za domačim NAT
to ni. Tako gre plačilni promet čez pravo omrežje in ga je mogoče zajeti.

| Mapa | Na strežniku | Na prenosniku | Vrata | Spremenljivka za vrata | Naslov za odjemalca | Prijava |
|---|---|---|---|---|---|---|
| **00** demo | `server/` | `klient/` | 3000 | `MERCHANT_PORT` | `MERCHANT_URL` | je ni |
| **01** enkratno plačilo | `streznik/` | `klient/` | 3000 | `MERCHANT_PORT` | `MERCHANT_URL` | je ni |
| **02** transakcijska M2M | `iot_naprava/` | `agent/` | 3100 | `IOT_PORT` | `IOT_URL` | skrbniška |
| **03** merjena seja | `iot_naprava/` | `agent/` | 3200 | `IOT_PORT` | `IOT_URL` | skrbniška |
| **04** spletišče s posrednikom | `posrednik/` **in** `streznik/` | `agent/` | 4000 in 8081 | `POSREDNIK_PORT`, `PORT` | `--merchant-url`, `--posrednik-url` | **dve** skrbniški |
| **05** spletišče | vse (Docker + Caddy) | samo brskalnik | 8080 / 443 | `PORT` | — | skrbniška |
| **06** združena izmenjava | `streznik/` | `klient/` | 3300 | `MERCHANT_PORT` | `MERCHANT_URL` | je ni |

> **Pozor na dve različni spremenljivki za naslov:** mapi 01 in 06 uporabljata `MERCHANT_URL`,
> mapi 02 in 03 pa `IOT_URL`. Vsi strežniki že poslušajo na `0.0.0.0`.

Vse lahko poganjaš tudi na enem samem računalniku — takrat naslovi ostanejo `127.0.0.1`, zajem pa
opraviš na vmesniku loopback.

### Odpiranje vrat — `ufw` pogosto ni dovolj

```bash
# na strežniku
sudo ufw allow 3000/tcp && sudo ufw allow 3100/tcp && sudo ufw allow 3200/tcp
sudo ufw allow 3300/tcp && sudo ufw allow 4000/tcp && sudo ufw allow 8081/tcp
sudo ufw allow 8080/tcp && sudo ufw allow 80/tcp   && sudo ufw allow 443/tcp
```

Če strežnik teče pri ponudniku oblaka, ima ta praviloma **svoj požarni zid pred strežnikom** in
ta se ne nastavi sam — ista vrata moraš odpreti tudi v njegovi konzoli oziroma orodju ukazne
vrstice, sicer `ufw` ne pomaga.

**Diagnoza:** odjemalec pade s `timeout of 90000ms exceeded`, Wireshark pa kaže samo ponovitve
SYN → zahteva sploh ne pride do strežnika, torej manjka pravilo v požarnem zidu pred njim.
Takojšen `Connection refused` pomeni nasprotno: vrata so odprta, strežnik pa ne teče.

> Strežniki tečejo po **navadnem HTTP brez TLS** (glej razdelek o Wiresharku), zato dostop omeji
> na svoj IP — npr. `sudo ufw allow from <TVOJ_IP> to any port 3000 proto tcp` — in jih po
> meritvah ustavi. Za javno postavitev uporabi priloženo konfiguracijo Caddy s TLS (mapi 04, 05).

## Priporočen vrstni red poskusov

**01 → 02 → 03 → 05 → 04 → analize → primerjava.** Mapa **04 pride za 02 in 03**, ker njena
analiza svoje rezultate primerja z njunimi datotekami CSV. Mapa **06** je dvojček mape 01 (isti
strežnik, ista cena, ista denarnica, le združena izmenjava), zato jo poženeš kadar koli po 01.

**Zaporedno, en poskus naenkrat.** Vsaka mapa je samostojno okolje (svoj `node_modules`, svoja
baza, svoja denarnica, svoja vrata): zaženi → izmeri → ustavi → naslednji. Pri pravih plačilih je
to tudi varneje, ker se plačniška denarnica ne more sama sebi zaplesti v zaporedne številke
transakcij (nonce).

## Skrbniška prijava

Strežniki, ki v realnem načinu trošijo pravo denarnico, so zaprti s skrbniško prijavo (deljen
modul `auth.js`).

| Scenarij | Prijava | Vedno odprte poti |
|---|---|---|
| **01** enkratna plačila | ne — namenoma odprt (najčistejša osnovna meritev) | vse |
| **02** transakcije | da | `/health`, `/prijava`, `/odjava` |
| **03** dobroimetje | da | `/health`, `/prijava`, `/odjava` |
| **04** trgovec (`streznik/`) | da | `/health`, `/prijava`, `/odjava` |
| **04** posrednik (`posrednik/`) | da — **ločena, druga prijava** | `/health`, `/config`, `/submit-payment`, `/x402/supported`, `/prijava`, `/odjava` |
| **05** spletišče | da | `/health`, `/prijava`, `/odjava` |
| **06** združena izmenjava | ne — odprt | vse |

**Poverilnice se ustvarijo same ob prvem zagonu** — nikjer jih ni treba vnaprej nastavljati.
Strežnik zapiše izvleček gesla (scrypt) in strojni žeton v `data/admin.json`, berljiv izvod pa v
`data/admin-credentials.txt` (pravice `0600`; mapa `data/` je v `.gitignore`). Ob **ponovnih
zagonih se ne spremenita** — novi nastaneta le, če `admin.json` manjka ali je pokvarjen.

```bash
grep GESLO data/admin-credentials.txt      # prijava v brskalniku na /prijava
grep ZETON data/admin-credentials.txt      # strojni žeton za merilne agente
```

Odprto geslo je v polju `GESLO=` zapisano **samo ob zagonu, ki ga je ustvaril**; pozneje je tam
le opomba, da je nespremenjeno. Zato ga shrani takoj. `ZETON=` je vedno veljaven.

**Stroj (merilni agent)** se ne prijavlja z obrazcem, ampak pošlje glavo
`Authorization: Bearer <ZETON>`, ki jo prebere iz `ADMIN_TOKEN`:

```bash
cd 03_avtomatska_placila_dobroimetje/agent
export ADMIN_TOKEN=$(grep '^ZETON=' ../iot_naprava/data/admin-credentials.txt | cut -d= -f2)
npm run mock
```

Če strežnik teče na drugi napravi, žeton potegneš prek ssh v enem koraku:

```bash
export ADMIN_TOKEN=$(ssh <UPORABNIK>@<IP_STREZNIKA> \
  "grep '^ZETON=' <pot-do-repozitorija>/testna-okolja/02_avtomatska_placila_transakcije/iot_naprava/data/admin-credentials.txt | cut -d= -f2")
echo "$ADMIN_TOKEN"    # ne sme biti prazen!
```

V mapi **04 sta dve prijavi**: agent se predstavi *trgovcu* z njegovim `ADMIN_TOKEN`, trgovec pa
*posredniku* s `POSREDNIK_TOKEN`; če ta ni nastavljen, ga trgovec prebere kar iz
`../posrednik/data/admin-credentials.txt`.

**Novo geslo in žeton:** izbriši `data/admin.json` in znova zaženi strežnik. Poverilnice lahko
tudi vsiliš iz okolja (`ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_TOKEN`) — te imajo vedno prednost,
geslo iz okolja pa se nikoli ne zapiše na disk. `COOKIE_SECURE` pusti na `false`, sicer prijava
po navadnem HTTP (torej pri zajemu z Wiresharkom) ne deluje.

> **CSRF.** Piškotek `admin_sid` je `SameSite=Lax`, zato bi tuja stran s preprosto navigacijo
> lahko sprožila `/run/tx?queries=200` in porabila denarnico. Poti `/run/*` v mapah 04 in 05 zato
> poleg prijave zahtevajo še enkratni žeton seje (`GET /run/zeton` → `?zeton=…`) in zavrnejo
> zahteve z `Sec-Fetch-Mode: navigate` ali s tuje izvorne strani. Strojni dostop z
> `Authorization: Bearer` je izvzet — tam ambientalne poverilnice ni.

## Zajem z Wiresharkom

Za slikovna dokazila poteka (402, glava `X-Payment`, podpisane bremenitve, glave x402 v2)
potrebuješ **nešifriran promet**. Wireshark vsebine pod TLS ne vidi, zato vsi merilni strežniki
tečejo po **navadnem HTTP**. Produkcijska postavitev za Caddyjem (HTTPS) je za zajem neuporabna.

**Vmesnik:** `Loopback: lo`, kadar strežnik in odjemalec tečeta na istem računalniku; sicer
`wlan0` / `eth0`.

**Obvezen korak — „Decode As…".** Wireshark kot HTTP privzeto razčlenjuje le običajna vrata
(80, 8080 idr.). Brez tega ostanejo vsa druga vrata navaden TCP in filter `http` ne pokaže
**ničesar**. Desni klik na paket → **Decode As…** → polje *TCP port* → vpiši vrata → stolpec
*Current* nastavi na **HTTP** → *OK*. Za `tshark`: `-d tcp.port==3000,http`.

| Scenarij | Vrata | „Decode As" potreben |
|---|---|---|
| 00 demo | 3000 | da |
| 01 | 3000 | da |
| 02 | 3100 | da |
| 03 | 3200 | da |
| 04 posrednik | 4000 | da |
| 04 trgovec | 8081 | da |
| 05 | 8080 | ne (privzeto) |
| 06 | 3300 | da |

**Zajemni filter** (pred zagonom zajema, kadar meriš proti oddaljenemu strežniku):

```
host <IP_STREZNIKA> and (tcp port 3000 or tcp port 3100 or tcp port 3200 or tcp port 3300
                         or tcp port 4000 or tcp port 8080 or tcp port 8081)
```

**Prikazni filtri:**

```
http.response.code == 402            # plačilni izziv (vsi scenariji)
http contains "X-Payment"            # dostop z dokaznim žetonom (lastni protokol)
http contains "proof_"               # dokazni žeton
http contains "X-Signature"          # podpisana bremenitev EIP-191 (mapa 03)
http contains "X-Charged-Wei"        # zaračunani znesek v odgovoru (mapa 03)
http contains "PAYMENT-SIGNATURE"    # uradni x402 v2 (poti /x402/*)
http.authorization                   # zahteva s strojnim žetonom (mape 02–05)
http.response.code == 401            # zavrnjeno brez prijave
```

**Kaj mora biti na pravilnem posnetku:** par `402 Payment Required` z razčlenjenim telesom JSON
(`requestId`, `to`, `amount`) in za njim zahteva z glavo `X-Payment: proof_…` → `200 OK`. Pri
x402 v2 namesto tega `402` z glavo `PAYMENT-REQUIRED`, nato zahteva s `PAYMENT-SIGNATURE` →
`200` z `PAYMENT-RESPONSE`.

Zajem **vedno zaženi pred odjemalcem** in ga ustavi po njem. Za lepše ločene faze poženi
odjemalca z majhnim številom ponovitev in premorom (`--runs 1 --pause-ms 1500`). Za najčistejši
osnovni potek brez glave `Authorization` uporabi **mapo 01**, ki prijave nima.

> **Pred objavo posnetka:** strojni žeton in geslo se po navadnem HTTP prenašata v čistopisu.
> Na zaslonskih slikah zakrij glavo `Authorization: Bearer …`, telo zahteve `POST /prijava`
> (vsebuje **geslo v odprti obliki**) in piškotek `admin_sid` — ali pa po meritvah ustvari nove
> poverilnice (`rm data/admin.json` + ponovni zagon).

## Uradni protokol x402 v2

Poleg lastnega protokola (402 → transakcija ETH → `/verify-payment` → `proof_<uuid>` →
`X-Payment`) vsak scenarij podpira še **uradni protokol x402 v2** kot **vzporeden** način. Nobena
obstoječa pot, glava CSV ali topologija se ne spremeni: brez `X402_MODE` se ne zgodi nič.

- **Glave protokola:** strežnik izziv opiše v glavi `PAYMENT-REQUIRED` odgovora `402`, odjemalec
  podpisano pooblastilo **EIP-3009** pošlje v `PAYMENT-SIGNATURE`, izid poravnave se vrne v
  `PAYMENT-RESPONSE`.
- **Poti** živijo pod `/x402/*`: `GET /x402/config` povsod, dalje `GET /x402/service` (01, 06),
  `GET /x402/reading` (02), `POST /x402/session/open` in `/x402/reading-metered` (03),
  `GET /x402/enkratno/service` in `/x402/tx/reading` (04 trgovec), facilitatorske poti
  `POST /x402/verify`, `POST /x402/settle`, `GET /x402/supported` (04 posrednik).
- **Odjemalci** dobijo zastavico **`--x402`**; mapa 05 se sproži iz spletne strani.

```bash
X402_MODE=self X402_MOCK=true npm run mock      # 01, 02, 03, 05, 06 in posrednik v 04
X402_MODE=facilitated npm start                 # trgovec v 04 (dostop do verige mu je odvzet)
```

`X402_MOCK=true` uporabi **pravi** facilitator SDK, a z zamaškom namesto verige: podpis,
prejemnik, znesek, veljavnost in domena EIP-712 se preverijo **zares** (offline), poravnava pa
vrne sintetični hash s predpono `0x6d6f636b6d6f636b` („mockmock"). Vsaka taka vrstica CSV nosi
`sinteticni_tx=1`.

> **Zakaj je mock obvezen.** Sredstvo je tu testni ETH na Ethereum Sepolii, domači ETH pa nima
> pogodbe **EIP-3009**, ki jo shema `exact` potrebuje za pravo poravnavo. Če je `X402_MODE`
> vklopljen, `X402_MOCK` pa ne, se strežnik **ob zagonu namenoma ustavi z napako** — namesto da
> bi tek odpovedal šele pri poravnavi in vmes zapisal vrstice, označene kot „real". Pravi tek
> zahteva žeton s podporo EIP-3009 (`X402_USDC_ADDRESS`, `X402_ASSET_*`) in financirano
> poravnalno denarnico.

Rezultati gredo v **ločene datoteke** `x402_*.csv`; obdela jih `primerjava/primerjava_x402.py`,
ne analitične skripte posameznih map (x402 CSV so v atomskih enotah, ne v wei).

> **Metodološko opozorilo.** Kraka lastnega protokola in x402 si delita omrežje (Ethereum
> Sepolia) in denominacijo (ETH), zato ta dva dejavnika nista moteči spremenljivki. Ostaja pa
> ključna razlika: **poravnava x402 je v tej konfiguraciji sintetična in verige nikoli ne
> doseže**, medtem ko meritve lastnega protokola z `--real` vsebujejo pravo oddajo in čakanje na
> potrditev bloka. Izmerjene zakasnitve x402 zato **izključujejo čas poravnave na verigi** in
> razlik v latenci ni dovoljeno pripisati protokolu x402 samemu.

## Higiena meritev

- **Datoteke CSV se dopolnjujejo, ne prepisujejo.** Pred vsako pravo meritvijo izbriši star CSV
  iste mape — tudi tistega iz vaje na suho — sicer se dva teka zlijeta v enega, povzetek JSON pa
  opisuje samo zadnjega.
- **Vaja na suho pred vsako pravo meritvijo.** Če mock tek proti strežniku steče, so omrežje,
  vrata, žeton in konfiguracija v redu; šele nato porabi sredstva. Nato mock CSV pobriši.
- **Ne mešaj načinov med mapami.** Analitične skripte iščejo po vrsti `*_real.csv` → `*_mock.csv`
  → `_vzorec/*`. Če je mapa 02 v načinu *mock*, mapa 03 pa *real* (ali obratno), `primerjava.py`
  obe pomeša **brez opozorila** — zato vedno preberi vrstici `Mapa 02: …` in `Mapa 03: …`, ki ju
  izpiše.
- **Analize poganjaj tam, kjer so datoteke CSV.** Če si meril proti oddaljenemu strežniku, so
  rezultati na prenosniku, kjer je tekel odjemalec.

## Rezultati

Repozitorij vsebuje **samo kodo**. Datoteke CSV in slike nastanejo šele, ko poskuse zaženeš sam,
in so izključene iz gita — rezultati so torej vedno tvoji in ponovljivi.

Če želiš videti obliko slik brez pravih meritev, si lahko simulirane vhodne podatke ustvariš z
`primerjava/generiraj_vzorec.py`. Take slike nosijo rdeč vodni žig „SIMULIRANI PRIMER — NE PRAVE
MERITVE" in jih ne uporabljaj kot rezultat.

## Identiteta seje in menjava omrežja

Identiteta v tem sistemu **ni vezana na IP naslov**: prepoznava temelji na denarnici (podpis oz.
pošiljatelj transakcije) in na enkratnih žetonih (`requestId`, `proofToken`, `sessionId`), ki
potujejo z odjemalcem. Zato potek preživi menjavo omrežja (mobilno ↔ wifi, NAT). Spletišči (mapi
04 in 05) dodatno izdata korelacijski piškotek `sid`, ki pa **nikoli ni pogoj za dostop**.
Načelo, izvedba in preizkus so v [`docs/IDENTITETA.md`](docs/IDENTITETA.md).

## Struktura

```
testna-okolja/
├─ README.md                     (ta datoteka — skupni pregled)
├─ docs/
│   ├─ IDENTITETA.md             identiteta seje in neodvisnost od IP naslova
│   └─ OMREZJA.md                bi to delovalo na Sepoliji, mainnetu, Bitcoinu, USDC/EURC?
├─ 00_demo/                      server/ · klient/ · docs/                     ← vstopna točka
├─ 01_enkratna_placila/          streznik/ · klient/ · analiza/
├─ 02_avtomatska_placila_transakcije/  iot_naprava/ · agent/ · analiza/
├─ 03_avtomatska_placila_dobroimetje/  iot_naprava/ · agent/ · analiza/
├─ 04_spletisce_posrednik/       posrednik/ · streznik/ · agent/ · analiza/   ← topologija (b)
├─ 05_spletisce/                 streznik/                                    ← topologija (a)
├─ 06_x402/                      streznik/ · klient/ · analiza/               ← združeni tok
└─ primerjava/                   primerjava.py · primerjava_x402.py · generiraj_vzorec.py
```

Datoteke `x402.js`, `db_x402.js`, `auth.js`, `x402-odjemalec.js` in `slog.py` so namerno
podvojene v več mapah, da je vsaka mapa samostojno zaženljiva brez skupnih odvisnosti.

## Nadaljnje branje

- [`docs/IDENTITETA.md`](docs/IDENTITETA.md) — zakaj identiteta ni vezana na IP in kako se to preizkusi
- [`docs/OMREZJA.md`](docs/OMREZJA.md) — prenosljivost na druge verige, mainnet, Bitcoin, USDC/EURC
- [`00_demo`](00_demo) — najpreprostejše okolje za prikaz protokola, dobra vstopna točka
