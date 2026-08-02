# Checkpoint FÁZE 8.13 – dokončení kritických oprav

- **Stav:** FÁZE 8 je lokálně dokončena; poslední R07 je implementován v commitu `7510a9c`.
- **Rozsah:** uzavřené jsou R00–R07 podle prioritizační roadmapy. Tento běh provedl pouze R07 a závěrečné ověření jeho návazností.
- **Produkce:** žádný přístup k produkční DB, secrets ani `modvoltapp.cz`; žádný push ani deploy.
- **Migrace:** R07 nepřidal databázovou migraci.
- **Souběžná práce:** UI preference, redesign, migrace `0100` a jejich generované výstupy nebyly zahrnuty do commitu.

## Co uzavřel R07

1. Webový nginx načítá jednotný CSP a bezpečnostní hlavičky pro SPA, statické assety, service worker i proxované API. CSP blokuje framing a objekty, omezuje zdroje na skutečně používané originy a zachovává blob/data workflow pro dokumenty, obrázky a workery.
2. API Helmet už CSP nevypíná; JSON a objektové odpovědi dostávají deny-all aktivní obsah a `frame-ancestors 'none'`.
3. SMTP s `secure=false` povinně vyžaduje STARTTLS; SMTP i IMAP ověřují CA, odmítají neplatný certifikát a vyžadují TLS 1.2+. IMAP na neimplicitním TLS portu už nesmí pokračovat v plaintextu.
4. Nodemailer navíc blokuje dereferenci lokálních souborů a URL v generovaných zprávách.
5. Sdílené CSV encodery na backendu a frontendu neutralizují `=`, `+`, `-` a `@` i po počátečních whitespace/control znacích. Skutečná číselná data zůstávají číselná.
6. Opraveny byly exporty dovolených, OOPP, statistik a rozvaděčů. Testovací korpus pokrývá `=WEBSERVICE`, leading space, tab i CR varianty.
7. Přímé závislosti byly cíleně aktualizovány: `nodemailer 9.0.3`, `fast-xml-parser 5.10.1`, `@google-cloud/storage 7.21.0` a oficiální SheetJS tarball `0.20.3`. Patch overrides opravují zranitelné `body-parser`, `dompurify`, `form-data`, `qs` a vnořený `fast-xml-parser`.
8. Produkční dependency audit je bez High/Critical. Zůstává jeden Moderate advisory `uuid` hluboko pod Google Storage; postižené v3/v5/v6 API s caller-supplied bufferem není v mapovaném storage workflow používáno. Major override by byl rizikovější než evidovaný reachability stav a patří do následné správy závislostí.
9. Interní backup trigger už před R07 používal přesnou method/path veřejnou výjimku, vlastní limiter a timing-safe bearer porovnání. R07 znovu ověřil, že neznámá nebo metodou odlišná `/api/internal/*` cesta zůstává za session autentizací.

Tím jsou lokálně uzavřeny `SEC-16`, `SEC-17`, `SEC-19`, `SEC-20` a `SEC-22`. Spolu s předchozími checkpointy je FÁZE 8 implementačně dokončena.

## Provedené kontroly

| Kontrola | Výsledek |
|---|---:|
| Supply-chain politika lockfile | prošla, 1028 produkčních/dev záznamů před testovacími platformními doplňky |
| `pnpm audit --prod --audit-level high` | prošel; 0 Critical, 0 High, 1 Moderate |
| Čistá fyzická instalace opravených verzí | potvrzeno: Nodemailer 9.0.3, fast-xml-parser 5.10.1, SheetJS 0.20.3, body-parser 2.3.0, DOMPurify 3.4.12 |
| API security, CSP, interní route, CSV, TLS a XML kontrakty v čistém stromu | 5 souborů, 67/67 testů |
| Frontend CSV kontrakt v čistém stromu | 1 soubor, 6/6 testů |
| API a frontend TypeScript v hlavním i čistém stromu | bez chyb |
| Produkční API build v hlavním i čistém stromu | úspěšný |
| Produkční Vite/PWA build v hlavním i čistém stromu | úspěšný; čistý build 4001 modulů, 222 precache položek |
| Úplný API unit/contract gate v hlavním stromu | 285/286; jediný cizí pád popsán níže |
| `git diff --check` a staged izolace | bez chyb; v commitu pouze 21 R07 souborů |

