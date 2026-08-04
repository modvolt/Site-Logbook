# FÁZE R15-B2 – checkpoint

- **Datum:** 2026-08-04
- **Stav:** DOKONČENO LOKÁLNĚ, PUBLIKAČNÍ ÚDAJE DOPLNÍ FINÁLNÍ COMMIT
- **Větev:** `agent/phase15b2-durable-incident-outbox`
- **Produkce:** beze změny
- **Migrace:** nová expand-only `0103_durable_operational_incident_outbox.sql`,
  ověřena pouze v jednorázové lokální DB; nikde nenasazena

## Uložené výstupy

- [centrální verifikační registr](15-b2-durable-incident-outbox-verification.md);
- [aktualizovaný provozní runbook](../runbooks/operational-alerts.md);
- durable incident registry, append-only event evidence a lease-based outbox;
- agregovaná read-only delivery diagnostika v admin watchdog kontraktu;
- nezávislý receiver/dead-man kontejner a hermetické kontrakty;
- schéma, migrace 0103, journal a snapshot.

## Shrnutí architektury

PostgreSQL je při dostupnosti jedinou autoritou incidentních přechodů. Globální
transakční lock serializuje kompletní snapshot mezi replikami. Každý přechod
atomicky vytvoří immutable event a právě jeden outbox řádek. Worker používá
`SKIP LOCKED`, expirovatelný lease, stabilní idempotency key, bounded retry a
dead-letter. Nouzový DB-outage alert a jeho recovery jsou sledovány odděleným
fallback watermarkem.

Receiver je samostatný artefakt s vlastním persistentním receipt ledgerem a
dead-man probem veřejného staging health endpointu. Je připraven pro pozdější
izolovaný rollout, ale tato fáze jej nikam nenasadila a nevytvořila secrets.

## Kontroly

- typecheck, lint, peer a dependency audit: PASS;
- API unit: 397/397; receiver: 4/4;
- izolovaná DB migrace 1–103 a fault test: 3/3 PASS;
- migration drift: žádný;
- hermetický release gate, production buildy a 35+130+15 souvisejících testů:
  PASS;
- dočasný PostgreSQL cluster: zastaven a odstraněn;
- `0100_user_ui_preferences.sql`: stále nezařazena.

## Nejasnosti a zbytková rizika

- chybí skutečný oddělený staging receiver, veřejné TLS/DNS, persistentní volume,
  secret custody a platformní alert nad receiver logy;
- chybí schválený staging rollout migrace 0103 a syntetický end-to-end incident
  drill přes skutečnou síťovou hranici;
- operator requeue dead-letteru vyžaduje samostatně autorizovaný proces;
- žádný výsledek této fáze neověřuje produkční rollout nebo produkční S3;
- draft PR a CI nejsou oprávnění k merge/deploy.

## Jednoznačný checkpoint

FÁZE R15-B2 končí durable implementací a izolovanými testy. Produkční Site
Logbook, Coolify, Hetzner S3, DNS, GHCR, produkční databáze a secrets zůstaly beze
změny. Migrace 0103 nebyla nikde mimo disposable lokální DB spuštěna. Checkpoint
neautorizuje merge, staging/production deploy, vytvoření secretu, receiver
provisioning ani aktivaci webhooku.

Do další fáze se v tomto spuštění automaticky nepokračuje.

## Doporučení pro další spuštění

- **další fáze:** FÁZE R15-C – izolované nasazení staging receiveru, aplikace
  migrace 0103 pouze na staging kopii, veřejný TLS transport a syntetický
  incident/dead-man/lease-recovery drill;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** fáze překračuje síťovou a secret trust boundary,
  aplikuje novou migraci na stavovou kopii, ověřuje at-least-once doručení a musí
  bezpečně odlišit staging od produkce i při fault injection;
- **očekávané činnosti:** schválit receiver hostname a TLS, vytvořit oddělený
  bearer secret přímo v secret managerech, připojit persistentní volume a log
  alerting, nasadit receiver mimo aplikační proces/DB, aplikovat 0103 jen na
  staging, aktivovat allowlistovaný webhook, vyvolat syntetické queue/provider,
  retry, dead-letter, lease-expiry, recovery a dead-man scénáře a uložit přesné
  důkazy/rollback checkpoint;
- **soubory, které budou pravděpodobně změněny:** staging deployment manifesty a
  evidence pod `deploy/staging/` a `docs/audit/`, případně úzké opravy receiveru,
  outbox workeru, runbooku a staging workflow nalezené během drillu;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** **ano**.
  Obsahuje staging aplikaci migrace 0103, nový secret, DNS/TLS/network egress,
  persistentní receiver data a fault injection. Produkce, produkční migrace,
  produkční secrets, merge a deploy zůstávají mimo oprávnění bez nového
  výslovného souhlasu.
