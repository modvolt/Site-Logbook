# Runbook provozních alertů

Tento runbook patří ke kontraktu R15-A/R15-B1. Alert obsahuje pouze stabilní kód,
závažnost, metriku, naměřenou a limitní hodnotu, vlastníka a odkaz sem. Nesmí
obsahovat uživatelské identity, e-maily, session ID, názvy souborů, object paths,
raw chyby workerů ani provider secrets.

## R15-B2: durable incidenty, outbox a nezávislý receiver

Při dostupné databázi je autoritou tabulka `operational_incidents`. Celý snapshot
se porovnává v transakci pod stabilním `pg_advisory_xact_lock`; stejný tick dvou
replik proto vytvoří nejvýše jeden `triggered`, `escalated`, `deescalated` nebo
`recovered` event. `operational_incident_events` je append-only evidence a pro
každý event vznikne právě jeden řádek `operational_alert_outbox`.

Worker claimuje splatné záznamy pomocí `FOR UPDATE SKIP LOCKED`. Claim má náhodný
lease token a 45sekundovou expiraci; po pádu jej může převzít jiná replika.
Doručení je **at-least-once**. Deterministický SHA-256 event key se posílá jako
`Idempotency-Key`, ACK se zapíše jen s aktuálním lease tokenem. Retryable chyby
mají exponenciální backoff nejvýše 15 minut; permanentní chyba nebo osm vyčerpaných
doručovacích cyklů končí v `dead_letter`. Zapnutí transportu po období `disabled`
bezpečně odešle čekající eventy.

Nouzová výjimka platí jen při nedostupné DB: protože nelze získat lock ani zapsat
outbox, watchdog zachová přímý redigovaný webhook. Duplicitní zpráva mezi replikami
je v tomto stavu možná a receiver ji musí deduplikovat.

Referenční receiver je v `deploy/operational-alert-receiver`. Musí běžet mimo
aplikační proces a jeho databázi, za veřejným TLS proxy a s persistentním volume.
Striktně ověřuje bearer token, 64hex idempotency key, 16KiB limit a allowlist polí;
každý klíč uloží atomicky na volume. Současně nezávisle probuje veřejné staging
`/healthz` a po nastaveném počtu selhání vypíše `dead_man_triggered`. Receiver logy
proto musí sbírat platforma oddělená od Site Logbooku.

Tato implementace sama receiver neprovisionuje, nevytváří DNS ani secret a
neaktivuje egress. Před staging rolloutem samostatně schvalte doménu, TLS,
persistentní volume, log alerting a dva nezávisle vytvořené secret záznamy se
stejnou náhodnou hodnotou na obou stranách.

## R15-C: staging rollout a fault drill

Staging compose přidává receiver jako šestou službu s limitem 0,25 CPU/128 MiB,
read-only root filesystemem, odebranými capabilities a persistentním volume pro
idempotency keys. API čeká na jeho exact-SHA health a používá výhradně veřejný
HTTPS hostname z preflight allowlistu. Receiver současně probuje veřejný staging
`/api/healthz`; nevstupuje do databáze aplikace.

Publikace image musí proběhnout privátním GHCR publisher workflow pro přesný commit
a výsledný deployment musí používat digest, nikoli pohyblivý tag. DNS, TLS proxy,
secret a volume jsou externí staging zdroje a jejich vznik není autorizací změny
produkce.

Manuální `Staging smoke (manual, no deploy)` nejprve ověří exact-SHA health API i
receiveru, potom odešle jediný redigovaný syntetický event dvakrát se stejným
idempotency key. Očekává první ACK `202` a druhý deduplikační ACK `200`; evidence
neobsahuje URL, token ani samotný idempotency key.

Před finálním staging release gate je navíc nutné samostatně prokázat:

1. skutečný incident transition prošel durable outboxem a receiver jej potvrdil;
2. deduplikace přežila restart receiveru a připojení stejného volume;
3. bezpečný výpadek pouze staging health endpointu vyvolal `dead_man_triggered`;
4. obnovení endpointu vyvolalo `dead_man_recovered`;
5. platformní log alert doručil oba dead-man přechody mimo Site Logbook proces.

Při kterémkoli nejasném hostname, SHA, storage mountu nebo secret boundary drill
ukončete. Nevypínejte kvůli němu produkční službu a nepoužívejte produkční token.

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

