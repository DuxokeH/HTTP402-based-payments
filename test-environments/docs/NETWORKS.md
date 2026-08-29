# Katera omrežja bi ta sistem lahko uporabljal?

> Vprašanje: *„ali bi to lahko uporabili za obstoječa omrežja — Sepolia, Bitcoin, pravi
> Ethereum ali katero koli drugo?"*
>
> Kratek odgovor: **Sepolia deluje danes. Druge verige EVM so nastavitev in približno
> štiri datoteke. Pravi Ethereum tehnično deluje, ekonomsko pa ne. Bitcoin ni nastavitev,
> ampak predelava plasti preverjanja (~40 % kode). USDC/EURC je nova zmožnost, a je
> posredniška veja (mapa 04) zanjo najkrajša pot.**

Ta dokument je **analiza, ne načrt dela** — razen kjer je izrecno navedeno drugače, nobena
od spodnjih sprememb ni izvedena. Namen je natančno razmejiti, kateri deli sistema so
prenosljivi na druga omrežja in kateri ne.

## Povzetek

| Omrežje / sredstvo | Deluje? | Kaj bi bilo treba | Zakaj |
|---|---|---|---|
| **Ethereum Sepolia** | ✅ danes | nič | privzeta nastavitev |
| **Druge verige EVM** (Base, Polygon, Arbitrum, Optimism) | 🟡 majhen poseg | nastavitev + ~4 datoteke | drug `chainId`, drug objekt verige v brskalniku |
| **Ethereum mainnet** | 🟡 tehnično da, ekonomsko ne | isto kot zgoraj | 21 000 enot gasa preseže mikroplačilo za velikostne rede |
| **Bitcoin (osnovna plast)** | ❌ ne brez predelave | nova plast preverjanja | UTXO namesto računov, brez potrdil, brez gasa, drug format podpisa |
| **Lightning / L402** | 🟡 drug sistem, isti vzorec | ločena izvedba | to je bitcoinov lastni ustreznik x402 |
| **USDC / EURC (ERC-20)** | 🟡 nova zmožnost | posrednik + trgovec | drugačno branje transakcije; 6 decimalk, ne 18 |

---

## 1. Ethereum Sepolia — deluje danes

`NETWORK=sepolia`, `chainId 0xaa36a7`, bloki ~12 s. To je privzeta in preizkušena
nastavitev vseh map.

## 2. Druge verige EVM — nastavitev in približno štiri datoteke

Preverjanje plačila je popolnoma prenosljivo: `getTransaction` + `getTransactionReceipt`
in primerjava `to` / `value` / `from` delujejo enako na vsaki verigi EVM. Prav tako so
nespremenjeni podpisi EIP-191, shema SQLite in **celoten merjeni način**.

Spremeniti je treba tole:

| Mesto | Kaj | Opomba |
|---|---|---|
| `.env` | `NETWORK`, `RPC_URL` | pravilnik CSP `RPC_URL` doda sam (`RPC_ORIGIN`) — dovoljenj ni treba urejati |
| `streznik/server.js` (`/config`) | ternarni izraz `NETWORK === 'sepolia' ? '0xaa36a7' : null` | za drugo verigo vrne `null` in brskalnik ne ve, na kaj naj preklopi |
| `streznik/server.js` (`/enkratno/config`) | v mapah 04/05 je bil `'0xaa36a7'` zapisan **brezpogojno** | v tej izdaji že popravljeno na isti ternarni izraz; pot je sicer mrtva (stran je ne kliče), a je bila skrita past |
| `streznik/public/app.js` | uvoz `sepolia` iz `viem/chains`, primerjava z dobesednim `'0xaa36a7'` namesto s `CFG.chainId` | poleg tega ni rezerve `wallet_addEthereumChain` — mapa 01 jo ima (`public/app.js:33-41`) in jo je vredno prekopirati |

**Ločena, prava napaka (velja za vsa omrežja).** `streznik/runner.js` ima trdo zapisano
`tx.wait(1)` namesto `MIN_CONFIRMATIONS`. Če nastaviš `MIN_CONFIRMATIONS=3`, vgrajeni
agent počaka le eno potrditev, preverjanje pa jih zahteva tri — in vsako preverjanje
odpove. Na verigah s hitrejšimi bloki (Base ~2 s) je večja globina potrditev prav
priporočljiva, zato bi ta hrošč tam udaril takoj.

## 3. Ethereum mainnet — tehnično isto, ekonomsko brez smisla

Strukturno se ne spremeni nič: mainnet je veriga EVM kot vsaka druga. Se pa sesuje
ekonomija. Prenos ETH stane 21 000 enot gasa; pri realnih cenah mainneta je to
**velikostne rede več od samega mikroplačila** (~1 cent). Plačilo za odčitek senzorja bi
imelo provizijo, večjo od odčitka.

Ta ocena je **navedena, ne izmerjena** — meritev na mainnetu v tem repozitoriju ni.
Vredno je poudariti: prav to je razlog za merjeni način. Model
„ena polnitev + N podpisanih bremenitev" strošek gasa deli z N, zato je edini od treh
tokov, ki bi bil na mainnetu sploh smiseln — in tudi tam šele pri dovolj velikem N.

## 4. Bitcoin — ni nastavitev, ampak nova plast preverjanja

