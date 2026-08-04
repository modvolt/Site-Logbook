# FÁZE R15-B1 – security alert hardening a backup gate

- **Datum:** 2026-08-04.
- **Implementační větev:** `agent/phase15b1-security-alert-hardening`.
- **Stacked base:** `agent/phase15a-operational-signals` na
  `3a500350f3299ef661f87c1ea19aa18780e0f8a8`.
- **Ověřený vzdálený implementační head:**
  `d2750d3d6d8a278c7fe453affb43ef5a85763153`.
- **Ověřený strom zdrojů:** `45ccf9691ac0e71714921a13287e18f149d396e2`.
- **Draft PR:** [#6](https://github.com/modvolt/Site-Logbook/pull/6).
- **GitHub quality gate:** **PASS** –
  [run 30908008404](https://github.com/modvolt/Site-Logbook/actions/runs/30908008404).
- **Produkce / Coolify / Hetzner S3 / GHCR / DNS / secrets:** beze změny.
- **Migrace:** žádná; `0100_user_ui_preferences.sql` ani budoucí incident migrace nebyly
  přidány nebo spuštěny.

## Centrální registr výsledků

| Oblast | Výsledek | Důkaz |
| --- | ---: | --- |
| Izolace změny | PASS | stacked větev a draft PR #6; žádný merge, deploy ani změna produkční konfigurace |
| Redigovaný security audit | PASS | stabilní kódy pro password login, logout, setup, vault, WebAuthn a rate limit; bez username, hesla, IP, session ID nebo raw chyby |
| Security agregace | PASS | přesný allowlist legacy a nových nepříznivých akcí; libovolný `security.*` prefix se nezapočítá |
| Ochrana proti write amplification | PASS | omezené dedupe mapy, in-flight dedupe a TTL až po úspěšném durable insertu |
| Lokální alert sink | PASS | lokální redigovaný záznam je primární; externí transport jeho vytvoření neblokuje |
| HTTPS webhook | PASS, výchozí stav vypnutý | explicitní opt-in, startup fail-closed validace, veřejné HTTPS, přesný host allowlist a bearer token |
| SSRF a payload boundary | PASS | odmítnuté credentials/query/fragment/redirect/private IP; allowlist fields, 16 KiB a 32 transitions |
| Retry/cooldown | PASS | omezená fronta, timeout, nejvýše tři pokusy, idempotency key a fingerprint cooldown |
| Backup souběh | PASS | jeden PostgreSQL session advisory lease držený přes rezervaci, `pg_dump`, upload a finální zápis |
| Lease fencing | PASS | heartbeat, `isValid()`, CAS `id + status=running` a zničení spojení při ztrátě/unlock chybě |
| Opuštěné pokusy | PASS | reconciliation pouze po získání execution locku a po age fence 1–168 hodin, výchozí 24 |
| Object key kolize | PASS | každý backup objekt obsahuje UUID |
| Restore timeout | PASS | `pg_restore` je ukončen SIGTERM/SIGKILL, doběhne close/operation a až potom forced DB cleanup |
| Testovací DB boundary | PASS | pouze loopback a test/CI databáze; query parametry včetně `?host=` jsou odmítnuty |
| Izolovaný DB důkaz | PASS | lokálně 2 soubory / 20 testů proti dočasnému PostgreSQL 18 po 102 migracích |
| GitHub DB suite | PASS | krok `Isolated API database suites` v runu 30908008404 |
| Backup/restore a concurrency | PASS | skutečný encrypted backup/restore a souběh proti disposable PostgreSQL/MinIO |
| Object recovery | PASS | encrypted streaming object recovery drill |
| Full-stack/fault regression | PASS | R14 isolated full-stack and fault gate v témže exact-SHA runu |
| Produkční migrace | PASS – negativní důkaz | diff neobsahuje migration soubor, journal ani snapshot |

## Architektura

### Security audit a agregace

`security-audit.ts` je jediný redigovaný zapisovač nových autentizačních událostí. Route mu předává
jen stabilní kód, serverem odvozené user ID, výsledek a allowlistovaný důvod. Zápis je sekundární:
jeho selhání neznepřístupní přihlášení, ale vytvoří redigované varování bez databázového detailu.

Rate-limit a opakované WebAuthn denial události používají bounded per-process dedupe. Klíč je hash
scope, identity a zdroje; citlivé vstupy se neukládají. Dedupe interval začne až po úspěšném insertu,
takže přechodná DB chyba neumlčí další pokus. `operational-signals.ts` agreguje pouze přesně povolené
akce a zachovává omezenou kompatibilitu s konkrétními legacy kódy.

### Alert transport

Lokální sink zůstává prvním a vždy dostupným výstupem. Nový HTTPS transport je bez explicitního
`OPERATIONAL_ALERT_TRANSPORT=https_webhook` neaktivní. Aktivní chybná konfigurace zastaví start ještě
před `app.listen`. URL musí být veřejné HTTPS bez credentials, query a fragmentu, hostname musí být
v přesném allowlistu a bearer token musí splnit minimální entropii/formát.

Transport posílá pouze allowlistovaný redigovaný payload, nepovoluje redirect, omezuje velikost,
frontu, timeout i retry a používá stabilní `Idempotency-Key`. Cooldown platí pro tentýž fingerprint,
kind a severity; jiný critical, escalation nebo recovery není blokován globálním cooldownem.

### Backup execution a restore

Ruční i automatický trigger používá stejný PostgreSQL session advisory lease. Lease je držen přes
celý dump, šifrování, upload a finální CAS zápis. Heartbeat detekuje ztrátu spojení a executor bez
platného lease nesmí označit pokus jako úspěšný. Každý object path obsahuje UUID.

Nový trigger smí reconciliovat starý `running` řádek jen pod execution lockem a až po konfigurovaném
age fence. Finální `success` i `failed` update je omezen na původní `status=running`, takže pozdě
dobíhající proces nepřepíše již reconciled stav. Restore timeout nejprve ukončí `pg_restore`, počká na
close a skončení operace a teprve poté použije `DROP DATABASE ... WITH (FORCE)`.

## Lokální ověření

- API TypeScript typecheck: **PASS**;
- security audit a operational snapshot kontrakty: **PASS**, 2 soubory / 14 testů;
- přesné CI-regression DB testy: **PASS**, 2 soubory / 20 testů;
- dočasný PostgreSQL 18 cluster běžel pouze na `127.0.0.1:55439`, aplikoval 102 migrací a po testu
  byl zastaven a odstraněn;
- `git diff --check`: **PASS** (pouze informativní Windows LF/CRLF upozornění);
- pomocné pnpm store a neúplný `node_modules` byly po ověření odstraněny; zdrojový diff zůstal čistý.

## GitHub exact-SHA důkaz

Run 30908008404 skončil `success` pro commit
`d2750d3d6d8a278c7fe453affb43ef5a85763153`. Úspěšně dokončil:

- frozen-lockfile instalaci, quality gate a hermetic release gate;
- staging runtime, execution harness a guard/evidence kontrakty;
- všechny izolované API databázové sady;
- MinIO start/readiness/stop;
- encrypted backup/restore a concurrency gate;
- encrypted streaming object recovery drill;
- R14 full-stack a fault gate;
- post-job kroky a úplný container teardown.

GitHub CLI během opravy ztratilo autorizaci. Vzdálený strom byl proto publikován autorizovaným
GitHub konektorem bez force update. Před posunem refu byl znovu ověřen původní head `c9edc9c8...`;
publikovaný strom `45ccf969...` se přesně shodoval s lokálně otestovaným stromem.

## Nejasnosti a zbytková rizika

- webhook queue, dedupe, cooldown a recovery stav jsou per-process a po restartu se resetují;
- vestavěný webhook nevykryje úplný výpadek procesu/serveru; chybí nezávislý dead-man monitor;
- durable incident registry, outbox, delivery stav, multi-replica watermark a acknowledgement zatím
  neexistují;
- externí receiver nebyl provisionován a transport zůstává záměrně `disabled`;
- přesný hostname allowlist a blokace private IP literálů neodstraňují DNS správu jako externí trust
  boundary; receiver musí používat kontrolovanou DNS zónu;
- CI ověřilo syntetický PostgreSQL/MinIO restore, nikoli produkční Hetzner S3 ani produkční backup;
- workflow stále používá zděděné mutable action tagy `actions/*@v4` a
  `pnpm/action-setup@v4`; supply-chain pinning je samostatný P2 hardening nález;
- PR #6 je draft, stacked base není produkční `main` a zelený gate není souhlas s merge/deployem.

## Negativní důkazy

- žádný kontakt s `modvoltapp.cz`, Coolify, produkční DB, Hetzner S3 nebo produkčními secrets;
- žádný merge, deploy, GHCR publish, DNS zásah, restore produkce, backfill nebo migrace;
- žádná aktivace webhooku, vytvoření recipientu nebo vložení tokenu;
- žádná změna `0100_user_ui_preferences.sql` a žádná nová incident tabulka.
