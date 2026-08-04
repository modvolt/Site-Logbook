# FÁZE R14-A – PWA identity a offline isolation verification

- **Datum:** 2026-08-04.
- **Verdikt:** **PASS – EXACT-SHA REAL-BROWSER A LOKÁLNÍ DOCKER/POSTGRES DŮKAZ**.
- **Výchozí commit:** `d13e3d72bd00b9a3e4e558c722e0a5abbcbe5e8b`.
- **Přesně testovaný implementační commit:** `0b941507062a783dab37e898f4f3dbea026fa273`.
- **Větev:** `agent/phase14-pwa-isolation`.
- **Draft PR:** [#3](https://github.com/modvolt/Site-Logbook/pull/3), base
  `agent/phase13-staging-workflow-harness`.
- **Produkce / Coolify / Hetzner S3 / GHCR:** beze změny.
- **Migrace `0100`:** nepřítomná, nepřidaná a nespouštěná.

## Centrální registr výsledků

| Oblast | Výsledek | Důkaz |
|---|---:|---|
| Exact-SHA PWA gate | PASS | Edge `151.0.4129.59`, 5/5 scénářů, source SHA `0b941507…` |
| Dva taby / jediný executor | PASS | 1 request, 1 ledger záznam, 1 efekt |
| Ztracená odpověď po commitu | PASS | 2 pokusy, 1 replay, 1 ledger záznam, 1 efekt, stejný klíč |
| Přepnutí Alice → Bob | PASS | 1 Alice operace a 1 blob zůstaly uzamčené; Bob je 0× replayoval |
| Service-worker update | PASS | skutečný přechod `R14_SW_V1` → `R14_SW_V2` ve dvou kartách |
| Rolling kompatibilita | PASS | mismatch `409`, chybějící scope `428`, cizí response body nedoručeno |
| Automatická invalidace relace | PASS | po startu Bob loginu bylo zobrazeno 0 Alice markerů |
| Diagnostika prohlížeče | PASS | 0 neočekávaných console/page/network chyb, 0 non-loopback requestů |
| Release gate | PASS | 29 script, 130 frontend, 15 live-events a 323 API testů |
| Quality gate | PASS | ESLint bez varování, peers bez problému, audit bez známé zranitelnosti |
| Docker/Postgres smoke | PASS | oba amd64 obrazy zdravé; PostgreSQL 16; 102 migrací; parity `true` |
| Úklid | PASS | browser storage prázdné; E2E server zavřen; 0 R14 kontejnerů a sítí |

## Implementovaná architektura

### 1. Serverem potvrzená identita

`/api/auth/me` vrací neprůhledný 64hex `offlineScope`, odvozený z uživatele,
`sessionGeneration`, role a efektivních oprávnění. Neobsahuje heslo, cookie ani přímo použitelné
uživatelské údaje.

Klient instaluje před mountem Reactu společný fetch guard. Soukromý same-origin API request:

1. nesmí odejít, dokud není identita ověřena;
2. nese `X-Stavba-Offline-Scope`;
3. při `409 offline_scope_mismatch` nebo `428 identity_scope_required` okamžitě přejde do
   fail-closed stavu a vyvolá nové ověření `/api/auth/me`.

Backend vyžaduje scope na běžném soukromém API provozu i offline replay. Veřejné endpointy mají
explicitní method/path allowlist. Dvě technické výjimky nejsou součástí runtime cache:

- `/api/events`, protože SSE přenáší pouze invalidation topics a jeho dlouhé spojení nesmí držet
  starý service worker aktivní;
- nativní browser resource GET/HEAD s neprázdným `Sec-Fetch-Dest`, protože HTML prvky neumějí
  nastavit vlastní hlavičku.

### 2. Ochrana response body a cache

Autentizované GET odpovědi nesou stejný serverový scope. Service worker kontroluje scope ještě
před předáním response body kartě a před uložením do Cache Storage. Chybějící nebo odlišná
hlavička vytvoří syntetický `428`/`409`, origin-wide API cache se smaže a klient dostane
`AUTH_SCOPE_MISMATCH` bez cizího těla odpovědi.

Pouze explicitní field-read allowlist používá `NetworkFirst`. Ostatní `/api/*` requesty zůstávají
network-only, ale jsou rovněž svázané se scope. Cache namespace obsahuje scope identity epochy.

### 3. Atomická změna identity mezi kartami

Login, logout, zneplatnění relace a zpráva service workeru používají společný dvoustupňový
`changing`/`changed` protokol přes BroadcastChannel a storage event fallback. Události mají
`transitionId`, čas a pořadový guard. Před prvním `await` se:

- zablokuje soukromý fetch;
- publikuje signed-out auth snapshot;
- odstraní ostatní React Query data;
- zahájí zrušení in-flight queries a vyčištění API cache.

Logout na backendu nevrátí falešný úspěch při poruše session store. Když zničení relace selže,
zvýší se `sessionGeneration` uživatele; pokud selže i revokace, request skončí chybou.

### 4. Aktualizace service workeru a síťový původ

Aktualizační tlačítko po Workbox update znovu osloví skutečný `registration.waiting` worker
zprávou `SKIP_WAITING`. Externí Google Fonts odkazy byly odstraněny; aplikace už obsahovala
lokální Roboto soubory. Impeccable detector pro dotčenou login/app-shell plochu vrátil `[]`.

## Exact-SHA real-browser důkaz

Příkaz:

```text
R14_SOURCE_SHA=0b941507062a783dab37e898f4f3dbea026fa273 pnpm test:e2e:pwa-isolation
```

Gate nejprve vyžaduje čistý implementační strom a shodu proměnné s `git HEAD`, potom sestaví PWA
se stejným SHA, spustí E2E typecheck a reálný Microsoft Edge. Browser host resolver i Playwright
route povolují pouze přesný origin `http://127.0.0.1:<port>`.

Výsledky scénářů:

- **dva taby:** současné flush signály vytvořily 1 request, 1 ledger záznam a 1 efekt;
- **response loss:** první request commitnul efekt a ztratil odpověď, retry použil stejný klíč;
  celkem 2 pokusy, 1 replay a 1 efekt;
- **Alice → Bob + SW update:** Alice operace i blob zůstaly lokálně uzamčené, Bob je neposlal,
  jediná managed cache patřila Bob scope a obě karty přešly na V2;
- **rolling verze:** odlišný response scope skončil `409` bez Bob markeru; nový SW proti starému
  API i starý klient proti novému API skončily `428`;
- **automatická invalidace:** od začátku Bob loginu nebyl v DOM zachycen žádný Alice marker.

Všech sedm diagnostických profilů má prázdné `consoleProblems`, `pageErrors`,
`unexpectedFailures` a `nonLoopbackRequests`. Po každém scénáři byly odstraněny registrace,
Cache Storage, IndexedDB, localStorage i sessionStorage. Test server na portu nezůstal.

## Vizuální důkazy

- [desktop 1440×900](evidence/14-a/desktop.png), SHA-256
  `3287e59430b88639de1c3d01b9fedcc37964be2cd21829abaec9723b930e9e62`;
- [mobilní portrét 390×844](evidence/14-a/mobile-portrait.png), SHA-256
  `d22b8c6ab524db0fa77a4de97d7899e559dfda0754ffa6cce25b3c8f6f9bfbc9`;
- [mobilní landscape 844×390](evidence/14-a/mobile-landscape.png), SHA-256
  `2c680034c4e22d98ed682f8ea5c92a9fced5d7ac71b694c6e7b59aeba7272d40`.

Ve všech viewports jsou viditelné offline, identity-lock a update stavy a nevzniká horizontální
overflow. V nízkém landscape okně update dialog překrývá část pracovní karty, ale nikoli
bezpečnostní stavy ani vlastní ovládání; je to neblokující UX omezení pro budoucí polish.

## Release a quality kontroly

- `pnpm gate:release`: **PASS**;
  - TypeScript všech pracovních balíků;
  - 29/29 hermetických script testů;
  - 10 frontend souborů, 130/130 testů;
  - 1 live-events soubor, 15/15 testů;
  - 46 API souborů, 323/323 unit testů;
  - API a PWA production build.
- `pnpm gate:quality`: **PASS**;
  - ESLint `--max-warnings=0`;
  - žádný peer dependency problém;
  - žádná známá zranitelnost od úrovně moderate.
- `git diff --check`: **PASS**.

Build hlásí již známé varování pro několik chunků nad 500 kB. Není to regresní bezpečnostní
chyba R14-A; code-splitting zůstává samostatnou výkonovou prací.

## Lokální Docker + PostgreSQL smoke

Test proběhl na Docker Desktop `29.6.1`, engine `linux/x86_64`, Compose `5.2.0`.

| Artefakt | Hodnota |
|---|---|
| API image | `site-logbook-r14-api:0b94150`, amd64, ID `sha256:12d70ef6…27ee` |
| Web image | `site-logbook-r14-web:0b94150`, amd64, ID `sha256:c908d955…faf8` |
| OCI revision obou images | `0b941507062a783dab37e898f4f3dbea026fa273` |
| PostgreSQL | digest-pinned `postgres:16-alpine`, pouze `127.0.0.1:55432` |
| Web | pouze `127.0.0.1:18081`, root `200`, health `ok` |
| Databáze | 102 migration ledger rows, 97 public tables, `migrationParity: true` |

První production-mode start správně odmítl loopback `PUBLIC_APP_URL` přes HTTP až po úspěšném
aplikování migrací: production vyžaduje HTTPS. Pro lokální HTTP smoke byl stejný sestavený image
znovu spuštěn s `NODE_ENV=development`; tato výjimka nezměnila image ani repozitář.

S3 nebylo nakonfigurováno podle rozhodnutí nepoužívat lokální MinIO. Backup scheduler proto zůstal
vypnutý a storage `ok` v development fallbacku **není** důkaz Hetzner S3. SMTP bylo
`not_configured`.

Skutečný nginx → API → PostgreSQL tok potvrdil:

- první admin setup `201` a následnou autentizaci;
- 64hex `offlineScope` a shodu response headeru s tělem `/auth/me`;
- soukromý GET bez scope `428`;
- stejný GET se správným scope `200`;
- veřejný login `200`, logout `204` a následné `authenticated: false`.

Po smoke testu byly přesně pojmenované web/API/Postgres kontejnery a síť odstraněny. Testovací DB
byla pouze v kontejnerovém filesystemu a byla zahozena. Pro reprodukci zůstaly jen dva lokální,
nepublikované image tagy; nevznikl volume ani běžící služba.

## Negativní důkazy a hranice

- žádný kontakt s `modvoltapp.cz`, Coolify, produkční DB, Hetzner S3 nebo produkčními secrets;
- žádný GHCR push/pull/delete, workflow dispatch, deploy, DNS zásah nebo merge;
- žádná migrace nebyla vytvořena; `0100` není v adresáři ani journalu;
- draft PR #3 je stacked na integrační větvi, nikoli na `main`;
- Docker smoke použil syntetické lokální credentials a prázdnou disposable DB;
- browser gate používá deterministický mock server; Docker smoke ověřil reálný API/Postgres
  kontrakt, nikoli celý browser UI proti Postgresu;
- lokální Docker HTTP režim není produkční TLS/staging důkaz.

## Zbývající nejasnosti

- R14-A gate zatím není povinným jobem v GitHub Actions;
- celý R14 ještě neobsahuje jednotný CI teardown pro Postgres, S3 adapter fake, SMTP/IMAP/AI fake,
  restore drill a authorization matrix;
- skutečný staging rolling deploy a TLS browser ověření patří za samostatný explicitní gate;
- nízký landscape update dialog může být v redesignu posunut tak, aby nepřekrýval pracovní kartu;
- privátní GHCR publikace a merge PR #1/#2/#3 zůstávají mimo autorizaci této fáze.
