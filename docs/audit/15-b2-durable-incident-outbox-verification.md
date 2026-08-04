# R15-B2 – durable incident registry, outbox a nezávislý receiver

- **Datum:** 2026-08-04
- **Rozsah:** implementace a izolované ověření; bez staging/production rollout
- **Větev:** `agent/phase15b2-durable-incident-outbox`
- **Base:** vzdálený checkpoint R15-B1 `c79d03256dc63a2ea19de0883469ab22028c224d`
- **Produkce / Coolify / Hetzner / DNS / GHCR / secrets:** beze změny

## Výsledek

R15-B2 nahrazuje per-process autoritu přechodů durable incident registrem a
transakčním outboxem. Nezávislý receiver/dead-man je připraven jako samostatný,
pinovaný kontejnerový artefakt, ale v této fázi nebyl provisionován ani aktivován.

### Datový model

- `operational_incidents` drží jediný aktuální stav pro stabilní fingerprint;
- `operational_incident_events` je append-only žurnál přechodů s unikátním
  `(incident_id, sequence)` a deterministickým SHA-256 event key;
- `operational_alert_outbox` drží `pending → delivering → delivered` nebo
  `dead_letter`, počet pokusů, splatnost, lease token/expiraci a redigovanou
  kategorii poslední chyby;
- jeden incident event má databázově právě jeden outbox řádek;
- payload ani tabulky neukládají `summary`, identitu uživatele, e-mail, object
  path, raw provider chybu, URL ani bearer token.

### Souběh a recovery invarianty

Úplný snapshot se reconciliuje v jedné transakci pod stabilním
`pg_advisory_xact_lock(1009)`. Dvě repliky proto nevytvoří duplicitní přechod.
Worker claimuje vždy jeden splatný řádek pomocí `FOR UPDATE SKIP LOCKED`, přidělí
náhodný lease token na 45 sekund a ACK přijme pouze pro stále platný token.
Expirovaný claim může bezpečně převzít jiná replika.

Doručení je at-least-once a receiver deduplikuje persistentně podle 64hex
`Idempotency-Key`. Retryable chyba se vrací do `pending` s exponenciálním
backoffem nejvýše 15 minut. Permanentní chyba nebo osm vyčerpaných doručovacích
cyklů končí v `dead_letter`.

Pokud nelze DB použít, není možné zapsat outbox ani získat jeho lock. Watchdog
proto zachovává redigovanou přímou nouzovou cestu. In-process watermark drží
fingerprinty těchto fallback alertů a po obnově DB doručí jejich recovery; stále
aktivní fallback alert převezme durable registr bez falešné recovery. Neúplný
snapshot se do registru nereconciliuje, takže chyba agregace nemůže hromadně
uzavřít platné incidenty.

### Nezávislý receiver a dead-man

`deploy/operational-alert-receiver` je proces mimo Site Logbook a jeho DB:

- fail-closed bearer autentizace a bezpečné porovnání tokenu;
- maximálně 16 KiB, nejvýše 32 přechodů a přesný allowlist polí;
- atomický persistentní ledger receiptů s režimem souboru `0600`;
- duplicate ACK bez opakovaného uložení;
- nezávislý HTTPS probe veřejného staging `/healthz`, threshold alert a recovery;
- non-loopback bind je povolen jen s explicitním trusted-TLS-proxy přepínačem;
- base image i Dockerfile frontend syntax jsou digest-pinned.

Receiver v této fázi nebyl spuštěn na externím hostu. Nebyla vytvořena doména,
TLS konfigurace, persistentní volume, log alert policy ani secret. Lokální test
použil pouze syntetický token a loopback HTTP server.

## Migrace 0103 a návratový plán

`0103_durable_operational_incident_outbox.sql` je expand-only: vytváří tři nové
tabulky, constrainty, indexy, foreign keys a append-only trigger. Nemění ani
backfilluje existující produkční řádky. Starší aplikace nové tabulky ignoruje,
takže bezpečný rollback aplikace je návrat na předchozí image při ponechání
tabulek. Destruktivní down migrace se záměrně nedodává, protože by odstranila
incident evidence; problém schématu se řeší forward-fix migrací.

Migrace byla aplikována jen na jednorázový lokální PostgreSQL 18 cluster.
`0100_user_ui_preferences.sql` zůstává nezařazena: řetězec obsahuje `0101`,
`0102`, `0103`, nikoli `0100`.

## Ověření

| Kontrola | Výsledek |
|---|---:|
| root typecheck | PASS |
| ESLint | PASS |
| API hermetické unit kontrakty | PASS, 57 souborů / 397 testů |
| receiver/dead-man kontrakt | PASS, 4/4 |
| izolovaný PostgreSQL 18 + migrace 1–103 | PASS |
| incident/outbox DB fault test | PASS, 3/3 |
| migration drift po 0103 | PASS, žádná další migrace |
| hermetický release gate | PASS |
| release gate script kontrakty | PASS, 35/35 |
| frontend testy | PASS, 130/130 |
| live-events testy | PASS, 15/15 |
| API a frontend production build | PASS |
| peer dependency gate | PASS |
| dependency audit `moderate` | PASS, bez známé zranitelnosti |
| `git diff --check` | PASS |

DB fault test prokázal souběžný dedupe reconcile, stabilní sekvence, restartové
reopen, jediný claim, převzetí expirovaného lease, odmítnutí stale ACK,
permanentní dead-letter a DB triggerem odmítnutý update/delete append-only eventu.
Dočasný cluster byl po testu zastaven a odstraněn.

## Neprovedené a zbytkové riziko

- receiver/dead-man není externě provisionován a nebyl ověřen přes veřejné TLS;
- webhook zůstává defaultně `disabled`; žádný skutečný secret neexistuje;
- migrace 0103 nebyla aplikována na staging ani produkci;
- automatický operator retry/requeue `dead_letter` není součástí této fáze;
- přímá DB-outage cesta může mezi replikami doručit semantický duplikát; je to
  zdokumentovaná dostupnostní výjimka a receiver garantuje key-idempotency;
- PR je stacked a draft; green CI není souhlas s merge nebo deployem.

## Negativní důkazy

- žádný kontakt s `modvoltapp.cz`, Coolify, produkční DB ani Hetzner S3;
- žádný merge, deploy, image publish, DNS zásah, secret write, egress activation,
  restore, backfill nebo produkční migrace;
- žádná změna odložené migrace `0100_user_ui_preferences.sql`;
- žádné produkční nebo staging přihlašovací údaje v repozitáři či testech.
