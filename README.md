# Mikroplačila po protokolu HTTP 402

Delujoče izvedbe plačevanja spletnih storitev s statusno kodo **HTTP 402 Payment Required** in
protokolom **x402**: strežnik za dostop zahteva plačilo, odjemalec plača na verigi blokov,
strežnik plačilo preveri in šele nato postreže vsebino.

Repozitorij vsebuje **sedem samostojnih okolij** — od najpreprostejšega prikaza do merilnih
postavitev, ki primerjajo različne modele plačevanja in arhitekture. Vsako okolje ima svoja
navodila, svoje odvisnosti in ga je mogoče pognati ločeno od drugih.

Vse teče na **testnem omrežju Ethereum Sepolia**, nikoli s pravimi sredstvi, in vsako okolje
ima **način mock**, ki deluje popolnoma brez denarnice in brez dostopa do verige.

## Kaj je HTTP 402

Statusna koda `402 Payment Required` je v standardu HTTP rezervirana od leta 1997, a nikoli ni
bila standardizirana — do razmaha kriptovalut zanjo ni bilo splošno uporabnega plačilnega
sredstva. Osnovni potek je preprost:

```
odjemalec                                strežnik
    │                                        │
    │──── GET /storitev ────────────────────►│   zahteva brez plačila
    │◄─── 402 Payment Required ──────────────│   „plačaj toliko, na ta naslov"
    │                                        │
    │──── plačilo na verigi blokov ──────────┼──► ...
    │                                        │
    │──── GET /storitev + dokazilo ─────────►│   strežnik preveri plačilo na verigi
    │◄─── 200 OK + vsebina ──────────────────│
```

Zanimiva vprašanja se začnejo šele za tem. Kako **nedvoumno povezati** plačilo s točno tisto
zahtevo, ki ga je sprožila? Kako preprečiti, da bi isto plačilo unovčili dvakrat? Kaj, ko je
plačil na tisoče in strošek transakcije preseže samo storitev? Kdo sploh preverja verigo —
ponudnik sam ali posrednik? Na ta vprašanja odgovarjajo okolja v tem repozitoriju.

## Kje začeti

**Če želiš samo videti, kako to deluje**, poženi
[`testna-okolja/00_demo`](testna-okolja/00_demo). To je najpreprostejše okolje: strežnik,
odjemalec v ukazni vrstici in stran za brskalnik z MetaMask. Brez denarnice, v dveh terminalih:

```bash
git clone <url-tega-repozitorija>
cd HTTP402-based-payments/testna-okolja/00_demo

# terminal 1 — strežnik
cd server && npm ci && cp .env.example .env && npm run mock

# terminal 2 — odjemalec
cd klient && npm ci && npm run mock
```

Odjemalec izpiše celoten potek: `402 Payment Required` → plačilo → `200 OK` z vsebino.

**Če te zanima primerjava modelov plačevanja**, pojdi v
[`testna-okolja/`](testna-okolja) — tam je skupni pregled in po eno okolje na scenarij.

## Okolja

| Okolje | Vprašanje, na katero odgovarja | Vrata |
|---|---|---|
| [`00_demo`](testna-okolja/00_demo) | Kako izgleda najkrajši možni potek? Plačilo in dostava vsebine v dveh izmenjavah. | 3000 |
| [`01_enkratna_placila`](testna-okolja/01_enkratna_placila) | Koliko časa vzame posamezna faza plačila in kje se čas dejansko porabi? | 3000 |
| [`02_avtomatska_placila_transakcije`](testna-okolja/02_avtomatska_placila_transakcije) | Kaj se zgodi, če stroj plača **vsak** odčitek senzorja s svojo transakcijo? | 3100 |
| [`03_avtomatska_placila_dobroimetje`](testna-okolja/03_avtomatska_placila_dobroimetje) | Koliko prihrani model, kjer **ena** polnitev pokrije N podpisanih bremenitev? | 3200 |
| [`04_spletisce_posrednik`](testna-okolja/04_spletisce_posrednik) | Kaj stane arhitektura, v kateri ponudnik nima dostopa do verige in preverja **posrednik**? | 4000 + 8081 |
| [`05_spletisce`](testna-okolja/05_spletisce) | Isto spletišče, a ponudnik verigo bere sam — primerjalna postavitev za okolje 04. | 8080 |
| [`06_x402`](testna-okolja/06_x402) | Koliko latence in sporočil prihrani **združitev** preverjanja in dostave v eno izmenjavo? | 3300 |
| [`primerjava`](testna-okolja/primerjava) | Orodje, ki rezultate okolij 02 in 03 združi v primerjalne slike. | — |

