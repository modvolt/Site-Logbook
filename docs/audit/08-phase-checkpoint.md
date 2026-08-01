# Checkpoint FÁZE 8.3 – první izolovaný řez R02

- **Stav:** FÁZE 8.3 dokončena; první řez R02 je lokálně implementován a ověřen. R02 jako celek ani FÁZE 9 dokončeny nejsou.
- **Výchozí revize:** `2957d32` (`main`; lokálně deset commitů před `origin/main`).
- **Výsledná implementační revize:** `8d3c4b9` (`main`); dokumentační checkpoint je následný samostatný commit.
- **Produkční zásah:** žádný. Nebyla použita produkční DB, produkční secrets, `modvoltapp.cz` ani externí provider; nic nebylo pushnuto ani nasazeno.
- **Migrace:** žádná.

## 1. Uzavřené nálezy a hranice řezu

Tento řez řeší dvě samostatné autorizační chyby:

1. **SEC-22:** globální prefix `/api/internal/*` obcházel autentizaci i permission middleware. Každá budoucí interní route by se tím stala veřejnou bez explicitního rozhodnutí.
2. **SEC-05:** zákaznické cesty k plaintext trezoru byly globálně mapovány jen na `customers.*` a následně chráněny rolí. Per-user deny override `credentials.view` nebo `credentials.manage` proto nemusel platit.

Záměrně nebyly řešeny zbývající části R02:

- **SEC-06:** WebAuthn step-up nyní propouští uživatele bez registrovaného credentialu a při DB chybě selhává otevřeně;
- **SEC-10:** generické stahování `/storage/objects/*` nemá spolehlivě doložené vlastnictví/účel objektu;
- úplný manifest všech chráněných rout s default-deny chováním; necatalogované routy stále používají dosavadní kompatibilní fallback.

## 2. Výsledná autorizační architektura

Po `attachAuth` rozhoduje jediná čistá policy funkce o veřejnosti requestu podle kombinace HTTP metody a normalizované cesty. Veřejný povrch tvoří pouze aktuální health/auth vstupy, public-object cesta, podpisové a quote/board tokenové cesty a přesný `POST /api/internal/backup-trigger`. Podobná cesta, jiná metoda nebo budoucí `/api/internal/*` je soukromá a projde `requireAuth`.

Interní backup trigger navíc používá limit 10 pokusů za 15 minut na instanci a bearer token porovnává přes SHA-256 digesty pomocí `timingSafeEqual`. Chybějící serverový secret dál vrací `503`, chybný token `401`.

Trezor skládá oprávnění ve dvou vrstvách:

| Operace | Oprávnění rodičovského modulu | Dodatečné oprávnění trezoru |
|---|---|---|
| seznam, audit view/export, odeslání plaintext exportu | `customers.view` nebo `customers.manage` podle route | `credentials.view` |
| vytvoření credentialu | `customers.view` + `customers.manage` | `credentials.manage` |
| změna a smazání credentialu | globální view guard nad credential modulem | `credentials.manage` |

Role už není náhradou za explicitní `credentials.*`. Allow/deny override se načítá pro každý request a deny proto platí i pro `master` uživatele.

## 3. Logické commity a návrat

| Commit | Změna | Návrat |
|---|---|---|
| `77422e6` | přesná public API policy; odstranění `/api/internal/*` prefixu; rate limit a časově bezpečný token backup triggeru; 29 kontraktových testů | samostatný revert; při návratu se znovu otevře původní fail-open interní prefix, proto je vhodnější forward-fix případné chybějící legitimní public route |
| `8d3c4b9` | explicitní `credentials.view/manage` na všech vault cestách, aktualizované OpenAPI výstupy a izolovaná DB/API negativní matice | samostatný revert; obnoví původní role-based bypass deny override, bez datové nebo migrační změny |

Změny lze vracet nezávisle. Žádný rollback nemění schéma ani data. Při hlášeném `401` na legitimní veřejné cestě se má nejprve doplnit přesná method/path výjimka s kontraktovým testem, nikoli vracet široký prefix.

## 4. Provedené kontroly

### Cílené kontroly

- API TypeScript a následně root TypeScript typecheck: prošly;
- explicitní public-route kontrakt: 1 soubor, 29/29 testů;
- OpenAPI codegen pro React klienta a Zod schémata: prošel;
- `git diff --check`: prošel.

### Izolovaný PostgreSQL 18

Jednorázový cluster běžel pouze na `127.0.0.1` v náhodném systémovém temp adresáři a portu. Ambientní `DATABASE_URL` byla odstraněna; runner přijal pouze explicitní loopback `TEST_DATABASE_URL` s testovacím názvem. Po sadě byla náhodná DB odstraněna, server zastaven a temp adresář smazán.

