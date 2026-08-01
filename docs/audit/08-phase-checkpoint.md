# Checkpoint FÁZE 8.5 – dokončení R02

- **Stav:** FÁZE 8.5 dokončena; R02 je lokálně implementováno a ověřeno. FÁZE 9 nebyla zahájena.
- **Výchozí revize:** `a302a44` (`main`; lokálně šestnáct commitů před `origin/main`).
- **Výsledná implementační revize:** `5b7dbb0` (`main`); dokumentační checkpoint je následující samostatný commit.
- **Produkční zásah:** žádný. Nebyla použita produkční DB, produkční secrets, `modvoltapp.cz` ani vzdálený Git; nic nebylo pushnuto ani nasazeno.
- **Migrace:** žádná.

## 1. Uzavřený rozsah

Poslední řez R02 nahradil implicitní permission fallback úplným source-driven manifestem. Generátor eviduje 397 unikátních kombinací HTTP metody, Express šablony a zdrojového route souboru. Runtime každou příchozí API cestu nejprve spáruje s manifestem a potom vyžaduje jednu z explicitních politik:

- přesná veřejná route;
- přihlášený uživatel bez modulového oprávnění pro vlastní session/preferences a delegovaný upload/download;
- všechna oprávnění `allOf`, případně alespoň jedno `anyOf`;
- jinak `403` s kódem `route_not_authorized`.

`HEAD` přebírá registraci a politiku odpovídajícího `GET`. Necatalogovaná metoda, near-miss cesta, budoucí endpoint pod známým prefixem i zcela nový modul selžou zavřeně. CORS preflight zůstává obsloužen před autentizací; samotná permission policy neznámý `OPTIONS` nepovolí.

Nezávislý kontrakt znovu čte route zdroje a vyžaduje přesnou shodu s generovaným manifestem. Selže při duplicitě, zastaralém manifestu i dynamické registraci `router.*(...)`, kterou generátor neumí bezpečně klasifikovat.

## 2. Nalezené a opravené mezery

1. `GET`, `HEAD` a `POST /api/ppe/confirm` byly podle frontendového toku, route komentáře a OpenAPI zamýšlené jako veřejné tokenové endpointy, ale v centrální public policy chyběly. Nyní jsou uvedeny explicitně; jiné metody a podobné cesty zůstávají privátní.
2. `GET /ppe/assignments/:id/signature` byl ve stejném routeru registrován dvakrát. První handler zastínil novější auditovanou variantu. Duplicitní registrace byla odstraněna a zachovaný handler používá nový handover dokument, se zpětně kompatibilním fallbackem na legacy `signatureObjectPath`.
3. Prefixy `/email-import`, `/events` a `/public-holidays` neměly ve staré modulové tabulce úplnou klasifikaci. Polling email importu nyní vyžaduje settings oprávnění; events a public holidays jsou explicitně authenticated-only.
4. Prefixový bypass `/api/preferences*` v `app.ts` byl odstraněn. Přesné preference routy jsou stále authenticated-only, ale budoucí near-miss už neobejde centrální policy.

## 3. Logické commity a návrat

| Commit | Změna | Návrat |
|---|---|---|
| `fbff6fa` | explicitní veřejná PPE confirmation policy, odstranění duplicitní signature route a zachování legacy fallbacku | samostatný revert; obnovil by chybné uzamčení veřejného potvrzení a zastíněný handler |
| `5b7dbb0` | generovaný manifest 397 rout, explicitní access policy, default-deny middleware a statické/DB kontrakty | samostatný revert; bez změny schématu, ale obnovil by implicitní permission fallback |

Commity neobsahují migraci ani změnu dat a lze je vracet samostatně. Bezpečnější oprava případné chybějící legitimní cesty je doplnit přesnou klasifikaci s kontraktem; neobnovovat obecný allow.

## 4. Provedené kontroly

### Manifest a cílené testy

- `pnpm codegen:api-route-manifest -- --check`: 397 unikátních registrací, manifest aktuální;
- public-route a route-access kontrakty: 47/47;
- navazující statické kontrakty citlivých job/billing workflow po přesunu policy: 31/31;
- API TypeScript typecheck a `git diff --check`: prošly.

### Izolovaný PostgreSQL 18

Jednorázový cluster běžel pouze na `127.0.0.1` v náhodném systémovém temp adresáři a portu. Ambientní `DATABASE_URL` byla odstraněna; po testu byly DB, server i temp adresář odstraněny.