Okolji **04 in 05** sta par: ista stran in isti tokovi, razlika je samo v tem, ali ponudnik
verigo bere sam ali to zanj počne ločen posrednik. Okolji **02 in 03** sta par na drugi osi:
ena transakcija na uporabo proti eni transakciji na N uporab.

## Kaj je še v repozitoriju

- [`testna-okolja/README.md`](testna-okolja/README.md) — skupna navodila za vsa okolja: vloge
  denarnic, postavitev na dveh napravah, skrbniška prijava, zajem prometa z Wiresharkom in
  vzporedni način po uradnem protokolu x402 v2.
- [`testna-okolja/docs/`](testna-okolja/docs) — dve poglobljeni razpravi:
  [`IDENTITETA.md`](testna-okolja/docs/IDENTITETA.md) (zakaj identiteta seje ni vezana na
  naslov IP in kako se to preizkusi) in [`OMREZJA.md`](testna-okolja/docs/OMREZJA.md) (kaj bi
  bilo treba, da bi to delovalo na drugih verigah, na Bitcoinu ali z USDC).

## Zahteve

- **Node.js ≥ 20** in npm — za vsa okolja
- **Python ≥ 3.9** (`matplotlib`, `pandas`, `numpy`) — samo za analizo rezultatov
- neobvezno **Docker** in Docker Compose — za okolji 04 in 05 ter javno postavitev
- neobvezno **Wireshark** — za opazovanje protokola na žici
- za zagon z **realnimi** plačili: denarnica na omrežju Ethereum Sepolia s testnim ETH iz
  javne pipe (faucet)

## Varnost in testne denarnice

**Repozitorij ne vsebuje nobenih denarnic, privatnih ključev ali poverilnic.** Vsak si jih
ustvari sam:

```bash
node generate-wallet.js        # v mapi odjemalca oz. agenta
```

Nastale datoteke `wallet.json` in `.env` so v [`.gitignore`](.gitignore) in ne smejo nikoli v
repozitorij. Enako velja za skrbniške poverilnice, ki si jih strežniki ob prvem zagonu
ustvarijo sami v `data/admin-credentials.txt`.

- **Uporabljaj izključno namensko testno denarnico.** Nikoli ne vpisuj ključa denarnice, ki
  hrani prava sredstva. Testni ETH nima vrednosti in ga dobiš brezplačno.
- Okolja privzeto tečejo po **navadnem HTTP brez TLS**, da je promet berljiv v Wiresharku.
  Zato jih ne izpostavljaj javnemu internetu brez omejitve dostopa; za javno postavitev je
  priložena konfiguracija Caddy s TLS.
- Poti, ki v realnem načinu porabljajo sredstva, so zaščitene s skrbniško prijavo — glej
  [skupna navodila](testna-okolja/README.md#skrbniška-prijava).

## Rezultati

V repozitoriju je **samo koda**. Vse datoteke CSV in slike nastanejo šele, ko okolja pogeneš
sam, in so izključene iz gita — rezultati so torej vedno tvoji in ponovljivi. Če želiš videti
obliko slik brez pravih meritev, si lahko simulirane vhodne podatke ustvariš s
`testna-okolja/primerjava/generiraj_vzorec.py`; take slike nosijo vodni žig
„SIMULIRANI PRIMER".

## Samodejno preverjanje

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) ob vsakem potisku namesti odvisnosti,
ustvari testni denarnici, zažene strežnik in preveri, da `GET /service` vrne **402**, da
celoten mock tok pride do **200 OK** in da varnostni testi uspejo — tako je razvidno, ali
repozitorij ob prevzemu res deluje.

Ročno preverjeno: mock tok vseh okolij, varnostni testi, analize v Pythonu in primerjalne
slike. Zagoni z realnimi plačili, postavitev z Dockerjem in TLS ter zajemi z Wiresharkom
zahtevajo sredstva oziroma infrastrukturo, zato so dokumentirani, ne pa samodejno preverjeni.

## Licenca

MIT — glej [LICENSE](LICENSE).
