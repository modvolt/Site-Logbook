# Checkpoint FÁZE 8.7 – dokončení R03

- **Stav:** FÁZE 8.7 dokončena. Druhý izolovaný řez R03 je lokálně implementovaný a ověřený; FÁZE 8.8 ani FÁZE 9 nebyly zahájeny.
- **Výchozí revize:** `2c6b52b` (`main`; lokálně dvacet dva commitů před `origin/main`).
- **Implementační revize:** `45937f6`, `583eaa4` (`main`; lokálně dvacet čtyři commitů před `origin/main`). Dokumentační checkpoint následuje jako samostatný commit.
- **Produkční zásah:** žádný. Nebyla použita produkční DB, produkční secrets, `modvoltapp.cz`, vzdálený Git, push ani deploy.
- **Databázová migrace:** nová aditivní migrace `0097_api_idempotency_records`; byla aplikována a vrácena pouze v jednorázových lokálních PostgreSQL 18 databázích.
- **Browser storage migrace:** IndexedDB `stavba-offline-v1` se aditivně povyšuje z verze 2 na 3 a přidává store `scope-leases`. Vlastněné operace, bloby i v1 karanténa zůstávají zachované.

## 1. Uzavřený rozsah

### Durable serverová deduplikace

Každá mutace, která nese serverem ověřený `X-Stavba-Offline-Scope`, nyní musí mít platný `Idempotency-Key`. Middleware běží po autentizaci, scope a permission kontrole, ale před auditním middlewarem a doménovým handlerem. Online mutace bez offline scope tímto protokolem nejsou změněny.

Nová tabulka `api_idempotency_records` váže klíč na uživatele, autorizační scope, HTTP metodu a cestu. Ukládá otisk požadavku, stav `pending/completed/ambiguous`, omezenou JSON odpověď a časové údaje. Otisk zahrnuje kanonický query string, JSON tělo nebo SHA-256 raw obsahu. Stejný klíč s jiným požadavkem je odmítnut.

Krátká transakční PostgreSQL advisory lock serializuje pouze přijetí klíče. HTTP handler nedrží klienta ze sdíleného poolu. Aktivní `pending` záznam má heartbeat; souběžný pokus dostane transient `idempotency_in_progress`. Dokončená odpověď je vrácena se `Idempotency-Replayed: true`. Stará nebo přerušená `pending` operace a serverový 5xx výsledek se mění na `idempotency_ambiguous` a nikdy se automaticky neprovedou podruhé. Nedostupný ledger končí `503 idempotency_unavailable` ještě před doménovým zápisem.

Odpovědi 408, 425 a 429 ledger neupevní a mohou se bezpečně opakovat. Zachycená JSON odpověď má limit 64 KiB; všechny současné offline write routy vracejí malé kontrakty.

### Raw uploady

U offline fotografií nemá idempotency middleware ještě parsované binární tělo. Klient proto před odesláním spočítá SHA-256 a přidá `X-Stavba-Content-SHA256`. Digest vstupuje do serverového request fingerprintu a storage/switchboard route jej po načtení `Buffer` znovu ověří. Chybějící, neplatný nebo neshodný digest selže před uložením objektu.

Dvoudílný job photo workflow používá odvozené klíče `<op>-upload` a `<op>-attachment`; opakovaný upload tak vrací stejný `objectPath` a registrace přílohy má vlastní deduplikační hranici.

### Cross-tab lease a retry state machine

IndexedDB v3 má atomický read/write lease po autorizačním scope. Jedna tabová instance jej získá na 45 sekund a každých 15 sekund obnovuje. Druhá instance flush přeskočí; takeover je povolen až po expiraci. Release i renew kontrolují holder ID a uživatele. Po získání lease klient znovu živě ověří `/api/auth/me`, takže čekající tab nemůže použít zastaralou identitu.

Všechny offline typy a jejich dílčí requesty posílají stabilní idempotency key. Výsledek se klasifikuje jako `auth`, `transient`, `conflict`, `permanent` nebo `ambiguous`:

- transient chyby mají nejvýše pět automatických pokusů s exponenciálním backoffem 1–30 sekund a respektují bounded `Retry-After`;
- FIFO se po plánovaném transient retry zastaví, aby pozdější závislé operace nepředběhly první;
- auth změna skryje partition, obnoví auth stav a nic dalšího neodešle;
- conflict, permanent a ambiguous výsledky se nepřehrávají stejným durable klíčem; uživatel musí ověřit stav a vytvořit novou opravenou operaci nebo položku zahodit;
- ruční opakování stejného klíče je dostupné pouze po vyčerpání transient chyb.

