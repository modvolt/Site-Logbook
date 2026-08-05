# FÁZE R15-D – checkpoint

- **Datum:** 2026-08-05
- **Stav:** REPO-LEVEL R15-D DOKONČENA A EXACT-SHA QUALITY GATE PROŠEL
- **Větev:** `agent/phase15d-dead-letter-requeue`
- **Základ:** `692b1248ed91ce40d00f1c42ebe0c87cf7d524f3`
- **Draft PR:** [#9](https://github.com/modvolt/Site-Logbook/pull/9), stacked na
  `agent/phase15c-staging-alert-drill`
- **Implementační commit:** `b173cd7951ab7e033be0605019a6821d1e68ae2e`
- **GitHub CI implementačního commitu:**
  [Quality gate 30961549402](https://github.com/modvolt/Site-Logbook/actions/runs/30961549402),
  PASS
- **Produkce:** beze změny
- **Migrace:** žádná změna ani aplikace; `0103` zůstává nenasazena a `0100`
  nezařazena

## Uložené výstupy

- [centrální verifikační registr](15-d-dead-letter-requeue-verification.md);
- [provozní postup](../runbooks/operational-alerts.md#r15-d-ruční-obnova-jedné-dead-letter-zásilky);
- OpenAPI kontrakt, generovaný TypeScript/Zod klient a fail-closed route manifest;
- autorizovaný redigovaný list a single-row requeue route;
- transakční store s optimistic concurrency a explicitním auditem;
- kontraktové a izolované DB souběhové testy.

## Kontroly

- 25/25 cílených lokálních kontraktových testů: PASS;
- strict OpenAPI parse, codegen a route manifest: PASS;
- API TypeScript check a cílený ESLint: PASS;
- `git diff --check`: PASS;
- GitHub Quality gate přesného implementačního SHA včetně izolovaných API DB,
  encrypted recovery a R14 full-stack/fault gate: PASS.

## Nejasnosti a zbytková rizika

- migrace `0103` nebyla aplikována na staging kopii;
- oddělený staging receiver, DNS/TLS, volume a secrety nejsou provisionované;
- skutečný durable delivery/restart/dead-man drill stále čeká na externí staging;
- manuální `staging-smoke.yml` push validace od R15-C končí bez vytvořeného jobu;
  R15-D workflow neměnila, ale R15-E ji musí před staging aktivací opravit;
- tato část neposkytuje grafické admin UI; bezpečný operator kontrakt je API a
  runbook, případné UI musí zachovat stejné preconditions a idempotency key.

## Jednoznačný checkpoint

Repozitář obsahuje lokálně ověřený R15-D single-row recovery workflow. Checkpoint
neautorizuje merge, deploy, GHCR publikaci, DNS/TLS/secret změnu, migraci, fault
injection ani zásah do produkce. Draft PR existuje a Quality gate přesného
implementačního commitu je zelený.

## Doporučení pro další část

- **další fáze:** R15-E – nejprve oprava/ověření manuálního staging workflow,
  potom uzavření externí staging aktivační připravenosti a provedení dosud
  odložených R15-C drillů pouze proti schválenému stagingu;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** další část kombinuje migraci `0103`, externí
  secrety, immutable image provenance, fault injection a důkaz obnovy;
- **očekávané činnosti:** opravit GitHub validaci `staging-smoke.yml`, publikovat
  privátní exact-SHA image, ověřit staging DNS/TLS/volume/secret boundary, zálohu
  staging kopie, aplikovat `0103`, nasadit exact SHA a provést durable outbox,
  restart-volume, dead-man a log-alert drill;
- **soubory, které budou pravděpodobně změněny:** pouze staging evidence/checkpoint
  dokumentace, případně úzká oprava rollout skriptů odhalená drillem;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano, může
  aplikovat již existující `0103` pouze na staging a provádět fault injection;
  produkční migrace/deploy zůstávají mimo rozsah bez nového výslovného schválení.
