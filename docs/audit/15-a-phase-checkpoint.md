# FÁZE R15-A – checkpoint

- **Datum:** 2026-08-04.
- **Stav:** **DOKONČENO – REDIGOVANÉ PROVOZNÍ SIGNÁLY A LOKÁLNÍ ALERT POLICY**.
- **Ověřený implementační head:** `3393ce9f54bf5459a394f0ddea7683efcbdc1f1d`.
- **Větev:** `agent/phase15a-operational-signals`.
- **Draft PR:** [#5](https://github.com/modvolt/Site-Logbook/pull/5), base
  `agent/phase14b-full-stack-fault-gate`.
- **GitHub gate:** [run 30897935771](https://github.com/modvolt/Site-Logbook/actions/runs/30897935771),
  **PASS** včetně izolovaných DB sad, recovery drillu, browser/fault gate a teardownu.
- **Produkce:** beze změny.

## Uložené výstupy

- [centrální verifikační registr](15-a-operational-signals-verification.md);
- [provozní runbook](../runbooks/operational-alerts.md);
- čistá alert policy, redigovaný lokální sink a DB aggregate collector;
- permission-protected OpenAPI endpoint a vygenerované Zod/React klienty;
- úzká sekce v existující admin diagnostice;
- kontrakty pro limity, unknown stav, redakci, deduplikaci, recovery a scheduler locky.

## Shrnutí architektury

R15-A odděluje sběr, vyhodnocení a publikaci provozních signálů. Existující PostgreSQL tabulky dodávají
jen agregace front, backup/restore freshness a částečných security změn. Čistá policy z nich sestaví
stabilní redigované alerty a per-process tracker zapisuje pouze přechody do lokálního strukturovaného
logu. Admin snapshot je read-only endpoint s `diagnostics.view` a záměrně nespouští aktivní S3 nebo
provider test.

Watchdog a purge jsou při dostupné DB chráněné unikátními advisory locky. Při DB výpadku je signál
zapsán i bez locku, aby společný výpadek databáze neumlčel jedinou lokální indikaci. Externí nezávislý
transport ani durable incident stav tato fáze nezapíná.

## Provedené kontroly

- lokální release gate: **PASS** – 35 script/contract, 130 frontend, 15 live-events a 362 API unit;
- lokální quality gate: **PASS** – lint, peer dependencies a dependency audit;
- API/PWA typecheck a produkční build: **PASS**;
- Impeccable detector: **PASS**, `[]`;
- diff whitespace a route/OpenAPI codegen: **PASS**;
- GitHub isolated full-stack/DB gate: **PASS** v runu 30897935771;
- migrace `0100_user_ui_preferences.sql`: **nepřítomná**.

## Nejasnosti a zbytkové riziko

- lokální Docker engine zůstal nereagující a lokální PostgreSQL vyžadoval neznámé heslo; nebyly
  použity produkční secrets a integrační DB důkaz musí dokončit GitHub runner;
- security audit coverage je částečné a nesmí být vydáváno za úplné login-security SLI;
- deduplikace není durable ani multi-replica;
- chybí nezávislý externí alert kanál;
- backup trigger lock race a úplný security audit instrumentation zůstávají samostatné nálezy;
- stacked PR #5 ani jeho rodiče nejsou mergnuté a produkce běží na dosavadní revizi.

## Jednoznačný checkpoint

FÁZE R15-A končí tímto checkpointem po dokončení a zaznamenání GitHub gate. Produkční Site Logbook,
Coolify, Hetzner S3, DNS, GHCR, produkční databáze a secrets zůstaly beze změny. Checkpoint
neautorizuje merge PR #5, merge jeho rodičů, deploy, externí alert provider, produkční restore,
backfill ani migraci, zejména ne `0100`.

Další práce nesmí automaticky pokračovat do R15-B, dokud uživatel neupraví doporučené nastavení v
rozhraní a výslovně nenapíše `Pokračuj další fází`.

## Doporučení pro další spuštění

- **další fáze:** FÁZE R15-B – durable incident registry, nezávislý externí alert transport a úplnější
  security audit instrumentation;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** durable deduplikace, multi-replica souběh, nový externí trust boundary,
  alert secrets a úplnější auth/security telemetry mají přímé bezpečnostní i dostupnostní dopady;
- **očekávané činnosti:** vybrat nezávislý transport, navrhnout cooldown/ack/recovery stav, ošetřit
  restart a změnu repliky, doplnit chybějící login/logout/rate-limit/WebAuthn audit události, odstranit
  backup trigger lock race, přidat hermetické transport/failure testy a staging-only ověření bez
  kontaktu s produkcí;
- **soubory, které budou pravděpodobně změněny:** nové incident/alert moduly pod
  `artifacts/api-server/src/lib/`, auth/session/WebAuthn/rate-limit routes a middleware,
  `lib/db/src/schema.ts`, nová expand-only DB migrace a metadata, `.env.example`, OpenAPI/klienti,
  `.github/workflows/*`, testy a `docs/audit/15-b-*`;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano. Durable incident registry
  může vyžadovat novou expand-only migraci (nikoli `0100`) a externí transport nový provider secret a
  síťový egress. Každý takový krok musí být oddělený, fail-closed, otestovaný v izolaci a před merge,
  secret konfigurací nebo nasazením znovu výslovně schválený.
