# Checkpoint FÁZE 8.6 – první izolovaný řez R03

- **Stav:** FÁZE 8.6 dokončena; identity-safe cache a offline fronta jsou lokálně implementované a ověřené. R03 jako celek zůstává rozpracovaný a FÁZE 8.7 ani FÁZE 9 nebyly zahájeny.
- **Výchozí revize:** `2c05eba` (`main`; lokálně devatenáct commitů před `origin/main`).
- **Implementační revize:** `71bf9d8`, `7e9d819` (`main`; lokálně dvacet jedna commitů před `origin/main`). Dokumentační checkpoint následuje jako samostatný commit.
- **Produkční zásah:** žádný. Nebyla použita produkční DB, produkční secrets, `modvoltapp.cz` ani vzdálený Git; nic nebylo pushnuto ani nasazeno.
- **Databázová migrace:** žádná.
- **Browser storage migrace:** IndexedDB `stavba-offline-v1` se aditivně povyšuje z verze 1 na 2. Původní stores zůstávají jako nečtená karanténa; nové vlastněné záznamy používají oddělené stores.

## 1. Uzavřený rozsah

### Serverová identita a atomická replay hranice

`GET /api/auth/me` po přihlášení vrací `offlineScope`: SHA-256 nad kanonickým `userId`, `sessionGeneration`, rolí a výslednou sadou oprávnění. Nejde o session secret ani autorizační token; je to neprůhledný identifikátor identity/autorizační epochy. Stejný uživatel se stejnou epochou může po opětovném přihlášení obnovit vlastní frontu, zatímco změna uživatele, revokace session generation, role nebo oprávnění scope otočí.

Všechny `/api` odpovědi dostávají `Cache-Control: private, no-store`. Replay mutace navíc posílají `X-Stavba-Offline-Scope`. Middleware hlavičku porovná s identitou aktuální cookie session ještě před permission policy a handlerem. Nesoulad končí `409 offline_scope_mismatch`, takže ani změna účtu mezi klientskou kontrolou a samotným zápisem nemůže provést operaci pod jinou identitou.

### Service worker a Cache Storage

Původní globální cache `stavba-api`, která zachytávala každý úspěšný API GET, byla odstraněna. Nový service worker:

- ukládá jen explicitní same-origin allowlist terénních read modelů zakázek a rozvaděčů;
- nikdy necachuje auth, sessions, trezor, billing, storage objekty, events ani neznámé budoucí API cesty;
- přijímá jen HTTP `200` odpovědi a používá cache `stavba-api-v2-<scope>`;
- bez potvrzeného scope obsluhuje požadavek pouze ze sítě s `cache: no-store`;
- při aktivaci odstraní legacy cache, při změně identity nebo logoutu odstraní ostatní managed cache.

### IndexedDB a lifecycle identity

IndexedDB v2 ukládá každou operaci a fotografický blob pod složený klíč scope + lokální ID a eviduje `ownerUserId` i `ownerScope`. Čtení, update, delete i replay vyžadují vlastníka. Stejné lokální ID proto může existovat ve více partitions bez kolize a jiný uživatel jeho payload nedostane.

Původní v1 stores `ops` a `blobs` se zachovávají beze změny, ale runtime z nich čte pouze počty. Jejich payload se nezobrazuje a nikdy automaticky nereplayuje. Banner informuje o uzamčených nebo legacy položkách.

Před každým flush klient provede live `/api/auth/me` s `cache: no-store` a porovná user ID i scope. 401 nebo mismatch frontu skryje, obnoví auth stav a nic neodešle. Každý následný write je ještě svázán serverovou replay hlavičkou. Login před autentizací čistí API cache; logout upozorní na vlastní neodeslané akce, po potvrzení je ponechá uzamčené pro stejnou epochu a vyčistí cache, query data i timer notifikaci. Každá 401 z generovaného klienta také invaliduje auth a cache.

## 2. Stav nálezů

