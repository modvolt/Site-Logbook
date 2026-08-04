# FÁZE R15-A – provozní signály a alert policy

- **Datum:** 2026-08-04.
- **Implementační větev:** `agent/phase15a-operational-signals`.
- **Ověřený implementační head:** `3393ce9f54bf5459a394f0ddea7683efcbdc1f1d`.
- **Ověřený PR merge SHA:** `d35995ea8bae2081eccaf87e6cbf9a9fbf1d7485`.
- **Stacked base:** `agent/phase14b-full-stack-fault-gate` na
  `44ab120a4554b855f36c1be0119530919657662b`.
- **Draft PR:** [#5](https://github.com/modvolt/Site-Logbook/pull/5).
- **GitHub quality gate:** **PASS** –
  [run 30897935771](https://github.com/modvolt/Site-Logbook/actions/runs/30897935771), všechny povinné
  kroky včetně izolovaných DB sad, recovery drillu, browser/fault gate a teardownu.
- **Produkce / Coolify / Hetzner S3 / GHCR / DNS / secrets:** beze změny.
- **Migrace:** žádná; `0100_user_ui_preferences.sql` nebyla přidána ani spuštěna.

## Centrální registr výsledků

| Oblast | Výsledek | Důkaz |
| --- | ---: | --- |
| Izolace změny | PASS | samostatná stacked větev a draft PR #5, bez merge nebo deploy kroku |
| Redakce | PASS | alert sink přenáší jen stabilní kód, fingerprint, závažnost, vlastníka, runbook, metriku a číselné hodnoty |
| Bezpečný snapshot | PASS | `GET /api/admin/health/operational` čte jen PostgreSQL agregace; nespouští S3 write/delete ani provider test |
| Autorizace | PASS | endpoint vyžaduje session a `diagnostics.view`; contract i izolované PostgreSQL integrační 401/403/admin testy prošly |
| Fronty | PASS | extraction, switchboard a e-mail import mají hloubku, stav běhu/chyb a stáří nejstarší způsobilé položky |
| Zálohy a restore | PASS | freshness poslední úspěšné zálohy, poslední pokus a poslední evidovaný restore test |
| Security agregace | PASS, částečné pokrytí | 15minutový počet auditních změn uživatelů, sessions, WebAuthn, vault step-up a emergency security akcí |
| Alert policy | PASS | warning/critical limity, stabilní fingerprinty, triggered/escalated/deescalated/recovered a deduplikace beze změny |
| Neznámý stav | PASS | nedostupné DB metriky jsou explicitně `unknown`, nikdy falešná zdravá nula |
| Scheduler scaling | PASS s omezením | watchdog a purge mají unikátní PostgreSQL advisory lock; DB outage zůstává viditelný i bez lock authority |
| Externí transport | ZÁMĚRNĚ NEAKTIVNÍ | `alertTransport=local_log_only`; žádný webhook, pager nebo nový secret |
| Admin UI | PASS | úzké rozšíření stávající diagnostiky, loading/error stavy, 30s a ruční refresh; Impeccable detector `[]` |
| OpenAPI/codegen | PASS | endpoint, watchdog stav a snapshot schémata jsou v OpenAPI i vygenerovaných Zod/React klientech; manifest má 403 routes |
| Produkční migrace | PASS – negativní důkaz | v diffu není migration soubor ani změna journalu/snapshotu |
| GitHub full-stack/fault gate | PASS | run 30897935771 dokončil isolated DB suites, encrypted MinIO recovery, real-browser/fault scénáře a úplný teardown |

## Architektura

`operational-signals.ts` provádí pouze agregované čtení existujících tabulek. Výsledek předá čisté
funkci v `operational-alert-policy.ts`, která normalizuje limity, vyhodnotí stav a sestaví stabilní
redigované alerty. Per-process tracker publikuje pouze změny stavu do lokálního strukturovaného logu.
Žádný síťový alert transport v R15-A neexistuje.

Watchdog nejprve použije třísekundový izolovaný DB readiness probe. Je-li DB dostupná, běží pod
unikátním advisory lockem a načte agregace. Při DB výpadku lock authority neexistuje, proto watchdog
záměrně zapíše lokální `unknown/error` signál i bez locku; u více replik může vzniknout duplicitní log,
ale výpadek se nezamlčí. Purge používá vlastní lock.

Admin endpoint je oddělený od historického deep-health endpointu. Nový endpoint nesahá na storage,
SMTP ani AI provider a nevrací raw chyby. UI ho zobrazuje ve stávající admin diagnostice bez změny
navigace nebo produkčních workflow.

## Výchozí limity

- stáří položky fronty: warning 15 minut, critical 60 minut;
- trvalé chyby fronty: warning od jedné, critical od pěti;
- poslední úspěšná záloha: warning 26 hodin, critical 48 hodin;
- ověřovací restore: warning 8 dnů, critical 14 dnů;
- citlivé auditní změny za 15 minut: warning 10, critical 25.

Každý limit je konfigurovatelný samostatnou `OPERATIONAL_*` env hodnotou. Neplatné nebo obrácené
hodnoty jsou normalizované na bezpečné pořadí; konfigurace sama nezapíná externí transport.

## Lokální ověření

- `pnpm run gate:release`: **PASS** – typecheck, 35 script/contract testů, 130 frontend testů,
  15 live-events testů, 362 API unit testů a API/PWA build;
- `pnpm run gate:quality`: **PASS** – ESLint bez varování, peer kontrola a dependency audit bez
  známé zranitelnosti na nastavené úrovni;
- `git diff --check`: **PASS**;
- Impeccable detector nad `admin-health.tsx`: **PASS**, výsledek `[]`;
- OpenAPI codegen a deterministický API route manifest: **PASS**.

První opakování release gate v omezeném Windows sandboxu skončilo před testy chybou přístupu
esbuildu ke konfiguraci. Stejný příkaz mimo toto omezení dokončil celý gate úspěšně; nešlo o
aplikační ani testovací selhání.

## Docker a PostgreSQL

Docker Compose `v5.2.0` je nainstalovaný, ale lokální Docker engine neodpověděl na bezpečné
`docker version`/`docker ps` ani do 34 sekund. Procesy ani kontejnery nebyly násilně zastaveny a
Docker nebyl kvůli auditu restartován.

Lokální služba PostgreSQL 18 běží na `127.0.0.1:5432`, ale bezpečný pokus bez hesla skončil
`fe_sendauth: no password supplied`. Produkční ani uložené secrets nebyly čteny nebo kopírovány.
DB integrační test nového endpointu proto musí dodat izolovaný GitHub PostgreSQL job; lokální důkaz
ho nenahrazuje.

## Nejasnosti a zbytková rizika

- security metrika nepokrývá všechny login success/failure, logout, rate-limit a WebAuthn auth
  události, protože současný audit log je úplně neeviduje;
- tracker a deduplikace jsou per-process a po restartu se resetují;
- při změně lock-winning repliky může vzniknout opakovaný transition event;
- lokální log není alert kanál nezávislý na aplikačním procesu ani PostgreSQL;
- snapshot neprovádí provider probe a jeho stav providera je proto jen watchdogový nebo `unknown`;
- backup trigger má stávající potenciální závod před získáním vlastního scheduler locku; R15-A jej
  nemění, protože by šlo o oddělenou behaviorální opravu;
- reálný TLS staging, Hetzner S3 a produkční capacity nebyly v R15-A testovány.

## Negativní důkazy

- žádný kontakt s `modvoltapp.cz`, Coolify, produkční DB, Hetzner S3 nebo produkčními secrets;
- žádný merge, deploy, GHCR publish, DNS zásah, restore, backfill nebo migrace;
- žádný externí alert recipient, webhook URL nebo provider secret v kódu, logu ani dokumentaci;
- PR #5 je draft a jeho zelený stav nebude souhlas s merge ani rolloutem.
