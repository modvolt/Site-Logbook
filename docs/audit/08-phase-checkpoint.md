# Checkpoint FÁZE 8.10 – R06a: důvěryhodný veřejný origin

- **Stav:** FÁZE 8.10 dokončena lokálně. SEC-18 je uzavřen v rozsahu tvorby veřejných bearer odkazů a webového Host allowlistu; R06 jako celek ani R07 dokončeny nejsou.
- **Výchozí revize:** `cebfd88` (`main`; checkpoint FÁZE 8.9).
- **Implementační revize:** `b620014` (`security: trust a canonical public application origin`). Dokumentační checkpoint následuje jako samostatný commit.
- **Produkční zásah:** žádný. Nebyla použita produkční DB, produkční secrets, `modvoltapp.cz`, vzdálený Git, push ani deploy.
- **Databázová změna:** žádná. Tato podfáze nepřidává migraci, backfill ani změnu formátu existujících tokenů.
- **Provozní dokument:** [08-public-origin-runbook.md](08-public-origin-runbook.md).

## 1. Opravené vymezení FÁZE 8

Kontrola centrální roadmapy ukázala, že P0 vlna není po R05 úplná: výslovně zahrnuje R00–R07. Předchozí checkpoint proto doporučil FÁZI 9 předčasně. R00–R05 jsou lokálně implementačně uzavřené, ale R06 a R07 zůstávají otevřené.

R06 má velikost XL a kombinuje několik různých rizik. FÁZE 8.10 jej záměrně rozdělila a implementovala pouze R06a / SEC-18: zákaz odvozování veřejného originu z nedůvěryhodného requestu a fail-closed Host hranici. Jednotný token lifecycle, atomické transitiony a neměnné job/quote snapshoty nebyly v tomto spuštění zahájeny.

## 2. Lokálně uzavřená architektura SEC-18

### Kanonický aplikační origin

Nový modul `public-origin.ts` je jediným zdrojem originu pro externí odkazy. `PUBLIC_APP_URL` musí být samostatný HTTP(S) origin bez credentials, cesty, query a fragmentu; produkce vyžaduje HTTPS. Výsledek se normalizuje na `URL.origin`. Konstruktor odkazu přijímá pouze root-relative cestu a znovu kontroluje shodu originu.

Produkční API validuje konfiguraci při startu, takže se nestane healthy bez bezpečně použitelného originu. Neprodukční konfigurační chyba během requestu se mapuje na bezpečnou `503 public_origin_unavailable` bez zveřejnění hodnoty konfigurace. Tvorba tokenu/protokolu validuje origin před DB zápisem nebo nákladným vedlejším efektem tam, kde daný tok nový artefakt vytváří.

### Pokryté toky

| Tok | Dřívější zdroj | Stav po FÁZI 8.10 |
|---|---|---|
| podpis zakázky | `req.protocol` + request `Host` | `publicAppUrl()` před uložením tokenu |
| potvrzení OOPP | `req.protocol` + request `Host` | `publicAppOrigin()` před uložením tokenu |
| sdílení nabídky | requestem předaný base URL | service načte pouze kanonický origin před PDF/storage efekty |
| QR rozvaděče, štítky a protokoly | request base URL nebo hardcoded fallback | pouze kanonický origin; žádný request/fallback |

Cílené vyhledání po změně našlo v API jediný zbývající výskyt `req.protocol`/`req.get("host")` v `webauthn.ts`, kde slouží ke kontrole forwarded protokolu WebAuthn a nekonstruuje veřejný bearer odkaz. Do tohoto řezu proto nebyl zahrnut.

### Webový edge

Nginx má samostatný první `default_server` se `server_name _` a `return 444`. Aplikační server přijímá pouze hostnames z `NGINX_SERVER_NAME` a loopback názvy pro healthcheck. Compose předává `PUBLIC_APP_URL` do API a `NGINX_SERVER_NAME` do web služby; produkční postup a abort podmínky jsou v runbooku a `DEPLOYMENT.md`.

## 3. Důkazy a kontroly

### Čistý ověřovací checkout

Do čistého checkoutu na revizi `cebfd88` byly přeneseny pouze soubory FÁZE 8.10. Závěrečný běh po posledních úpravách obsluhy chyb prokázal:

- TypeScript build závislých projektů `db`, `api-zod` a `live-events`: prošel;
- API typecheck: prošel;
- celý API unit gate: **38/38 souborů, 267/267 testů**;
- produkční API build: prošel;
- cílené DB integrační testy PPE + quote: **2/2 soubory, 11/11 testů**;
- `docker compose config -q` se syntetickými neprodukčními hodnotami: prošel;
- statický edge kontrakt ověřil `default_server`, `return 444`, host allowlist a předání obou environment parametrů;
- `git diff --check` i `git diff --cached --check`: prošly.

Čerstvý izolovaný PostgreSQL 18 cluster aplikoval celý aktuální řetězec **101/101 migrací**. Poslední `0100_user_ui_preferences` pochází ze souběžné uživatelské redesign práce a není součástí FÁZE 8.10. První quote běh odhalil pouze chybějící testovací `billing_settings` fixture; po vložení minimálního fixture byl finální společný běh 11/11 zelený.