| Kód                         | Význam                                                      | Vlastník            | První bezpečná kontrola                                         |
| --------------------------- | ----------------------------------------------------------- | ------------------- | --------------------------------------------------------------- |
| `queue.extraction.stale`    | Nejstarší `extraction_jobs.queued` překročil časové SLO.    | Backend / doklady   | Stav extraction workeru, hloubka fronty, stáří nejstarší úlohy. |
| `queue.extraction.failed`   | Existují trvale selhané extrakce.                           | Backend / doklady   | Počet pokusů a redigovaný error code v interních logách.        |
| `queue.switchboard.stale`   | Způsobilá úloha rozvaděče čeká příliš dlouho.               | Backend / rozvaděče | Stav switchboard workeru, `available_at`, lock timeout.         |
| `queue.switchboard.failed`  | Existují vyčerpané úlohy rozvaděčů.                         | Backend / rozvaděče | Parser verze, počet pokusů a redigovaný error code.             |
| `queue.email_import.stale`  | Dočasně selhaný import čeká příliš dlouho na úspěšný retry. | Backend / doklady   | Stav Gmail/IMAP importu a poslední poll bez obsahu zprávy.      |
| `queue.email_import.failed` | Existují `failed_permanent` e-mailové importy.              | Backend / doklady   | Počet pokusů; ruční retry pouze pro konkrétní ověřenou zprávu.  |

Výchozí warning je 15 minut, critical 60 minut. Trvalé chyby varují od jednoho
záznamu a jsou kritické od pěti. Limity lze změnit pouze explicitními
`OPERATIONAL_QUEUE_*` a `OPERATIONAL_FAILED_DEPTH_CRITICAL` env hodnotami.

## Zálohy a obnova

| Kód                      | Význam                                              | Vlastník          | První bezpečná kontrola                                                      |
| ------------------------ | --------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `backup.success.missing` | Backup je zapnutý, ale neexistuje úspěšná záloha.   | DevOps / databáze | Dostupnost `pg_dump`, objektového úložiště a backup scheduleru.              |
| `backup.success.stale`   | Poslední úspěšná záloha překročila freshness limit. | DevOps / databáze | Poslední pokus a plán scheduleru; nemažte starší dobrou zálohu.              |
| `backup.attempt.failed`  | Poslední pokus selhal.                              | DevOps / databáze | Redigovaný server log a dostupnost cílového bucketu.                         |
| `backup.restore.missing` | Není evidovaný ověřovací DB restore test.           | DevOps / databáze | Konfigurace weekly restore-test scheduleru.                                  |
| `backup.restore.stale`   | Poslední DB restore test je příliš starý.           | DevOps / databáze | Poslední test a jeho izolovaná dočasná DB.                                   |
| `backup.restore.failed`  | Poslední DB restore test selhal.                    | DevOps / databáze | Zachovat zdrojovou zálohu a analyzovat izolovaný test; neobnovovat produkci. |

Výchozí freshness je 26/48 hodin pro backup a 8/14 dní pro restore test.
`restoreTestedAt` dokládá databázový test, nikoli úplný disaster-recovery drill
objektového úložiště ani skutečný produkční restore (`restoredAt`).

Automatický i ruční backup trigger v R15-B1 používá tentýž PostgreSQL advisory
lock a invariant jediného `backup_log.status=running`. Řádek vznikne synchronně
pod lockem a session-level lock zůstává držený až do konce `pg_dump`, uploadu a
zápisu výsledku. Lease používá heartbeat; při ztrátě lock spojení executor
nesmí dokončit řádek jako úspěšný. Finální `success` i `failed` zápis je navíc
CAS omezený na původní `status=running`, takže již reconciled pokus nelze později
přepsat. Při pádu procesu PostgreSQL lock uvolní. Každý object key navíc
obsahuje náhodné UUID, takže ani chybně souběžné rezervace nemohou přepsat stejný
objekt.

Nový trigger smí opuštěný `running` řádek označit jako `failed` pouze pokud
sám nejdřív získal tentýž execution lock a pokus je starší než
`BACKUP_STALE_RUNNING_HOURS` (výchozí 24 hodin, povolený rozsah 1–168). Samotné
stáří tedy nestačí: živá spolupracující replika drží lock a reconciliation
zablokuje. Konzervativní časový plot navíc chrání rolling deployment se starší
verzí, která lock dříve držela jen při rezervaci. Reconciliation nemaže objekt
ani log; zachová pokus s redigovanou chybou pro forenzní kontrolu.

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
session, WebAuthn credentials, vault step-up, emergency security akcí a
nepříznivých autentizačních výsledků za 15 minut. Warning je výchozí od 10 a
critical od 25 událostí.