- migration chain a forward → DOWN → forward: prošly;
- auth/session generation lifecycle: 4/4;
- vault a route-access API matice: 9/9;
- private-object DB/API matice: 17/17;
- použitá session generation dál blokuje destruktivní rollback migrace `0096`.

Route-access API testy prokázaly, že přihlášený full-access uživatel dostane `403 route_not_authorized` na necatalogované near-miss cesty, přesná `/api/sessions` funguje jako authenticated-only a nepřihlášené PPE confirmation requesty dojdou až k validaci veřejného tokenu.

### Hermetická release brána

Závěrečný `pnpm gate:release` nad `5b7dbb0` prošel bez DB a provider secretů:

- všechny TypeScript typechecky;
- test-environment guard 5/5;
- frontend 78/78;
- `live-events` 15/15;
- API unit/contract sada 25 souborů, 201/201;
- API production build;
- frontend production build, PWA a service worker.

Zůstalo pouze známé neblokující Vite upozornění na chunky `index` přibližně 824 kB a HEIC přibližně 1,35 MB. Produkční smoke, DAST, vzdálené CI a nasazení spuštěny nebyly.

## 5. Nejasnosti a zbytková rizika

1. Zdrojový manifest obsahuje 397 operací, OpenAPI 330. Po normalizaci názvů path parametrů odpovídají všechny dokumentované operace skutečné route, ale 67 registrovaných operací v OpenAPI chybí. Runtime ochrana je odvozena ze zdrojů, takže tento drift nevytváří autorizační bypass; zůstává však dluhem dokumentace a generovaného klienta.
2. Generátor záměrně podporuje jen literální `router.method("/path", ...)`. Kontrakt každou dynamickou registraci odmítne. Je to bezpečné selhání dostupnosti, ale při přidávání rout je nutné manifest regenerovat.
3. Default-deny může po nasazení odhalit dosud netestovaný legitimní tvar URL. Před produkčním enforcementem je nutný read-only soupis provozních tras, sledování `route_not_authorized` podle method/template bez citlivých parametrů a připravený revert.
4. Produkční object-path inventura, výkon přesných DB lookupů a vzdálený CI běh z předchozího řezu R02 nebyly v této fázi ověřeny.
5. Veřejná PPE confirmation route je nyní konzistentní se stávajícím kontraktem, ale expirace, revokace a immutable podpisový snapshot patří do R06.

## 6. Jednoznačný checkpoint a doporučení pro další spuštění

**CHECKPOINT FÁZE 8.5:** R02 je lokálně dokončeno. Všech 397 zdrojových API registrací má explicitní access policy, necatalogované routy selžou zavřeně a PPE veřejná hranice i duplicitní signature handler byly opraveny. Release gate a izolovaná DB/API matice prošly. Nebyl proveden push, deploy, produkční test ani migrace. V tomto spuštění se nepokračuje do FÁZE 8.6 ani FÁZE 9.

- **další fáze:** FÁZE 8.6 – první izolovaný řez R03: identity-safe PWA cache a offline fronta.
- **doporučený model:** GPT-5.6 Sol
- **doporučený reasoning:** xhigh
- **důvod použití této úrovně:** změna propojuje identitu session, Cache API, IndexedDB, service worker, více tabů a replay mutací; chyba může zobrazit nebo odeslat data pod jiným účtem.
- **očekávané činnosti:** zmapovat cache a offline queue lifecycle; zavést user/session scope; při logoutu nebo změně identity bezpečně vyčistit či oddělit cache; staré neidentifikované položky karanténovat místo replaye; navrhnout idempotency a cross-tab lease; doplnit logout/user-switch, retry a service-worker-update testy; spustit plný release gate.
- **soubory, které budou pravděpodobně změněny:** `artifacts/stavba/src/sw.ts`, `artifacts/stavba/src/lib/offline-queue.ts`, `artifacts/stavba/src/hooks/use-offline-queue.tsx`, `artifacts/stavba/src/hooks/use-auth.tsx`, související query/cache bootstrap a nové frontendové kontrakt/integration testy; backend pouze pokud bude pro bezpečný replay nutný idempotency endpoint.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** databázová migrace se v prvním řezu neočekává, ale může být nutná migrace browser storage. Změna je vysoce riziková pro lokální data, souběh a replay; legacy fronta se nesmí automaticky odeslat pod aktuální identitou.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**.
