# Runbook provozních alertů

Tento runbook patří ke kontraktu R15-A. Alert obsahuje pouze stabilní kód,
závažnost, metriku, naměřenou a limitní hodnotu, vlastníka a odkaz sem. Nesmí
obsahovat uživatelské identity, e-maily, session ID, názvy souborů, object paths,
raw chyby workerů ani provider secrets.

Snapshot je dostupný oprávnění `diagnostics.view` na
`GET /api/admin/health/operational`. Endpoint čte pouze agregace z PostgreSQL;
nespouští S3 write/delete probe ani provider test.

## První reakce

1. Ověřte čas, kód, závažnost, naměřenou hodnotu a limit.
2. Zkontrolujte poslední deployment a stav API/PostgreSQL; neměňte data jen podle
   jediného vzorku.
3. U front nejdříve ověřte worker a jeden reprezentativní záznam. Nespouštějte
   hromadný retry bez potvrzení idempotence.
4. U záloh nejdříve zachovejte poslední známou dobrou zálohu. Mazání nebo restore
   do produkční DB vyžaduje samostatné schválení.
5. Eskalujte vlastníkovi uvedenému v alertu a do incidentu zapište jen redigovaná
   fakta.

## Fronty

| Kód | Význam | Vlastník | První bezpečná kontrola |
| --- | --- | --- | --- |
| `queue.extraction.stale` | Nejstarší `extraction_jobs.queued` překročil časové SLO. | Backend / doklady | Stav extraction workeru, hloubka fronty, stáří nejstarší úlohy. |
| `queue.extraction.failed` | Existují trvale selhané extrakce. | Backend / doklady | Počet pokusů a redigovaný error code v interních logách. |
| `queue.switchboard.stale` | Způsobilá úloha rozvaděče čeká příliš dlouho. | Backend / rozvaděče | Stav switchboard workeru, `available_at`, lock timeout. |
| `queue.switchboard.failed` | Existují vyčerpané úlohy rozvaděčů. | Backend / rozvaděče | Parser verze, počet pokusů a redigovaný error code. |
| `queue.email_import.stale` | Dočasně selhaný import čeká příliš dlouho na úspěšný retry. | Backend / doklady | Stav Gmail/IMAP importu a poslední poll bez obsahu zprávy. |
| `queue.email_import.failed` | Existují `failed_permanent` e-mailové importy. | Backend / doklady | Počet pokusů; ruční retry pouze pro konkrétní ověřenou zprávu. |

Výchozí warning je 15 minut, critical 60 minut. Trvalé chyby varují od jednoho
záznamu a jsou kritické od pěti. Limity lze změnit pouze explicitními
`OPERATIONAL_QUEUE_*` a `OPERATIONAL_FAILED_DEPTH_CRITICAL` env hodnotami.

## Zálohy a obnova

| Kód | Význam | Vlastník | První bezpečná kontrola |
| --- | --- | --- | --- |
| `backup.success.missing` | Backup je zapnutý, ale neexistuje úspěšná záloha. | DevOps / databáze | Dostupnost `pg_dump`, objektového úložiště a backup scheduleru. |
| `backup.success.stale` | Poslední úspěšná záloha překročila freshness limit. | DevOps / databáze | Poslední pokus a plán scheduleru; nemažte starší dobrou zálohu. |
| `backup.attempt.failed` | Poslední pokus selhal. | DevOps / databáze | Redigovaný server log a dostupnost cílového bucketu. |
| `backup.restore.missing` | Není evidovaný ověřovací DB restore test. | DevOps / databáze | Konfigurace weekly restore-test scheduleru. |
| `backup.restore.stale` | Poslední DB restore test je příliš starý. | DevOps / databáze | Poslední test a jeho izolovaná dočasná DB. |
| `backup.restore.failed` | Poslední DB restore test selhal. | DevOps / databáze | Zachovat zdrojovou zálohu a analyzovat izolovaný test; neobnovovat produkci. |

Výchozí freshness je 26/48 hodin pro backup a 8/14 dní pro restore test.
`restoreTestedAt` dokládá databázový test, nikoli úplný disaster-recovery drill
objektového úložiště ani skutečný produkční restore (`restoredAt`).

## Poskytovatelé

`provider.<id>.unhealthy` a `provider.<id>.not_configured` se generují pouze pro
providery označené jako povinné. Watchdog v R15-A sleduje DB a storage; SMTP je
záměrně volitelný. Admin snapshot nespouští aktivní provider probe.

Při DB výpadku nelze získat advisory lock ani DB agregace. Watchdog proto zapíše
redigovaný lokální alert i bez locku; ve více replikách mohou vzniknout duplicitní
logy. Duplicity jsou přijatelnější než tichý výpadek a odstraní je až nezávislý
durable incident transport v další části R15.

## Bezpečnostní události

`security.sensitive_events.burst` je agregovaný počet změn uživatelů, oprávnění,
session, WebAuthn credentials, vault step-up a emergency security akcí za 15
minut. Warning je výchozí od 10 a critical od 25 událostí.

Pokrytí je **částečné**: současný audit log neobsahuje všechny úspěšné/neúspěšné
login pokusy, logouty, rate-limit zásahy ani úplný WebAuthn autentizační tok.
Metrika proto nesmí být prezentována jako kompletní login-security SLI.

## Transport a známá omezení R15-A

- `alertTransport=local_log_only`; žádný webhook, pager ani externí secret není
  aktivovaný.
- Deduplikace a recovery přechody jsou per-process a po restartu se resetují.
- Když je DB dostupná, watchdog a purge používají unikátní PostgreSQL advisory
  locky, aby se ve škálovaných replikách nespouštěly duplicitně.
- SMTP e-mail původního availability watchdogu zůstává kompatibilní legacy
  kanál, ale není nezávislý a nepovažuje se za splnění R15 alert transportu.
- Durable incident registr, multi-replica dedupe a externí nezávislý kanál patří
  do samostatně schválené R15-B; R15-A kvůli nim nepřidává migraci.