R15-B1 doplňuje stabilní redigované kódy pro password login, logout, první setup,
vault password, WebAuthn complete a rate-limit zásahy. Auditní řádek neobsahuje
username, heslo, IP, user-agent, session ID, credential ID ani raw chybu
ověřovací knihovny. Běžný úspěšný login/logout se ukládá pro audit, ale záměrně
se nezapočítává do burst alertu. Započítávají se denial/failure/rate-limit a
bezpečnostně významné registration/setup změny.

Rate-limit handler zapisuje nejvýše jeden durable event pro source+scope za
15 minut a proces drží nejvýše 512 takových klíčů. Důvodem je ochrana veřejných
auth cest před neomezenou DB-write amplification; počty rate-limit událostí jsou
proto bezpečnostní signál, nikoli přesný forenzní počet všech odmítnutých paketů.

## HTTPS webhook transport R15-B1

Výchozí konfigurace je vždy vypnutá:

```dotenv
OPERATIONAL_ALERT_TRANSPORT=disabled
OPERATIONAL_ALERT_WEBHOOK_URL=
OPERATIONAL_ALERT_WEBHOOK_ALLOWED_HOSTS=
OPERATIONAL_ALERT_WEBHOOK_BEARER_TOKEN=
OPERATIONAL_ALERT_WEBHOOK_TIMEOUT_MS=4000
OPERATIONAL_ALERT_WEBHOOK_COOLDOWN_SECONDS=900
```

Pouhé vložení URL nebo tokenu transport **nezapne**. Aktivace vyžaduje přesně
`OPERATIONAL_ALERT_TRANSPORT=https_webhook`. Aktivní konfigurace je fail-closed:
API nenastartuje bez veřejné HTTPS URL bez credentials/query/fragmentu, jejího
přesného hostname v `OPERATIONAL_ALERT_WEBHOOK_ALLOWED_HOSTS` a bez base64url
tokenu vytvořeného z alespoň 32 náhodných bajtů. Token patří pouze do secret
manageru cílového prostředí; nesmí být v repozitáři, dokumentaci, logu, Coolify
change preview ani v incident payloadu.

Webhook přijímá `POST application/json` s `Authorization: Bearer ...` a
`Idempotency-Key`. Payload má nejvýše 32 přechodů a 16 KiB; obsahuje pouze
allowlistované transition fields a nikdy `summary`, recipient, URL/token, raw
chybu nebo identitu uživatele. Redirect je odmítnut. Timeout je výchozí 4 s,
retry proběhne nejvýše třikrát s prodlevou 250/1000 ms pro network/timeout,
408/425/429/5xx. Ostatní 4xx a redirect jsou trvalé chyby a response stream je
bez čtení těla zrušen. Po úspěchu platí výchozí 15minutový cooldown pouze pro
stejný fingerprint+kind+severity. Jiný critical, escalation nebo recovery čekat
nemusí a burst se vyprazdňuje po dávkách bez globálního cooldownu.

Aktivaci lze provést až pro předem schválený nezávislý receiver. Před aktivací:

1. vytvořte oddělený náhodný bearer token přímo v secret manageru a nastavte
   přesný allowlist hostname receiveru;
2. ověřte veřejný TLS endpoint a jeho autentizaci mimo produkční alert tok;
3. nejprve nastavte URL/token, ponechte `disabled` a ověřte start/readiness;
4. teprve v samostatně schváleném staging rollout kroku změňte režim na
   `https_webhook` a vyvolejte syntetický redigovaný alert;
5. ověřte doručení, deduplikaci a recovery bez použití produkčního incidentu.

## Známá omezení R15-B1

- Deduplikace, recovery přechody, cooldown a neodeslaná fronta jsou per-process a
  po restartu se resetují.
- Když je DB dostupná, watchdog a purge používají unikátní PostgreSQL advisory
  locky, aby se ve škálovaných replikách nespouštěly duplicitně.
- SMTP e-mail původního availability watchdogu zůstává kompatibilní legacy
  kanál, ale není nezávislý a nepovažuje se za splnění R15 alert transportu.
- Vestavěný webhook vzniká uvnitř stejného aplikačního procesu, a proto nezjistí
  úplný výpadek procesu/serveru; ten vyžaduje externí dead-man monitor.
- URL validace blokuje lokální/private IP literály, interní/single-label hostname
  a vyžaduje přesný allowlist, ale správa DNS schváleného receiveru zůstává
  externí trust boundary. Receiver hostname proto musí být pod kontrolovanou DNS
  zónou a nesmí se překládat na private/link-local adresy.
- Durable incident registr, multi-replica dedupe/ack/watermark a append-only
  incident evidence patří do samostatně schválené R15-B2 s novou migrací.
