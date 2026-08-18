# FÁZE R14-A – checkpoint

- **Datum:** 2026-08-04.
- **Stav:** **DOKONČENO – REAL-BROWSER PWA IDENTITY/OFFLINE ISOLATION**.
- **Výchozí commit:** `d13e3d72bd00b9a3e4e558c722e0a5abbcbe5e8b`.
- **Bezpečnostní implementace:** `0b941507062a783dab37e898f4f3dbea026fa273`.
- **Exact-SHA ověřený source commit:** `486a13adfce5a64b6cb3f1d7214848a67b386312`.
- **Větev:** `agent/phase14-pwa-isolation`.
- **Draft PR:** [#3](https://github.com/modvolt/Site-Logbook/pull/3), base
  `agent/phase13-staging-workflow-harness`.
- **Produkce:** beze změny.

## Uložené výstupy

- [centrální verifikační registr](14-a-pwa-identity-isolation-verification.md);
- `scripts/run-pwa-isolation-gate.mjs`;
- `e2e/playwright.pwa-isolation.config.ts`;
- `e2e/pwa-isolation/mock-pwa-server.mjs`;
- `e2e/pwa-isolation/offline-identity-and-sw-update.spec.ts`;
- `e2e/tsconfig.pwa-isolation.json`;
- [desktop evidence](evidence/14-a/desktop.png),
  [mobile portrait](evidence/14-a/mobile-portrait.png) a
  [mobile landscape](evidence/14-a/mobile-landscape.png).

## Shrnutí architektury

Soukromý PWA provoz je nyní svázaný se serverem potvrzenou identity epochou od prvního
browser fetch guardu přes API middleware až po ověření response body v service workeru. Login,
logout a invalidace relace synchronně uzamknou soukromý provoz a odstraní query/cache data ve
všech kartách. Offline queue, blob i Cache Storage zůstávají oddělené scope identity; změna na
jiného uživatele je nemůže replayovat.

Rolling mismatch končí fail-closed `409` nebo `428`. Logout při selhání session store revokuje
uživatelskou session generation. SSE zůstává mimo service worker, aby dlouhé spojení neblokovalo
aktualizaci. Externí Google Fonts request byl odstraněn.

## Provedené kontroly

- exact-SHA Edge gate: **5/5 PASS**;
- release gate: **PASS** – 29 script, 130 frontend, 15 live-events a 325 API testů;
- quality gate: **PASS**;
- kompletní lokální API/Postgres matice: **142/142 souborů PASS**, každý ve vlastní disposable DB;
- GitHub Quality gate: **PASS** – [run 30880262322](https://github.com/modvolt/Site-Logbook/actions/runs/30880262322)
  na exact head `486a13a…`, včetně izolovaných DB sad a encrypted streaming recovery drillu;
- Docker amd64 web/API + nový PostgreSQL 16: **PASS**;
- 102/102 migrací, latest `0102`, migrační parity `true`; `0100` není přítomná;
- skutečný setup/scope/private request/logout kontrakt přes nginx a Postgres: **PASS**;
- browser origin, E2E server, Docker kontejnery a síť: **uklizeno**;
- implementační větev zveřejněna a draft PR #3 otevřen; **bez merge/deploye**.

První GitHub běh `30878225469` odhalil pouze nesoulad starších SuperTest agentů s novým
identity-scope a idempotency kontraktem. Oprava v `486a13a…` je omezena na testovací helper a
dotčené DB sady; produkční vynucení nebylo obcházeno ani oslabeno.

## Nejasnosti a zbytkové riziko

- browser gate používá deterministický mock API; reálný API/Postgres kontrakt byl ověřen
  samostatným Docker smoke, ne plným browser testem proti DB;
- Docker loopback HTTP vyžadoval `NODE_ENV=development`, protože production runtime oprávněně
  vyžaduje HTTPS public origin;
- S3, SMTP/IMAP/AI a restore fault injection nejsou součástí R14-A;
- gate ještě není povinná v GitHub Actions;
- v mobilním landscape update prompt překrývá část pracovní karty, ne však bezpečnostní stavy;
- merge draft PR #1, #2 nebo #3, GHCR publikace a staging/production deploy zůstávají neschválené.

## Jednoznačný checkpoint

FÁZE R14-A zde končí. Produkční Site Logbook, Coolify, Hetzner S3, DNS, produkční DB a secrets
zůstaly beze změny. Tento checkpoint neautorizuje merge, GHCR write, workflow dispatch, staging
deploy, produkční deploy, restore produkčních dat, backfill ani migraci `0100`.

Lokální disposable databáze a všechny R14 kontejnery byly odstraněny; zachovány jsou pouze dva
lokální image tagy `site-logbook-r14-api:0b94150` a `site-logbook-r14-web:0b94150` pro případnou
reprodukci.

## Doporučení pro další spuštění

- **další fáze:** FÁZE R14-B – povinný izolovaný CI full-stack/fault gate;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** fáze propojí GitHub Actions, disposable databázi, browser,
  migrační/restore lifecycle, provider fakes a spolehlivý teardown; falešně zelený gate nebo únik
  secretu by znehodnotil release ochranu;
- **očekávané činnosti:** přenést R14-A exact-SHA browser gate na Linux CI, přidat ephemeral
  PostgreSQL, deterministický seed a authorization matrix, izolovaný S3 adapter fake bez
  produkčního bucketu, SMTP/IMAP/AI fakes, migration/restore a fault-injection jobs, ověřit
  fail-closed egress a teardown a zapsat exact GitHub run evidence;
- **soubory, které budou pravděpodobně změněny:** `.github/workflows/quality-gate.yml`, nové
  `e2e/playwright.r14-full-stack.config.ts`, `e2e/r14-full-stack/*`, `scripts/run-r14-ci-gate.mjs`,
  případné test-only soubory pod `deploy/test/`, kořenový `package.json` a
  `docs/audit/14-b-*`;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** nesmí vytvořit ani měnit
  produkční migraci, zejména `0100`, ani používat produkční DB/S3/secrets. Smí aplikovat již
  committed migrace a destruktivní restore/fault testy pouze do disposable CI prostředí. Změna
  GitHub workflow je release-procesní riziko a musí být nejprve draft PR, exact-SHA run a
  fail-closed review; žádný merge nebo deploy bez nového výslovného souhlasu.

Před pokračováním uprav doporučený model/reasoning v rozhraní a výslovně napiš
`Pokračuj další fází`.