| Nález | Stav po FÁZI 8.6 | Důkaz |
|---|---|---|
| SEC-08 | uzavřen lokálně | globální API cache nahrazena explicitním same-origin allowlistem a per-scope cache; citlivé a neznámé cesty jsou network-only |
| SEC-09 | uzavřen lokálně | fronta i bloby mají vlastníka; live kontrola a atomická serverová scope vazba brání replayi pod jiným účtem |
| GDPR-07 | uzavřen lokálně | logout/identity rotation odstraňuje API cache a cizí/legacy IndexedDB payload není dostupný aktuální identitě |
| ROB-01 | uzavřen lokálně | stará bezejmenná fronta je karanténovaná a nová data jsou partitioned podle serverové epochy |
| ROB-02 | otevřen | stále chybí lease mezi taby, úplná serverová idempotence a bounded backoff/conflict klasifikace |

R03 je proto **částečně dokončen**, nikoli uzavřen.

## 3. Logické commity a návrat

| Commit | Změna | Návrat |
|---|---|---|
| `71bf9d8` | serverem odvozený offline scope, `no-store` API, replay middleware, OpenAPI/generované typy a API/DB kontrakty | samostatný revert odstraní serverovou vazbu; nesmí být proveden před frontendovým revertem, protože nový klient na tuto ochranu spoléhá |
| `7e9d819` | same-origin per-scope PWA cache, IndexedDB v2, identity verification, bezpečný logout a frontendové regrese | kód lze vrátit samostatně až po návratu serverové změny; zařízení s DB verzí 2 pak fail-closed odmítnou otevření starým v1 klientem, takže rollback musí ponechat kompatibilní DB version nebo vypnout offline frontu |

Aditivní browser migrace nemaže legacy data. Návrat nevyžaduje produkční SQL, ale musí počítat s již vytvořenými IndexedDB v2 stores a s aktualizací service workeru na zařízeních.

## 4. Provedené kontroly

### Cílené a statické kontroly

- workspace TypeScript typecheck: prošel;
- frontend cache/IndexedDB/replay testy: 3 soubory, 29/29;
- API identity/replay kontrakty: 2 soubory, 9/9;
- `git diff --check`: prošel.

### Izolovaný PostgreSQL 18

Jednorázový cluster běžel pouze na `127.0.0.1` v náhodném systémovém temp adresáři a portu. Ambientní `DATABASE_URL` byla odstraněna. Po testu byly dočasná DB, PostgreSQL server i celý ověřený temp adresář odstraněny.

- migration chain a forward → DOWN → forward: prošly;
- auth/session generation lifecycle: 4/4;
- vault, route-access a nový `/auth/me` offline scope/replay kontrakt: 10/10;
- private-object DB/API matice: 17/17;
- použitá session generation dál blokuje destruktivní rollback migrace `0096`.

DB test potvrdil stabilní scope stejné identity napříč novou login session, odlišný scope jiného uživatele, přijetí správné replay hlavičky a odmítnutí nesprávné hlavičky bez provedení handleru.

### Hermetická release brána

Závěrečný `pnpm gate:release` prošel bez DB a provider secretů:

- všechny TypeScript typechecky;
- test-environment guard 5/5;
- frontend 7 souborů, 107/107;
- `live-events` 15/15;
- API unit/contract sada 27 souborů, 210/210;
- API production build;
- frontend production build, PWA inject manifest a nový service worker build.

Na Windows bylo pro samotné spuštění brány nutné dočasně použít Node ekvivalent kořenového Unix `sh` preinstallu a doplnit přesně verzované Windows native bindingy esbuild, Rollup, Lightning CSS a Tailwind Oxide. Všechny tyto dočasné manifest/lock změny byly před commitem odstraněny; výsledný lock přidává pouze testovací `fake-indexeddb`.

Zůstala známá neblokující Vite upozornění na chunky `index` přibližně 831 kB a HEIC přibližně 1,35 MB. Produkční smoke, DAST, vzdálené CI, skutečný dvoutabový browser test a nasazení spuštěny nebyly.

## 5. Nejasnosti a zbytková rizika

