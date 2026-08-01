# Checkpoint FÁZE 8.1 – R00 a první implementační vlna R01

- **Stav:** FÁZE 8.1 dokončena; R00 je lokálně dokončen, R01 zůstává řízeně rozpracovaný. R02 ani FÁZE 9 nebyly zahájeny.
- **Výchozí revize:** `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f` (`main`).
- **Výsledná implementační revize:** `8ddea6d` (`main`); checkpoint je následný dokumentační commit. Vše zůstává pouze lokálně, nic nebylo pushnuto ani nasazeno.
- **Produkční zásah:** žádný. Nebyla načtena ani změněna produkční data, sessions, secrets, databáze, objekty ani konfigurace.

## 1. Implementované logické celky

| Commit | Workstream | Změna | Návrat |
|---|---|---|---|
| `f1bb210` | R00 | hermetický root release gate, explicitní API unit/DB příkazy, lokální DB target guard a GitHub Actions quality gate | revert commitu; bez datového dopadu |
| `da5e734` | R01 / SEC-02 | společný `regenerate → identita → save` helper pro heslový login, prvotní setup a WebAuthn login | revert commitu; existující sessions se nemění |
| `f5f6349` | R01 / SEC-01 | odstranění otázkové obnovy z API, UI, OpenAPI a klientů; lokální servisní reset admina přes stdin s audit eventem a revokací | revert commitu obnoví starý endpoint; nedoporučeno bez náhradního omezení |
| `8ddea6d` | R01 / SEC-03/04 | transakční advisory lock prvního admin setupu, atomická revokace sessions při změně hesla/deaktivaci a minimum 12 znaků pro nově nastavovaná hesla | revert commitu; žádná schema migrace ani backfill |

Servisní příkaz `auth:reset-admin-password` nebyl spuštěn, protože by měnil reálný účet a sessions. Heslo nepřijímá v argumentu příkazové řádky a nikdy je neloguje.

## 2. Bezpečnostní a provozní výsledek

- Výchozí API `test` už nepřebírá ambientní databázi; hermetický gate odmítá DB/provider secrets.
- DB test runner odmítá `DATABASE_URL`, produkční režim, vzdálený host a databázi bez samostatného `test`/`ci` segmentu. Vyžaduje explicitní `TEST_DATABASE_URL`.
- Veřejné endpointy bezpečnostních otázek, jejich UI a kontrakty již neexistují. Tabulka a historické řádky nebyly mazány.
- Heslový login, WebAuthn login i prvotní setup regenerují session před připojením identity a odpoví až po uložení nové session.
- První admin je vytvářen pod transakčním PostgreSQL advisory lockem; count a insert jsou v jedné transakci.
- Změna hesla nebo deaktivace maže cílové sessions podle `user_id` i `sess.userId`; vlastní měněná session je explicitně zničena a cookie vyčištěna.
- Nová hesla při setupu, vytvoření uživatele, administrátorské změně a servisním resetu vyžadují nejméně 12 znaků. Login zůstává kompatibilní se stávajícími kratšími hesly.

## 3. Provedené kontroly

Závěrečný `pnpm gate:release` nad `8ddea6d` prošel bez `DATABASE_URL` a provider secrets:

- root/library/API/PWA TypeScript typecheck: prošel;
- test guardu prostředí: 5/5;
- frontend Vitest: 4 soubory, 78/78;
- `live-events` Vitest: 1 soubor, 15/15;
- hermetický API Vitest: 22 souborů, 132/132;
- API production build: prošel;
- PWA production build a service worker: prošel; zůstává pouze známé upozornění na velké chunks.

Záměrně nebyly spuštěny DB-backed API testy, migrace, hlavní E2E, externí služby ani produkční smoke. Nebyla poskytnuta explicitní izolovaná `TEST_DATABASE_URL`; použití sdílené/produkční DB guard odmítá.

## 4. Neuzavřené otázky a rizika

1. R01 není uzavřen bez funkčního izolovaného PostgreSQL testu, který prokáže jediného prvního admina při souběhu a revokaci dvou skutečných session agents.
2. Souběžný request, který načetl session těsně před revokací, ji může teoreticky znovu uložit. Robustní řešení je session/credential generation kontrolovaná v `attachAuth`; vyžaduje aditivní migraci a izolovaný migrační test.
3. Nový GitHub Actions workflow je pouze lokálně validovaný; první vzdálený běh nebyl proveden.
4. Dormantní `security_questions` tabulka a historická data potřebují pozdější retenční/migrační rozhodnutí. Automatické mazání nebylo provedeno.
5. Servisní recovery vyžaduje dokumentovaný přístup oprávněného serverového operátora a dvouosobní nebo jinou organizační kontrolu; technické CLI samo právní/provozní proces nenahrazuje.
6. Produkční rollout musí předem oznámit odstranění self-service obnovy a možné záměrné odhlášení po změně hesla či deaktivaci.

## 5. Checkpoint a doporučení pro další spuštění

- **další fáze:** FÁZE 8.2 – dokončení R01; nejprve izolovaný DB důkaz, potom samostatné rozhodnutí o session-generation migraci. R02 zatím nezahajovat.
- **doporučený model:** GPT-5.6 Sol
- **doporučený reasoning:** xhigh
- **důvod použití této úrovně:** práce zasáhne session invariant při souběhu, PostgreSQL migraci, autentizační middleware a rollout, který může odhlásit všechny uživatele. Chyba může ponechat kompromitovanou session nebo naopak zablokovat přístup.
- **očekávané činnosti:** připravit ephemeral PostgreSQL pro cílené auth testy; otestovat paralelní setup, rotaci cookie a revokaci dvou agents; navrhnout `sessionVersion`/credential epoch expand migraci; ověřit upgrade i návrat/forward-fix; teprve po důkazu označit R01 dokončeno.
- **soubory, které budou pravděpodobně změněny:** `lib/db/src/schema/users.ts`, nová migrace a Drizzle metadata, `artifacts/api-server/src/middlewares/auth.ts`, `artifacts/api-server/src/lib/auth-session.ts`, auth/users routy, izolovaný DB runner a cílené auth DB testy, tento checkpoint a centrální roadmapa.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano. Předpokládaná migrace je aditivní, ale mění platnost všech sessions a rollout může záměrně odhlásit uživatele. Vyžaduje test na izolované DB, předem připravený recovery účet/postup, monitorování 401/login chyb a samostatný checkpoint před produkčním nasazením.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**. FÁZI 9 nezačínej, dokud nejsou dokončeny schválené implementační vlny FÁZE 8.