Úplný API gate má jediný nesouvisející neúspěch `field-job-workflow-contract.test.ts`: kontrakt očekává starou field navigaci `[/, /calendar, /jobs, /me]`, zatímco souběžný necommitovaný redesign přidal další cesty. R07 kontrakty i čistý strom prošly; cizí navigace nebyla opravována ani commitována.

## Nevyřešené otázky a provozní rizika

1. Změny nejsou nasazené. CSP je nutné při rollout sledovat zejména na PDF/blob náhledech, QR/kameře, geolokaci, PWA instalaci/offline režimu a volání Nominatim.
2. Starý mail server bez STARTTLS nebo s nedůvěryhodným certifikátem po správně fail-closed změně přestane fungovat; před rolloutem je nutný test SMTP i IMAP proti produkční konfiguraci bez zveřejnění secrets.
3. Jeden Moderate `uuid` advisory zůstává evidovaný. Přechod celé Google Storage větve na kompatibilní major musí být samostatně otestován, nikoli vynucen slepým override.
4. Lokální OneDrive `node_modules` obsahoval uzamčené staré junctions, proto úplné fyzické ověření proběhlo v čistém temp stromu. Zdrojový lockfile je konzistentní a čistá instalace balíčky stáhla; temp strom byl po ověření bezpečně odstraněn.
5. Produkční migrace `0101`/`0102`, legacy token cutover, object-storage integrace, monitoring a restore drill z předchozích R položek nebyly v R07 provedeny. Patří do řízeného rollout plánu a závěrečného ověření.
6. Existující chunk warningy nad 500 kB přetrvávají; nejde o regresi R07, ale mají být uvedeny v závěrečném hodnocení výkonu a PWA.

## Jednoznačný checkpoint

**CHECKPOINT FÁZE 8.13 / KONEC FÁZE 8:** Kritické opravy R00–R07 jsou lokálně implementované. Poslední R07 uzavírá web/API security headers, fail-closed TLS pošty, CSV formula injection, High dependency advisories a explicitní interní route perimetr. Nové závislosti byly ověřeny v čisté instalaci, cílené kontrakty, typechecky a produkční buildy prošly. Produkce, remote, DB a secrets zůstaly nedotčené. Další práce musí být samostatná FÁZE 9 – závěrečné ověření; v tomto checkpointu nebyla zahájena.

- **další fáze:** FÁZE 9 – závěrečné ověření a dokument `docs/audit/08-final-verification.md`.
- **doporučený model:** GPT-5.6 Sol.
- **doporučený reasoning:** xhigh.
- **důvod použití této úrovně:** fáze musí spojit bezpečnostní, databázové, offline/PWA, podpisové, e-mailové, upload/download a backup/restore důkazy, rozlišit skutečný regresní problém od omezení prostředí a vytvořit obhajitelné skóre 0–100 bez dojmového hodnocení.
- **očekávané činnosti:** úplný typecheck/lint/unit/integration/security/build gate; čistý test migračního řetězce; izolované workflow pro PWA offline, upload/download, podpis, testovací e-mail a backup/restore; evidence neproveditelných kontrol; finální manažerské shrnutí, skóre a plán 30/90/180 dní.
- **soubory, které budou pravděpodobně změněny:** primárně nový `docs/audit/08-final-verification.md` a tento checkpoint; případně pouze testovací konfigurace nebo izolované testy, pokud chybí potřebný ověřovací harness. Produkční kód se ve verifikační fázi nemá měnit bez nového nálezu a samostatného rozhodnutí.
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** nemá vytvářet novou produkční migraci, ale musí v izolovaném prostředí spustit celý migrační řetězec a restore workflow. Rizikové jsou testy obnovy, e-mailu, offline cache a podpisů; musí používat testovací DB/storage/účty, nikdy produkční secrets ani `modvoltapp.cz`.

Před pokračováním nastav doporučený model/reasoning v rozhraní a výslovně napiš **„Pokračuj další fází“**. Teprve nový běh smí založit cíl dokončení FÁZE 9 a zahájit její kontroly.
