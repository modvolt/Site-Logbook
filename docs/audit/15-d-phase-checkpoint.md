# FÁZE R15-D – checkpoint

- **Datum:** 2026-08-05
- **Stav:** IMPLEMENTACE A LOKÁLNÍ KONTROLY DOKONČENY; GITHUB CI ČEKÁ
- **Větev:** `agent/phase15d-dead-letter-requeue`
- **Základ:** `692b1248ed91ce40d00f1c42ebe0c87cf7d524f3`
- **Draft PR:** čeká na vytvoření, stacked na `agent/phase15c-staging-alert-drill`
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
- izolovaný PostgreSQL souběhový test: připraven pro GitHub Quality gate.

## Nejasnosti a zbytková rizika

- GitHub Quality gate přesného SHA ještě neproběhl;
- migrace `0103` nebyla aplikována na staging kopii;
- oddělený staging receiver, DNS/TLS, volume a secrety nejsou provisionované;
- skutečný durable delivery/restart/dead-man drill stále čeká na externí staging;
- tato část neposkytuje grafické admin UI; bezpečný operator kontrakt je API a
  runbook, případné UI musí zachovat stejné preconditions a idempotency key.

## Jednoznačný checkpoint

Repozitář obsahuje lokálně ověřený R15-D single-row recovery workflow. Checkpoint
neautorizuje merge, deploy, GHCR publikaci, DNS/TLS/secret změnu, migraci, fault
injection ani zásah do produkce. Dokončení fáze vyžaduje draft PR a zelený GitHub
Quality gate přesného commitu.

## Doporučení pro další část

- **další fáze:** R15-E – uzavření externí staging aktivační připravenosti a
  provedení dosud odložených R15-C drillů pouze proti schválenému stagingu;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** další část kombinuje migraci `0103`, externí
  secrety, immutable image provenance, fault injection a důkaz obnovy;
- **očekávané činnosti:** publikovat privátní exact-SHA image, ověřit staging
  DNS/TLS/volume/secret boundary, zálohu staging kopie, aplikovat `0103`, nasadit
  exact SHA a provést durable outbox, restart-volume, dead-man a log-alert drill;
- **soubory, které budou pravděpodobně změněny:** pouze staging evidence/checkpoint
  dokumentace, případně úzká oprava rollout skriptů odhalená drillem;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano, může
  aplikovat již existující `0103` pouze na staging a provádět fault injection;
  produkční migrace/deploy zůstávají mimo rozsah bez nového výslovného schválení.
