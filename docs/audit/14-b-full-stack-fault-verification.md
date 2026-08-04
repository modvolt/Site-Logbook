# FÁZE R14-B – full-stack a fault verification

- **Datum:** 2026-08-04.
- **Verdikt:** **PASS – POVINNÝ IZOLOVANÝ CI FULL-STACK/FAULT GATE**.
- **Implementační větev:** `agent/phase14b-full-stack-fault-gate`.
- **Ověřený head větve:** `98585a8e39a8c30dd2332d17b6d6808a84588b81`.
- **Ověřený pull-request merge SHA:** `41618d82b624d7956a7d328c85307ba5d4e79803`.
- **Draft PR:** [#4](https://github.com/modvolt/Site-Logbook/pull/4), base
  `agent/phase14-pwa-isolation`.
- **GitHub důkaz:** [Quality gate 30893394249](https://github.com/modvolt/Site-Logbook/actions/runs/30893394249),
  `success`, 17/17 povinných kroků a úklid.
- **Produkce / Coolify / Hetzner S3 / GHCR / DNS:** beze změny.
- **Migrace `0100_user_ui_preferences.sql`:** nepřítomná, nepřidaná a nespouštěná.

## Centrální registr výsledků

| Oblast | Výsledek | Důkaz |
|---|---:|---|
| Exact-source provenance | PASS | runner odmítá nečistý strom a vyžaduje shodu `R14_SOURCE_SHA` s checkoutem; CI ověřil merge SHA `41618d8…` |
| Povinný workflow krok | PASS | `R14 isolated full-stack and fault gate` je součástí `quality-gate.yml` bez `continue-on-error` |
| Síťová izolace | PASS | pouze nginx web publikuje `127.0.0.1:4194`; API, PostgreSQL, MinIO a provider fakes jsou jen v interní Docker síti |
| Disposable stav | PASS | PostgreSQL a MinIO používají `tmpfs`; stack nevytváří persistentní volume |
| Neměnné obrazy | PASS | veřejné obrazy jsou digest-pinned; API a web nesou přesný testovaný source SHA a `pull_policy: never` |
| Release a quality gate | PASS | 35 script/contract, 130 frontend, 15 live-events a 349 API unit testů; typecheck, build, lint, peers a dependency audit |
| Izolované API/DB sady | PASS | samostatný CI krok dokončil celou disposable PostgreSQL matici |
| Migrace | PASS | 102 committed migrací, poslední `0102`, parity `true`; `0100` neexistuje |
| Real-browser full stack | PASS | Chromium 5/5: deep health, provider happy path, DB/S3 data path, guest denial a PWA service worker |
| Autorizace | PASS | guest dostal `403` pro admin diagnostiku i vytvoření zakázky přes API a skutečný browser kontext |
| PostgreSQL + S3 data path | PASS | syntetická zakázka, privátní objekt, attachment a SHA-256 download prošly přes nginx, API, PostgreSQL a MinIO |
| PostgreSQL dump/restore | PASS | custom-format stream byl obnoven do nové DB; počet migrací i marker zakázka se shodovaly |
| SMTP/IMAP/AI happy path | PASS | deterministické in-network služby přijaly SMTP, IMAP spojení a AI test bez externího provozu |
| Provider faults | PASS | SMTP fail, IMAP fail, AI HTTP 500 a AI timeout skončily očekávanou chybou a následnou obnovou |
| S3 fault/recovery | PASS | při síťovém odpojení storage hlásil chybu, upload nevrátil falešný úspěch, po připojení zůstal marker objekt zachovaný |
| PostgreSQL fault/recovery | PASS | readiness při odpojení vrátil `503 degraded` za méně než 5 s; po připojení `200 ok` a marker zakázka zůstala zachovaná |
| Úklid | PASS | workflow potvrdil odstranění project-scoped kontejnerů, sítí a volume a uzavření loopback portu |

## Implementovaná architektura gate

`scripts/run-r14-full-stack-gate.mjs` vytváří project-scoped stack odvozený z přesného source SHA.
Nejdříve sestaví API a PWA obrazy, spustí digest-pinned PostgreSQL 16, MinIO a jediný
deterministický SMTP/IMAP/AI provider proces a teprve poté zpřístupní nginx na loopbacku. Všechny
credential hodnoty jsou syntetické a omezené na disposable stack.

Browser acceptance používá skutečný Chromium a dodanou PWA. Ověřuje serverem potvrzený offline
scope, idempotency klíče, privátní object-storage tok, serverovou autorizaci, registraci service
workeru a nulový non-loopback browser provoz. Následná nebrowserová část používá čerstvou admin
session a provádí provider faults, dump/restore a síťové odpojení stateful služeb.

Výpadek MinIO/PostgreSQL je simulován odpojením kontejneru od interní sítě, nikoli restartem. Tím
zůstává `tmpfs` stav zachovaný a test skutečně dokazuje recovery existujících dat. Runner zapisuje
dílčí evidence po každém logickém celku a v `finally` vždy provede project-scoped teardown a
negativní kontrolu zbylých resources a portů.

## Test-only provider hranice

Pro hermetický test byly přidány tři explicitní hranice:

- `OPENAI_TEST_BASE_URL` smí přesměrovat SDK jen při `NODE_ENV=test`;
- `MAIL_TEST_ALLOW_INSECURE` smí povolit syntetický plaintext SMTP/IMAP jen při `NODE_ENV=test`;
- `S3_TEST_REQUEST_TIMEOUT_MS` smí zkrátit AWS SDK request timeout jen při `NODE_ENV=test`.

Každá hranice je fail-closed mimo test a má vlastní contract test. Produkční OpenAI endpoint,
transportní ochrana mailu ani běžný S3 timeout se tím nemění.

## Readiness nález odhalený čistým runnerem

Fault gate našel produkčně relevantní dostupnostní mezeru: `/api/healthz` měl pětisekundový Docker
deadline, ale během nedostupné DB mohl čekat na neomezený pool dotaz. Oprava nepřidala globální
timeout běžným transakcím. Health probe nyní:

1. otevře krátce žijící izolované PostgreSQL spojení s celkovým limitem 3 s;
2. při chybě okamžitě vrátí `503`, aniž spustí DB-závislou migrační nebo SMTP diagnostiku;
3. při dalším requestu použije nové spojení, takže obnovení sítě není blokováno starým socketem;
4. je v acceptance runneru odmítnut, pokud odpověď trvá 5 s nebo déle.

Tím se nemění timeouty aplikačního poolu ani doménových operací. Cena je jedno krátké DB spojení na
readiness request, tedy při současném 30s Docker intervalu zanedbatelná, ale před případným velkým
horizontálním škálováním má být počet probe spojení součástí capacity metrik R15.

## Iterační CI důkaz

| Run | Výsledek a zjištění | Náprava |
|---|---|---|
| `30888331118` | restart MinIO správně ukázal ztrátu `tmpfs` bucketu | fault změněn na síťové odpojení se zachováním stavu |
| `30889122144` | opakování potvrdilo, že storage recovery není polling race | zachován přísný marker invariant |
| `30890065751` | storage data zůstala, ale AWS SDK request přesáhl test deadline | přidán fail-closed test-only S3 request timeout |
| `30891062586` | S3 fault i marker prošly; `/healthz` visel při výpadku PostgreSQL | izolovaný bounded DB readiness probe |
| `30892381155` | samotný DB ping byl bounded, ale expirovaná migration cache spustila druhý DB dotaz | DB se stal prerequisite a sekundární diagnostika se při výpadku nespouští |
| `30893316507` | superseded commit | běh zrušen; žádný výsledek použit jako důkaz |
| `30893394249` | **PASS** na head `98585a8…`; všechny kroky včetně fault gate a cleanup | finální důkaz R14-B |

Žádná iterace neoslabovala očekávané chyby ani nevynechala fault scénář; gate byl opravován podle
skutečného stavu a závěrečný běh obsahuje nejpřísnější variantu.

## Lokální ověření a jeho hranice

- `pnpm gate:release`: **PASS** – 35 script/contract, 130 frontend, 15 live-events a 349 API unit
  testů, všechny typechecky a API/PWA build;
- `pnpm gate:quality`: **PASS** – ESLint bez varování, peers bez problému a bez známé dependency
  zranitelnosti;
- lokální Docker Desktop před pozdějším zamrznutím engine opakovaně dokončil browser 5/5,
  provider faults a dump/restore;
- úplná stateful fault/recovery sekvence je proto opřena o čistý Linux `amd64` GitHub runner,
  nikoli o tvrzení, že později nereagující lokální Docker dokončil poslední běh;
- lokální Docker procesy nebyly násilně ukončovány a engine nebyl kvůli auditu dále restartován.

## Negativní důkazy a zbytková rizika

- žádný kontakt s `modvoltapp.cz`, Coolify, produkční DB, Hetzner S3 nebo produkčními secrets;
- žádný merge, deploy, workflow dispatch, GHCR publish, DNS zásah, restore produkčních dat ani
  produkční migrace;
- MinIO je výhradně disposable S3-kompatibilní test provider; neznamená změnu rozhodnutí používat
  v produkci Hetzner S3;
- gate ověřuje Linux `amd64`, ne ARM, v souladu s cílovou architekturou;
- PR je stacked draft a jeho zelený stav není souhlas s merge či produkčním rolloutem;
- GitHub anotuje, že použité `actions/*@v4` běží po deprecaci Node 20 v forced Node 24 režimu;
  nyní prochází, ale upgrade actions patří do samostatné supply-chain údržby;
- detailní JSON evidence je vytvářena a kontrolována během jobu, ale není publikována jako trvalý
  GitHub artifact; trvalým záznamem je tento registr, kód invariantů a immutable run log;
- reálný TLS staging, Hetzner S3 a produkční capacity nejsou součástí R14-B.