1. ROB-02 zůstává otevřený. Dvě taby nemají sdílený lease a mohou současně načíst stejnou partition. Některé operace mají idempotency key, ale `add_material`, změna spotřeby, nastavení hodin a část photo registration nemají jednotný durable serverový ledger.
2. HTTP 401/409 vzniklé až během jednotlivé mutace bezpečně neprovedou cizí zápis, ale současný klient je klasifikuje jako obecný retry. FÁZE 8.7 musí zavést explicitní auth/conflict/transient stavy, bounded exponential backoff a bezpečné ruční obnovení.
3. Legacy v1 payload zůstává na zařízení v karanténě bez recovery/export/delete UI. Banner ukazuje pouze počet. Automatické přiřazení aktuálnímu uživateli je zakázané, protože původního vlastníka nelze prokázat.
4. Povolený terénní dataset je stále uložen lokálně jako plaintext browser storage. Partition a logout purge brání záměně účtu v aplikaci, ale neřeší kompromitované nebo ztracené BYOD zařízení, šifrování at rest ani vzdálený wipe.
5. Explicitní cache allowlist může zpočátku vynechat legitimní offline read cestu. Rozšiřovat jej lze jen po revizi datového obsahu a oprávnění; nevracet obecné `/api/*` cachování.
6. Scope je záměrně epocha identity/oprávnění, ne unikátní ID každé login session. Stejný uživatel může po běžném znovupřihlášení obnovit vlastní práci; revokace session generation nebo změna oprávnění ji uzamkne.
7. Unit/contract a skutečná API DB sada pokrývají user switch a karanténu, ale ještě chybí reálný browser E2E scénář se dvěma účty, dvěma taby, restartem service workeru a offline/online přechodem.

## 6. Jednoznačný checkpoint a doporučení pro další spuštění

**CHECKPOINT FÁZE 8.6:** SEC-08, SEC-09, GDPR-07 a ROB-01 jsou lokálně uzavřeny. Cache i nová offline data jsou oddělené podle serverové identity/autorizační epochy, legacy fronta se nereplayuje a server atomicky odmítne mutaci se scope jiné epochy. Typecheck, cílené testy, izolovaná PostgreSQL matice i úplná release brána prošly. R03 zůstává otevřený pouze v následujícím samostatném concurrency/idempotency řezu. Nebyl proveden push, deploy, produkční test ani SQL migrace. V tomto spuštění se nepokračuje do FÁZE 8.7 ani FÁZE 9.

- **další fáze:** FÁZE 8.7 – druhý izolovaný řez R03: cross-tab lease, jednotná idempotence a řízené retry/conflict stavy.
- **doporučený model:** GPT-5.6 Sol
- **doporučený reasoning:** xhigh
- **důvod použití této úrovně:** změna propojí souběh více tabů, durable serverovou deduplikaci, transakční hranice doménových zápisů a bezpečné zotavení po nejednoznačném výsledku; chyba může vytvořit duplicitu nebo potlačit legitimní operaci.
- **očekávané činnosti:** zmapovat idempotency pokrytí všech offline typů; navrhnout cross-tab lease s expirací a takeoverem; doplnit durable idempotency registry nebo přesné doménové unique invarianty; klasifikovat auth/conflict/transient chyby; zavést bounded backoff; otestovat dvě taby, přerušenou odpověď, retry po timeoutu, logout/user switch a service-worker update.
- **soubory, které budou pravděpodobně změněny:** `artifacts/stavba/src/lib/offline-queue.ts`, `artifacts/stavba/src/hooks/use-offline-queue.tsx`, nové browser/concurrency testy, API middleware nebo služby zapisujících rout, `lib/db/src/schema/*`, `lib/db/migrations/*` a případně OpenAPI/generované klienty.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano. Pravděpodobná je aditivní DB migrace pro durable idempotency ledger a případně další browser storage verze pro lease metadata. Jde o vysoce rizikovou změnu souběhu a replay semantics; vyžaduje izolované PostgreSQL concurrency testy, browser multi-tab testy a předem ověřený rollback.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**.
