# Postavitev na oddaljenem strežniku

Navodila za javno postavitev demo okolja na **katerem koli strežniku z Linuxom** — najetem
virtualnem strežniku (VPS), lastnem stroju v omrežju ali napravi doma. Nič v tem postopku ni
vezano na določenega ponudnika.

Za lokalni zagon teh navodil ne potrebuješ — glej [`../README.md`](../README.md).

> **Kdaj to sploh potrebuješ.** Za preizkus protokola zadostuje lokalni zagon. Oddaljena
> postavitev je smiselna, kadar hočeš plačati z MetaMask iz telefona, pokazati okolje nekomu
> drugemu ali zajeti promet, ki teče čez pravo omrežje.

## Kaj potrebuješ

- strežnik z **Ubuntu 22.04 ali novejšim** (zadostuje 1 vCPU in 1 GB pomnilnika), z dostopom
  ssh in javnim naslovom IP
- **domeno**, če hočeš HTTPS (brez nje deluje samo dostop po IP in navadnem HTTP)
- denarnico na omrežju **Ethereum Sepolia** s testnim ETH (samo za realni način)
- neobvezno **ključ OpenAI**, če hočeš prave odgovore namesto nadomestnih

## 1. Pripravi strežnik

```bash
ssh <UPORABNIK>@<IP_STREZNIKA>

# posodobitve
sudo apt update && sudo apt upgrade -y

# Docker (uradna namestitvena skripta)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
exit          # odjavi se in znova prijavi, da se članstvo v skupini uveljavi
```

### Požarni zid

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Če strežnik teče pri ponudniku oblaka, ima ta **svoj požarni zid pred strežnikom** — ista
vrata moraš odpreti tudi tam, sicer `ufw` ne pomaga. Znak, da je to težava: povezava se
izteče brez odgovora, namesto da bi jo strežnik zavrnil.

> **Dostop po ssh omeji na svoj naslov IP**, če ga imaš stalnega:
> `sudo ufw allow from <TVOJ_IP> to any port 22 proto tcp` in nato `sudo ufw delete allow OpenSSH`.

## 2. Domena in DNS (neobvezno, a priporočeno)

Pri registrarju domene dodaj zapis **A**, ki kaže na javni naslov strežnika:

| Tip | Ime | Vrednost | Proxy |
|---|---|---|---|
| A | `x402` (ali `@`) | `<IP_STREZNIKA>` | izklopljen |

Če ponudnik DNS ponuja posredniški način („proxy", „oblak"), ga **izklopi** — Caddy mora sam
pridobiti potrdilo Let's Encrypt, za to pa mora vrata 80 in 443 doseči neposredno.

Preveri, da se ime razreši:

```bash
dig +short x402.tvoja-domena.si
```

## 3. Ustvari denarnici

Denarnici ustvari **na svojem računalniku, ne na strežniku**, in na strežnik prenesi samo
tisto, kar tam res rabiš:

```bash
# lokalno
cd testna-okolja/00_demo
npm ci
node generate-wallet.js        # ustvari server/wallet.json in klient/wallet.json
```

Strežnik potrebuje **samo denarnico trgovca** (prejemnika), ki nikoli ne potrebuje sredstev:

```bash
scp server/wallet.json <UPORABNIK>@<IP_STREZNIKA>:~/wallet.json
```

> Datoteka ima pravice `0600`. Denarnica odjemalca (`klient/wallet.json`) ostane pri tebi —
> ta je edina, ki hrani sredstva. Uporabljaj izključno namensko testno denarnico.

## 4. Prenesi in nastavi projekt

```bash
ssh <UPORABNIK>@<IP_STREZNIKA>
git clone <url-repozitorija> ~/x402-repo
cd ~/x402-repo/testna-okolja/00_demo/server
cp .env.example .env
nano .env
```

Nastavitve, o katerih se je vredno odločiti:

| Spremenljivka | Priporočeno za javno postavitev |
|---|---|
| `NODE_ENV` | `production` — vklopi strogi CORS in izklopi razvojno beleženje |
| `ALLOWED_ORIGINS` | `https://x402.tvoja-domena.si` (z vejico ločeni izvori) |
| `RPC_URL` | javno vozlišče deluje; za več prometa vpiši lasten ponudnik JSON-RPC |
| `MIN_CONFIRMATIONS` | `1` na Sepolii |
| `SERVICE_PRICE_ETH` | cena ene uporabe storitve |
| `OPENAI_API_KEY` | prazno → nadomestni odgovor; vpisan → pravi klici |
| `OPENAI_DAILY_USD_CAP` | mehka dnevna meja |

> **Če vpišeš ključ OpenAI**, nastavi **trdo mesečno mejo porabe tudi pri ponudniku ključa.**
> Nastavitev `OPENAI_DAILY_USD_CAP` je le mehka zaščita v tej aplikaciji in ne prepreči
> stroškov, če ključ uide.

Denarnico trgovca prestavi na mesto:

```bash
mv ~/wallet.json ~/x402-repo/testna-okolja/00_demo/server/wallet.json
chmod 600 ~/x402-repo/testna-okolja/00_demo/server/wallet.json
```

## 5. Zaženi

