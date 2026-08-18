# FÁZE R15-B1 – checkpoint

- **Datum:** 2026-08-04.
- **Stav:** **DOKONČENO – SECURITY ALERT HARDENING A IZOLATED BACKUP GATE**.
- **Ověřený vzdálený implementační head:**
  `d2750d3d6d8a278c7fe453affb43ef5a85763153`.
- **Větev:** `agent/phase15b1-security-alert-hardening`.
- **Draft PR:** [#6](https://github.com/modvolt/Site-Logbook/pull/6), base
  `agent/phase15a-operational-signals`.
- **GitHub gate:**
  [run 30908008404](https://github.com/modvolt/Site-Logbook/actions/runs/30908008404), **PASS**.
- **Produkce:** beze změny.
- **Migrace:** žádná.

## Uložené výstupy

- [centrální verifikační registr](15-b1-security-alert-hardening-verification.md);
- [aktualizovaný provozní runbook](../runbooks/operational-alerts.md);
- redigovaný security audit a přesná adverse-event agregace;
- volitelný fail-closed HTTPS webhook transport, výchozí stav `disabled`;
- jednotný backup execution lease, heartbeat, fencing a stale-attempt reconciliation;
- restore timeout/cleanup hardening a bezpečnější testovací DB boundary;
- izolovaný GitHub backup/restore a concurrency gate.

## Shrnutí architektury

Autentizační a vault/WebAuthn cesty zapisují stabilní redigované security eventy. Alert burst používá
jen přesný allowlist a bounded dedupe chrání veřejné endpointy před write amplification. Lokální sink
zůstává primární; externí HTTPS transport vyžaduje explicitní opt-in a bezpečnou konfiguraci ověřenou
před otevřením portu aplikace.

Ruční a automatická záloha sdílejí jeden PostgreSQL execution lease držený až do konce dump/upload
operace. Heartbeat, UUID object key, CAS finální stav a age-fenced reconciliation zabraňují souběžnému
backup pokusu, kolizi objektů a přepsání již uzavřeného řádku. Restore timeout ukončí proces před
forced cleanupem.

## Provedené kontroly

- API typecheck: **PASS**;
- cílené nedatabázové kontrakty: **PASS**, 14/14;
- cílené izolované PostgreSQL testy: **PASS**, 20/20 po 102 migracích;
- dočasný PostgreSQL cluster byl po testu zastaven a odstraněn;
- GitHub quality/release/staging kontrakty: **PASS**;
- všechny izolované API DB sady: **PASS**;
- encrypted backup/restore + concurrency a object recovery drill: **PASS**;
- R14 full-stack/fault regression a teardown: **PASS**;
- migration diff: prázdný; `0100` ani nová incident migrace nejsou součástí fáze.

## Nejasnosti a zbytkové riziko

- incident/delivery stav a deduplikace nejsou durable ani multi-replica;
- chybí nezávislý receiver a dead-man monitor, takže úplný výpadek aplikace vestavěný webhook
  neohlásí;
- webhook zůstává vypnutý a nebyl testován proti reálnému staging receiveru;
- produkční Hetzner S3 backup/restore nebyl proveden;
- mutable GitHub Action tagy zůstávají samostatným P2 supply-chain nálezem;
- lokální commit opravy má kvůli publikaci přes GitHub konektor jiný commit SHA než vzdálený head,
  ale shodný ověřený tree SHA; po obnovení Git autentizace je nutné lokální ref bezpečně srovnat bez
  force-push;
- PR #6 zůstává draft a nic nebylo mergnuto nebo nasazeno.

## Jednoznačný checkpoint

FÁZE R15-B1 končí tímto checkpointem po zeleném exact-SHA GitHub gate. Produkční Site Logbook,
Coolify, Hetzner S3, DNS, GHCR, produkční databáze a secrets zůstaly beze změny. Checkpoint
neautorizuje merge PR #6, deploy, aktivaci webhooku, vytvoření receiveru, produkční restore, backfill
ani migraci, zejména ne `0100`.

Do R15-B2 se v tomto spuštění automaticky nepokračuje. Další fáze začne až po úpravě doporučeného
modelu/reasoningu v rozhraní a po výslovném pokynu `Pokračuj další fází`.

## Doporučení pro další spuštění

- **další fáze:** FÁZE R15-B2 – durable incident registry/outbox, delivery stav, multi-replica
  deduplikace a nezávislý staging receiver/dead-man monitor;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** fáze kombinuje expand-only databázovou migraci, souběh více replik,
  durable delivery stav, acknowledgement/recovery invariants, nový síťový trust boundary a správu
  alert secretu;
- **očekávané činnosti:** navrhnout incident/outbox stavový automat, idempotency a lease/claim model,
  doplnit append-only evidence a retry/dead-letter policy, vytvořit nezávislý receiver a dead-man
  staging ověření, přidat rollback/forward-only migrační důkaz, fault injection a exact-SHA CI gate;
- **soubory, které budou pravděpodobně změněny:** `lib/db/src/schema.ts`, nová migrace a příslušný
  journal/snapshot, nové incident/outbox moduly pod `artifacts/api-server/src/lib/`, watchdog/alert
  transport, admin diagnostika a OpenAPI/klienti podle schváleného scope, `.env.example`, workflow,
  testy, runbook a `docs/audit/15-b2-*`;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** **ano**. Pravděpodobná je nová
  expand-only migrace řady `0103_*` (nikoli odložená `0100`), nový staging secret, síťový egress a
  receiver. Migrace, secret konfigurace, receiver provisioning, merge a rollout musí být oddělené,
  vratné nebo forward-fix připravené, otestované v izolaci a před provedením znovu výslovně schválené.