Tu se predpostavke razidejo. Bitcoin nima računov, ampak **UTXO**:

| Predpostavka v kodi | Na Bitcoinu |
|---|---|
| `tx.from` — pošiljatelj | **ne obstaja**; vhodi so reference na prejšnje izhode |
| en `tx.to` in en `tx.value` | transakcija ima **več izhodov**; „prejemnik" je eden od njih |
| `receipt.status === 1` | **ni potrdil**; transakcija je bodisi v bloku bodisi ne |
| `gasUsed`, `gasPrice` | **ni gasa**; provizija je razlika med vhodi in izhodi |
| `ethers.getAddress` + `.toLowerCase()` | naslovi bech32 in base58 — **`toLowerCase()` na base58 naslov pokvari**, ker je tam velikost črk pomenska |
| `ethers.verifyMessage` (EIP-191) | ustreznik je **BIP-322** (oz. starejši „signmessage") |
| wei, 18 decimalk | satoshi, 8 decimalk |

Poleg tega **desetminutni bloki ubijejo tok „plačilo na odčitek"**: 20 odčitkov s po eno
potrditvijo je ~3 ure in več. Praktično bi počilo prej — `runner.js` ima `tx.wait(1)`,
odjemalci pa 90-sekundno časovno omejitev axios.

**Kaj bi preživelo:** oblika protokola 402, `db.js`, `auth.js`, SSE, skrbniška prijava in —
kar je najpomembnejše — **celotna zasnova „1 polnitev + N podpisanih bremenitev"**. Merjeni
način je namreč **že zdaj neodvisen od verige pod ravnjo polnitve**: verige se dotakne
izključno `/merjeno/session/open`. Vse ostalo so podpisi in knjigovodstvo.

Bitcoinov domači ustreznik je **Lightning / L402** (prej LSAT): tudi ta uporablja HTTP 402
in žeton, ki ga odjemalec predloži. L402 je najbližji soroden pristop temu sistemu.
Za Bitcoin je to prava pot — ne prilagajanje te kode osnovni plasti.

## 5. USDC / EURC — nova zmožnost, in posredniška veja je najkrajša pot

Danes v `testna-okolja/` **ni podpore za ERC-20**: vsi trije tokovi merijo `tx.value`, kar je
domači ETH. Za žetone bi bilo treba:

- brati **dogodek `Transfer`** iz potrdila namesto `tx.value`;
- upoštevati, da je `tx.to` pri žetonskem prenosu **naslov pogodbe žetona**, ne prejemnika —
  zato se preverjanje prejemnika (`streznik/server.js`, primerjava z `RECEIVER`) obrne;
- **6 decimalk namesto 18** (USDC in EURC), torej vse pretvorbe `parseEther`/`formatEther`;
- odobritev / stanje žetona na strani plačnika.

**Zakaj je za to najprimernejša mapa 04 (posrednik):** stara izvedba posrednika
`Transfer` **že zna razbrati** (koda je v `experiments/legacy/.../facilitator.js`, čeprav
neuporabljena), predvsem pa je v topologiji (b) branje verige na **enem samem mestu**.
Prehod na žetone je torej sprememba **posrednika**, trgovec pa ostane nedotaknjen — kar
je mimogrede lep argument za samo topologijo (b).

Dvoje je vredno izpostaviti:

1. **EIP-3009** (`transferWithAuthorization`) je tisto, kar dela *uradni* x402: plačnik
   podpiše pooblastilo, gas plača posrednik, plačnik ne potrebuje domačega žetona verige.
   To ostaja med nadaljnjim delom.
2. Coinbasov gostovani posrednik podpira **Base Sepolia, ne pa Ethereum Sepolia**. Uradni
   x402 krak zato v tem repozitoriju teče samogostovano, v **testni konfiguraciji,
   denominirani v ETH, na Ethereum Sepolii** (poravnava sintetična/mock) — primerjava
   zakasnitev tako poteka na enem samem omrežju. **Prava** x402 poravnava pa še vedno
   zahteva ERC-20 žeton z EIP-3009 (USDC/EURC), kar ostaja nadaljnje delo.

**EURC.** Primerjava z reguliranim evrskim stabilnim kovancem (EURC) v tej kodi zavestno ni
zajeta. Če bi se to vrnilo v obseg, je zgornji odstavek najcenejša pot: EURC je ERC-20 kot
USDC, torej ista sprememba.

## 6. Kaj je pravzaprav vezano na verigo

Večina sistema **ni**:

| Sloj | Vezan na verigo? |
|---|---|
| protokol HTTP 402, plačilna zahteva, dokazni žeton | ne |
| shema SQLite, enkratnost žetona, preprečevanje ponovitve | ne |
| skrbniška prijava, korelacija seje `sid`, CSP, Caddy | ne |
| merjena seja: dobroimetje, proračun, veljavnost, nonce | ne |
| podpis bremenitve (EIP-191) | **da** — oblika podpisa je specifična za EVM |
| preverjanje plačila (`getTransaction` / potrdilo) | **da** |
| polnitev merjene seje | **da** — a to je ena sama pot |

Od treh tokov je torej **merjeni najbolj prenosljiv**: verige se dotakne le enkrat na sejo.
To je hkrati odgovor na vprašanje in argument za sam model merjene seje
(„ena polnitev + N podpisanih bremenitev").