## 2. Stav nálezů

| Nález | Stav po FÁZI 8.7 | Důkaz |
|---|---|---|
| SEC-08 | uzavřen lokálně ve FÁZI 8.6 | explicitní per-scope API cache allowlist |
| SEC-09 | uzavřen lokálně ve FÁZI 8.6 | vlastněná IndexedDB partition a atomická serverová scope kontrola |
| GDPR-07 | uzavřen lokálně ve FÁZI 8.6 | identity rotation odstraní cache a cizí/legacy payload není dostupný |
| ROB-01 | uzavřen lokálně ve FÁZI 8.6 | v1 fronta v karanténě, nové záznamy vlastněné scope |
| ROB-02 | uzavřen lokálně ve FÁZI 8.7 | atomický lease race, durable ledger, raw digest, bounded retry a fail-closed ambiguous stav |

R03 je tímto **lokálně dokončen**. Plný Playwright scénář dvou skutečných tabů, restartu service workeru a offline/online přechodu zůstává průřezovým E2E důkazem v R14, nikoli známou mezerou implementačního invariantu.

## 3. Logické commity a návrat

| Commit | Změna | Návrat |
|---|---|---|
| `45937f6` | serverový offline idempotency middleware, raw SHA-256 vazba, schema/migrace `0097`, bezpečný down skript a DB concurrency testy | nejdříve zastavit/omezit offline replay a vrátit aplikační kód; aditivní tabulku ponechat. Down migrace se záměrně zablokuje, jakmile ledger obsahuje jediný záznam |
| `583eaa4` | IndexedDB v3 lease, stabilní klíče všech requestů, retry klasifikace/backoff a bezpečné UI stavy | starý v2 klient nedokáže otevřít již povýšenou DB v3 a selže uzavřeně; rollback musí zachovat kompatibilní DB verzi nebo offline frontu explicitně vypnout |

Bezpečné produkční pořadí je: záloha a read-only preflight, migrace `0097`, koordinované nasazení API a frontend/PWA, kontrola health a následné sledování idempotency kódů. Starší otevřený klient z FÁZE 8.6 posílá scope, ale u části operací ještě neposílá klíč; nový server jej proto bezpečně odmítne 400 místo rizika duplicity. Rollout musí uživatele navést k obnovení PWA. Fronta zůstane v IndexedDB a nový klient ji může ručně znovu odeslat.

## 4. Provedené kontroly

### Statické a hermetické kontroly

- workspace, API a frontend TypeScript typecheck: prošly;
- API unit/contract sada: 28 souborů, 213/213;
- frontend release sada: 8 souborů, 127/127;
- `live-events`: 15/15;
- test-environment guard: 5/5;
- API production build: prošel;
- frontend production build, PWA inject manifest a service worker build: prošly;
- `git diff --check`: prošel.

### Izolovaný PostgreSQL 18

Jednorázové clustery běžely pouze na `127.0.0.1`, náhodném portu a v ověřených systémových temp adresářích. Ambientní `DATABASE_URL` byla pro autorizační sadu odstraněna. Po každém běhu byly testovací databáze, server i celý temp adresář odstraněny.

- journal a migration parity: 98/98 migrací, latest `0097`, 91/91 tabulek proti snapshotu;
- migrace `0096` forward → down → forward: prošla;
- migrace `0097` forward → down → forward: prošla;
- auth/session lifecycle: 4/4;
- vault authorization: 10/10;
- private-object authorization: 17/17;
- offline idempotency: 7/7;
- použitá session generation blokuje destruktivní rollback `0096`;
- použitý idempotency ledger blokuje destruktivní rollback `0097`.

Idempotency sada prokázala jeden side effect při dvou souběžných stejných requestech, replay stejné odpovědi, odmítnutí změněného payloadu, fail-closed chování bez klíče/digestu, přerušení jako ambiguous a 12 souběžných různých operací bez vyčerpání sdíleného DB poolu. IndexedDB test prokázal jediného vítěze skutečného souběžného `Promise.all` lease race, ochranu release, expiraci a takeover.

