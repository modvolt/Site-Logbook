# FÁZE R14-B – checkpoint

- **Datum:** 2026-08-04.
- **Stav:** **DOKONČENO – IZOLOVANÝ FULL-STACK/FAULT GATE**.
- **Head větve:** `98585a8e39a8c30dd2332d17b6d6808a84588b81`.
- **Větev:** `agent/phase14b-full-stack-fault-gate`.
- **Draft PR:** [#4](https://github.com/modvolt/Site-Logbook/pull/4).
- **Exact CI důkaz:** [run 30893394249](https://github.com/modvolt/Site-Logbook/actions/runs/30893394249),
  **PASS**.
- **Produkce:** beze změny.

## Uložené výstupy

- [centrální verifikační registr](14-b-full-stack-fault-verification.md);
- `deploy/test/r14/docker-compose.yml` a `deploy/test/r14/provider-fakes.mjs`;
- `scripts/run-r14-full-stack-gate.mjs` a jeho contract test;
- `e2e/playwright.r14-full-stack.config.ts` a `e2e/r14-full-stack/*`;
- povinný R14 krok v `.github/workflows/quality-gate.yml`;
- fail-closed test-only OpenAI, mail a S3 timeout hranice;
- izolovaný bounded PostgreSQL readiness probe a regresní contract testy.

## Shrnutí architektury

Quality gate nyní sestaví a po každém běhu zruší celý disposable stack: PostgreSQL 16, MinIO,
deterministické SMTP/IMAP/AI služby, API, nginx a skutečný Chromium. Pouze web je dostupný na
loopbacku; stavové služby a API nejsou publikované hostu a nemají externí egress. Veřejné obrazy
jsou připnuté digestem, aplikační obrazy přesným source SHA a veškerý stav je v `tmpfs`.

Gate prokazuje 102 migrací, autorizaci guest/admin, skutečný API–DB–S3 tok, PWA service worker,
provider failure/recovery, PostgreSQL dump/restore, zachování markerů při S3 i DB výpadku a úplný
teardown. Readiness při nedostupné DB nyní vrátí `503` pod pětisekundovým platformním limitem,
aniž mění timeouty běžných databázových operací.

## Provedené kontroly

- lokální release gate: **PASS** – 35 script/contract, 130 frontend, 15 live-events, 349 API unit;
- lokální quality gate: **PASS**;
- R14 contract: **6/6 PASS**;
- GitHub isolated API DB suites: **PASS**;
- GitHub encrypted MinIO recovery drill: **PASS**;
- GitHub real-browser acceptance: **5/5 PASS**;
- GitHub provider, S3 a PostgreSQL fault/recovery: **PASS**;
- GitHub project cleanup a stop containers: **PASS**;
- migrace `0100_user_ui_preferences.sql`: **není přítomná**.

## Nálezy opravené během fáze

Čistý runner odhalil rozdíl mezi restartem disposable `tmpfs` služby a skutečným síťovým výpadkem,
neomezený testovací S3 request a dvě paralelní DB-závislé cesty v readiness endpointu. Opravy
zachovaly data během faultu, přidaly jen test-only S3 hranici a oddělily produkční readiness DB
probe od běžného poolu. Žádná očekávaná chyba nebyla změněna na falešný úspěch.

## Nejasnosti a zbytkové riziko

- lokální Docker Desktop po dílčích úspěšných bězích přestal odpovídat; úplný fault důkaz proto
  poskytuje čistý GitHub Linux `amd64` runner;
- nebyl testován reálný TLS staging ani Hetzner S3;
- detailní JSON evidence se zatím neukládá jako dlouhodobý GitHub artifact;
- workflow má neblokující anotaci k `actions/*@v4` a deprecaci Node 20 runtime;
- draft PR #4 ani jeho stacked rodiče nejsou mergnuté a produkce stále běží na dosavadní revizi.

## Jednoznačný checkpoint

FÁZE R14-B a tím celý workstream R14 zde končí. Produkční Site Logbook, Coolify, Hetzner S3, DNS,
GHCR, produkční databáze a secrets zůstaly beze změny. Tento checkpoint neautorizuje merge PR #4,
merge jeho rodičů, deploy, produkční restore, backfill ani jakoukoli migraci, zejména `0100`.

Draft PR #4 zůstává záměrně otevřený a izolovaný. Další práce nesmí automaticky pokračovat do R15,
dokud uživatel neupraví doporučené nastavení v rozhraní a výslovně nenapíše
`Pokračuj další fází`.

## Doporučení pro další spuštění

- **další fáze:** FÁZE R15-A – provozní SLI/SLO, fronty a nezávislý alerting kontrakt;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** fáze propojí zálohy, storage, mail, AI, importy, schedulery,
  security události a incidentní deduplikaci; špatně navržený alert může mlčet při společném
  výpadku, uniknout citlivá data nebo vytvořit alert storm;
- **očekávané činnosti:** zmapovat všechny existující fronty a periodické workery, definovat
  měřitelné SLI/SLO a stale/depth limity, oddělit readiness od deep diagnostics, navrhnout
  nezávislý alert transport, přidat redigované metriky, deduplikaci/cooldown a hermetické fault
  testy; začít kontrakty a testy bez kontaktu s produkčními providery;
- **soubory, které budou pravděpodobně změněny:** `artifacts/api-server/src/lib/health-watchdog.ts`,
  `artifacts/api-server/src/routes/health.ts`, scheduler/import/backup/outbox moduly,
  `lib/api-zod/*`, nové testy pod `artifacts/api-server/test/`, případně `.github/workflows/*` a
  `docs/audit/15-a-*`;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** R15-A má být nejprve bez
  produkční migrace a bez aktivace externího alert kanálu. Pozdější durable incident/metric stav
  může vyžadovat novou expand-only migraci (nikoli `0100`) a alert provider secret; takový krok je
  rizikový, musí být oddělený draft PR a nesmí být nasazen bez nového výslovného souhlasu.