### Hlavní pracovní strom

Celý API unit gate v hlavním checkoutu měl **266/267** testů: jediný neúspěch `field-job-workflow-contract.test.ts` souvisí se souběžnou nezahrnutou změnou navigace, která rozšířila field route set. FÁZE 8.10 tento uživatelský redesign neopravovala ani nestagovala. Čistý checkout se samotným bezpečnostním řezem má 267/267 a dokládá, že změna SEC-18 regresi nezavádí.

Docker klient byl dostupný, ale lokální Docker daemon nikoli. Skutečný nginx kontejner proto nebyl spuštěn; mezera je pokryta statickým unit kontraktem a validací Compose syntaxe, nikoli runtime důkazem.

## 4. Nejasnosti a zbytková rizika

1. Produkční reverse proxy, DNS, přesměrování `www`, firewall a aktuální environment nebyly čteny. Před deployem musí provoz potvrdit kanonický hostname a přesný allowlist.
2. Nginx záměrně přijímá `localhost` a `127.0.0.1` pro healthcheck. Přímé veřejné vystavení interního web portu musí blokovat síťová vrstva; tato podfáze netvrdí ověření produkčního perimetru.
3. Existující tokeny se nemigrují ani nerevokují. Job, PPE a quote toky stále nemají jednotný hash-only/expiry/revoke/one-time model; quote accept/reject souběh zůstává otevřený.
4. Podpis zakázky ani akceptace nabídky dosud nejsou svázány s neměnným snapshotem, PDF hashem a verzí. Nelze proto tvrdit dokončení SEC-14, COMP-02 nebo COMP-07.
5. Veřejná minimalizace odpovědí, retence tokenových metadat a privacy logů zůstávají součástí GDPR-11 a dalších podfází R06.
6. R07 (CSP, dependency/TLS kontrakty a zbývající perimetr) nebylo zahájeno. Statický nginx allowlist zde uzavírá pouze část SEC-18.
7. V pracovním stromu zůstávají souběžné uživatelské redesign soubory a migrace `0100`; nejsou součástí implementačního commitu. Další migrace musí nejprve znovu určit volné číslo podle aktuálního `main`.

## 5. Jednoznačný checkpoint a doporučení

**CHECKPOINT FÁZE 8.10:** SEC-18 je lokálně uzavřen pro tvorbu job/PPE/quote/QR bearer odkazů: žádný z nich nepoužívá request Host, produkční API failuje bez validního kanonického HTTPS originu a nginx má fail-closed default Host server. Změna nemá migraci a nemění existující tokeny. Produkční konfigurace, runtime nginx canary, push ani deploy nebyly provedeny. R06 zůstává otevřené pro token lifecycle a neměnné snapshoty; R07 je rovněž otevřené. V tomto spuštění se nepokračuje do FÁZE 8.11 ani FÁZE 9.

- **další fáze:** FÁZE 8.11 – R06b: jednotný lifecycle veřejných bearer tokenů (hash-only uložení, účel, expirace, revokace, one-time/atomický consume a přechod legacy odkazů). Neměnné job/quote snapshoty rozdělit do následné podfáze, pokud by bezpečný tokenový řez narostl nad rozumný rozsah.
- **doporučený model:** GPT-5.6 Sol
- **doporučený reasoning:** xhigh
- **důvod použití této úrovně:** další řez zasahuje autorizaci, ochranu osobních dat, souběžné accept/reject operace a pravděpodobně migraci živých bearer credentialů. Chybný dual-read/backfill může odkazy nevratně zneplatnit nebo ponechat replay okno.
- **očekávané činnosti:** znovu inventarizovat job/PPE/quote/QR tokenové sloupce a veřejné routy; navrhnout společný nebo doménově oddělený token record s purpose bindingem; ukládat pouze hash, zavést expiry/revoke/one-time conditional update a atomic transition; definovat legacy sunset bez tvrzení zpětné ochrany; přidat negativní, replay, expiry, revoke a paralelní testy; připravit expand/backfill/cutover/rollback runbook. Před vytvořením migrace znovu ověřit aktuální journal a souběžnou `0100`.
- **soubory, které budou pravděpodobně změněny:** schémata `lib/db/src/schema` pro job/PPE/quote nebo nový public-token modul, nová migrace a rollback s číslem určeným až podle aktuálního stromu, token service v `artifacts/api-server/src/lib`, veřejné a administrační routy pro job/PPE/quote, API kontrakty/generované klienty podle zvoleného rozhraní, cílené DB/concurrency testy a nový rollout runbook/checkpoint.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano. Pravděpodobná je expand-only migrace, měřený backfill/hashování legacy tokenů, dual-read/cutover, revokační změny a souběhově citlivé conditional updates. Produkční migrace, práce s reálnými tokeny/secrets, push a deploy nejsou automaticky autorizovány.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**.