Na Windows bylo pro release gate nutné dočasně použít Node ekvivalent kořenového Unix `sh` preinstallu a přesně verzované bindingy esbuild, Rollup, Lightning CSS a Tailwind Oxide. Po finální úspěšné bráně byly odstraněny; `package.json` a `pnpm-lock.yaml` nemají žádný diff.

Zůstala známá neblokující Vite upozornění na chunky `index` přibližně 835 KiB a HEIC přibližně 1,35 MiB. Produkční smoke, DAST, vzdálené CI, skutečný browser E2E, push a deploy spuštěny nebyly.

## 5. Nejasnosti a zbytková rizika

1. `api_idempotency_records` ukládá omezenou kopii odpovědi bez automatické retence. Produkční retenční lhůtu, cleanup a případný minimalizovaný payload je nutné schválit v R10; tabulku do té doby nemažte, protože je důkazem proti duplicitě.
2. Plný browser E2E dvou tabů, PWA update a skutečného reconnectu není v tomto řezu spuštěn. Atomický IndexedDB kontrakt a skutečná PostgreSQL concurrency dokazují obě ochranné vrstvy, end-to-end provozní scénář ale patří do R14.
3. Legacy v1 payload zůstává na zařízení v karanténě bez recovery/export/delete UI. Automatické přiřazení aktuálnímu uživateli zůstává zakázané.
4. Povolený terénní dataset je stále plaintext browser storage. Partition neřeší kompromitované nebo ztracené BYOD zařízení, šifrování at rest ani vzdálený wipe.
5. Aditivní `0097` musí být v produkci aplikována před aktivací serverového middleware. Bez tabulky scoped offline mutace záměrně končí 503; běžné online mutace bez scope zůstávají dostupné.
6. Stale PWA klient během rollout okna dostane fail-closed chybu kvůli chybějícímu klíči. Je nutný řízený refresh/update postup a monitoring `idempotency_key_required`, `idempotency_unavailable`, `idempotency_ambiguous` a `offline_content_digest_*`.

## 6. Jednoznačný checkpoint a doporučení pro další spuštění

**CHECKPOINT FÁZE 8.7:** R03 a ROB-02 jsou lokálně uzavřeny. Dvě tabové instance mají scope lease, všechny offline requesty používají stabilní klíče, server má durable fail-closed ledger a raw uploady jsou svázané SHA-256. Retry je omezený a rozlišuje bezpečné, konfliktní a nejednoznačné výsledky. Typecheck, 355 hermetických aplikačních testů plus 5 environment guard testů, izolovaná PostgreSQL matice, obě migrační/rollback pojistky a production build prošly. Nebyl proveden push, deploy, produkční test ani produkční migrace. V tomto spuštění se nepokračuje do FÁZE 8.8 ani FÁZE 9.

- **další fáze:** FÁZE 8.8 – izolovaný řez R04: request/upload/object-storage ochrana.
- **doporučený model:** GPT-5.6 Sol
- **doporučený reasoning:** xhigh
- **důvod použití této úrovně:** změna zasáhne pořadí autentizace a body parserů, streaming limity, MIME/magic validaci, checksumy a lifecycle objektů; chyba může otevřít DoS, upload škodlivého obsahu, orphaned data nebo nekompatibilní metadata.
- **očekávané činnosti:** zmapovat všechny upload/decompression a object-storage vstupy; prokázat auth před nákladným parsingem; zavést per-route byte/time/decompression limity, MIME+magic validaci, skutečné dekódování podpisových obrázků, checksum/status metadata a quarantine/scanner hook; doplnit malformed/polyglot/ZIP-bomb/abort/orphan testy; připravit rollout a rollback bez mazání neznámých objektů.
- **soubory, které budou pravděpodobně změněny:** `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/storage.ts`, billing/document a signature upload routy, `artifacts/api-server/src/lib/fileSignature.ts`, `artifacts/api-server/src/lib/objectStorage.ts`, upload kontrakty/testy, případně `lib/db/src/schema/*`, `lib/db/migrations/*`, reverse-proxy/Coolify konfigurace a provozní runbook.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano. Může vyžadovat aditivní metadata migraci a řízený backfill checksumů/statusů. Quarantine, cleanup orphanů, změny limitů a proxy konfigurace jsou rizikové; žádné existující objekty se nesmí automaticky mazat ani označit za ověřené bez důkazu.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**.