- migration chain a forward → DOWN → forward: prošly;
- stávající auth/session lifecycle: 4/4;
- nový skutečný DB/API test R02: 5/5;
- `credentials.view` deny zablokoval seznam, oba auditní vstupy a odeslání exportu;
- `credentials.manage` deny ponechal čtení, ale zablokoval create/patch/delete;
- deny `customers.*` zablokoval customer-scoped vault i při povolených `credentials.*`;
- neznámá a wrong-method interní cesta bez session vrátila `401`;
- přesný backup trigger byl veřejně dosažitelný, ale chybný bearer vrátil `401`;
- použitá session generation dál správně blokovala destruktivní rollback migrace `0096`.

### Hermetická release brána

Závěrečný `pnpm gate:release` nad `8d3c4b9` prošel bez DB a provider secretů:

- všechny TypeScript typechecky: prošly;
- guard testovacího prostředí: 5/5;
- frontend: 78/78;
- `live-events`: 15/15;
- API unit/contract sada: 23 souborů, 162/162;
- API production build: prošel;
- frontend production build, PWA a service worker: prošly.

Zůstává známé neblokující Vite upozornění na velké chunky (`index` přibližně 824 kB a HEIC přibližně 1,35 MB). Produkční smoke, DAST, remote CI, migrace a nasazení záměrně spuštěny nebyly.

## 5. Nejasnosti a zbytková rizika

1. Aktuální WebAuthn step-up nemá bezpečný password fallback pro uživatele bez biometrického credentialu. Pouhé přepnutí na fail-closed by mohlo legitimní uživatele z trezoru uzamknout.
2. Objektové cesty nemají jednotné owner/domain metadata. Před vynucením vlastnictví je nutná inventura existujících object paths a rozhodnutí, zda stačí deterministická vazba z doménových tabulek, nebo bude potřebná aditivní metadata migrace a backfill.
3. Globální permission middleware stále připouští kompatibilní fallback pro necatalogované routy. Úplný default-deny manifest musí nejprve prokázat pokrytí legitimních interních workflow, jinak hrozí plošné `403`.
4. Rate limiter backup triggeru používá procesový store; při více API instancích je limit per-instance. Secret musí zůstat vysokoentropický a rotovatelný.
5. Přísnější deny override může nově odhalit nekonzistentní produkční konfiguraci oprávnění. Před rolloutem je vhodný read-only přehled dotčených uživatelů a monitorování nových `401/403`, nikoli automatická úprava jejich oprávnění.

## 6. Jednoznačný checkpoint a doporučení pro další spuštění

**CHECKPOINT FÁZE 8.3:** lokální implementace SEC-22 a SEC-05 je dokončena a ověřena. R02 zůstává otevřené kvůli SEC-06, SEC-10 a úplnému default-deny route manifestu. Nebyl proveden push, deploy, produkční test ani migrace. V tomto spuštění se nepokračuje do dalšího řezu ani FÁZE 9.

- **další fáze:** FÁZE 8.4 – druhý izolovaný řez R02: fail-closed vault step-up (SEC-06) a objektové vlastnictví souborů (SEC-10); pokud inventura potvrdí velký rozsah, rozdělit na 8.4a a 8.4b s checkpointem mezi nimi.
- **doporučený model:** GPT-5.6 Sol
- **doporučený reasoning:** xhigh
- **důvod použití této úrovně:** návrh musí současně zabránit fail-open při DB chybě, zachovat obnovitelný přístup bez WebAuthn a odvodit vlastnictví historických objektů bez IDOR nebo plošného uzamčení legitimních downloadů.
- **očekávané činnosti:** zmapovat WebAuthn/password step-up stav a všechny konzumenty privátních object paths; navrhnout fail-closed recovery tok; vytvořit owner/domain inventuru a negativní wrong-owner matici; teprve poté implementovat nejmenší bezpečný řez s izolovaným DB/storage testem, rollout metrikou a rollbackem.
- **soubory, které budou pravděpodobně změněny:** `artifacts/api-server/src/middlewares/auth.ts`, vybrané auth/WebAuthn a storage/download routy, `artifacts/api-server/src/lib/objectStorage.ts`, příslušné frontend vault komponenty, DB schémata/migrace pouze pokud inventura prokáže potřebu owner metadata, cílené authorization/storage testy, roadmapa a tento checkpoint.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano. Objektové vlastnictví může vyžadovat aditivní owner/domain metadata a restartovatelný backfill; fail-closed step-up může způsobit lockout nebo nové `403`. Případná migrace musí být expand-only, mít dry-run/reconciliation, izolovaný forward test a samostatný rollout/rollback checkpoint.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**.