### Varianta A — Docker in Caddy (s HTTPS)

V `Caddyfile` zamenjaj `your-domain.example` s svojo domeno, nato:

```bash
cd ~/x402-repo/testna-okolja/00_demo/server
docker compose up -d
docker compose logs -f          # Ctrl-C prekine spremljanje, storitvi tečeta naprej
```

Caddy potrdilo pridobi sam ob prvem obisku. Preveri:

```bash
curl -s http://localhost:3000/health          # z gostitelja
curl -s https://x402.tvoja-domena.si/health   # od zunaj
# pričakuj {"status":"ok","db":"ok","rpc":"ok",…}
```

### Varianta B — brez Dockerja (systemd)

```bash
cd ~/x402-repo/testna-okolja/00_demo/server
npm ci
sudo cp systemd/x402.service /etc/systemd/system/
sudo nano /etc/systemd/system/x402.service    # popravi User= in WorkingDirectory=
sudo systemctl daemon-reload
sudo systemctl enable --now x402
sudo systemctl status x402
journalctl -u x402 -f
```

### Varianta C — samo HTTP, za zajem z Wiresharkom

Za opazovanje protokola potrebuješ **nešifriran** promet, torej brez Caddyja:

```bash
sudo ufw allow from <TVOJ_IP> to any port 3000 proto tcp
cd ~/x402-repo/testna-okolja/00_demo/server && npm ci && npm start
```

> Tako postavljen strežnik **ne sme ostati javno dosegljiv**. Dokazni žeton je „bearer"
> poverilnica — kdor ga po nešifrirani povezavi prestreže, dostopa do vsebine. Po zajemu
> strežnik ustavi in vrata zapri.

## 6. Preveri od konca do konca

Iz brskalnika odpri `https://x402.tvoja-domena.si`, poveži MetaMask (omrežje Sepolia) in
opravi plačilo. V dnevniku strežnika se mora pojaviti vrstica o preverjeni transakciji, nato
pa dostava vsebine.

Z odjemalcem CLI z lastnega računalnika:

```bash
cd testna-okolja/00_demo/klient
# v config.json nastavi MERCHANT_URL na https://x402.tvoja-domena.si
npm ci && node run.js --pause-ms 1500
```

## 7. Vzdrževanje

**Posodobitev:**

```bash
cd ~/x402-repo && git pull
cd testna-okolja/00_demo/server && docker compose up -d --build
```

**Varnostna kopija.** Pomembni sta samo dve stvari: `server/wallet.json` (denarnica trgovca)
in `server/data/x402.db` (plačilne zahteve, dokazila, poraba). Kopijo hrani **izven** strežnika:

```bash
# z lastnega računalnika
scp <UPORABNIK>@<IP_STREZNIKA>:~/x402-repo/testna-okolja/00_demo/server/wallet.json ./varnostna-kopija/
scp <UPORABNIK>@<IP_STREZNIKA>:~/x402-repo/testna-okolja/00_demo/server/data/x402.db ./varnostna-kopija/
```

Baza je SQLite v načinu WAL; za dosledno kopijo storitev pred prenosom ustavi
(`docker compose stop` oziroma `sudo systemctl stop x402`).

**Spremljanje delovanja.** Pot `/health` vrne `200`, ko so v redu baza, povezava do verige in
zunanji API, sicer `503`. Primerna je za katero koli storitev za spremljanje razpoložljivosti
ali za preprost cron:

```bash
*/5 * * * * curl -fsS https://x402.tvoja-domena.si/health >/dev/null || echo "x402 ne odgovarja" | mail -s "x402" tvoj-naslov@tvoja-domena.si
```

## 8. Pred javno objavo premisli

- **Stroški.** Strežnik teče neprekinjeno in se plačuje po času. Če ga potrebuješ samo za
  prikaz, ga med uporabami ustavi.
- **Ključ zunanjega API.** Brez trde meje pri ponudniku lahko zloraba povzroči stroške.
  Brez ključa okolje deluje enako, le vrne nadomestni odgovor.
- **Pravna besedila.** Če stran objaviš širši javnosti, dodaj pogoje uporabe in izjavo o
  zasebnosti; strežnik beleži naslove denarnic in zgoščene vrednosti transakcij.
- **Samo testno omrežje.** Privzeta konfiguracija je Ethereum Sepolia. Prehod na omrežje s
  pravo vrednostjo bi zahteval revizijo, večjo globino potrditev in previdnost pri hrambi
  ključev — to okolje za to ni namenjeno.

## Odpravljanje težav

| Znak | Vzrok |
|---|---|
| povezava se izteče brez odgovora | vrata zaprta v požarnem zidu (pogosto pri ponudniku, ne v `ufw`) |
| `Connection refused` | vrata so odprta, strežnik ne teče |
| Caddy ne dobi potrdila | DNS še ni razširjen, posredniški način ni izklopljen ali vrata 80 zaprta |
| `/health` vrne 503 | ni dosegljivo vozlišče JSON-RPC — preveri `RPC_URL` |
| `wallet.json not found` | denarnica trgovca ni na strežniku ali ima napačno pot |
| `429 Too Many Requests` | omejevalnik pogostosti; podaljšaj premor med zahtevami |
