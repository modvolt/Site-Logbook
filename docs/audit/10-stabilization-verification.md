# FÁZE 10 – předprodukční stabilizační ověření

> **Stav:** dokončeno lokálně dne 2026-08-02
> **Výchozí commit:** `2089810` (`docs: complete phase 9 verification`)
> **Rozsah:** VER-01, VER-02, VER-04, VER-05 a VER-06
> **Produkce:** nedotčena; bez produkční DB, secretů, bucketu, mailu, browser session, deploye a push

## 1. Výsledek

Stabilizační vlna odstranila červený celý API DB strom, zavedla deterministickou izolaci jednotlivých suites, opravila potvrzenou kolizi pracovních sessions a locale-dependent skladové párování, zpřísnila restore validaci, provedla lokální DB+object restore drill a zavedla lint/peer/dependency gate. Všechny povinné lokální kontroly jsou zelené.

Tento výsledek není souhlas s produkčním nasazením. Produkční object backup, off-site/immutable kopie, schválené RPO/RTO, recovery key custody, staging browser E2E a release canary zůstávají provozními podmínkami mimo tento lokální běh.

| Registr | Stav po FÁZI 10 | Hlavní důkaz |
| --- | --- | --- |
| VER-01 – nedeterministický DB gate | **uzavřeno** | 137/137 souborů, každý nad vlastním disposable DB klonem; po běhu 0 klonů |
| VER-02 – červené invarianty | **uzavřeno pro aktuální kontrakt** | scheduler, work sessions, warehouse, time-entry a devět dříve červených suites cíleně i v celém stromu zelené |
| VER-04 – neprovedený restore drill | **lokálně uzavřeno; produkční DR governance otevřená** | 6/6 aktivních restore kontrol, 13/13 objektů obnovených se shodným SHA-256, nenulové DB fixtures a shodné source/restore počty |
| VER-05 – dependency advisory | **uzavřeno pro Moderate+** | produkční graf 0 advisory; celý graf 0 Critical/High/Moderate, 1 Low dev-only výjimka |
| VER-06 – lint a peer gate | **uzavřeno** | `gate:quality` PASS; 0 peer problémů, ESLint PASS |

## 2. Deterministický databázový gate

`scripts/run-safe-test-db.mjs` nyní:

- přijímá pouze lokální `TEST_DATABASE_URL` se zřetelným `test`/`ci` segmentem a odmítne ambientní `DATABASE_URL`;
- založí migrovanou template DB a pro každý z 137 testovacích souborů vytvoří samostatný klon;
- spouští Vitest sekvenčně s jedním workerem;
- vždy odstraní suite DB i template DB, včetně chybové cesty;
- odstraňuje provider/secrets a restore side-effect flagy z child environment;
- nastavuje pouze explicitní testovací guardy a neprodukční secrets potřebné testy.

CI workflow dostal PostgreSQL 18 service, `gate:quality`, hermetický release gate a celý izolovaný API DB gate. Workflow YAML nebyl odeslán ani spuštěn na GitHubu; lokálně byl ověřen stejný runner a všechny jeho kroky.

## 3. Uzavření červených invariantů

### Potvrzené implementační opravy

- `work-session-service.ts`: overlap dotaz již neposílá netypovaný raw výraz s datem; aktivní session porovnává přes `isNull(endedAt) OR endedAt > startedAt`.
- `warehouse-service.ts`: názvy skladových položek se normalizují `trim` + Unicode NFKC + lowercase a párují se deterministicky v JavaScriptu, nezávisle na PostgreSQL locale `C`.
- `ppe.ts`: signatura se načte před odesláním image headers; chybějící objekt vrací korektní JSON 404 a audit view je best-effort až po úspěšném načtení.
- `backup.ts`: restore test odmítne každý nenulový `pg_restore` exit, chybu čtení ověřované tabulky již nemění na nulu a kontroluje unvalidated constraints i invalid indexes.

### Opravené testovací kontrakty a fixtures

- scheduler concurrency test používá bariéry místo časového závodu;
- legacy time-entry stop scénáře používají autoritativní `work_sessions` a idempotentní stop bez aktivní session;
- activity billing testy mají korektní serializaci a izolované object-storage mocky;
- forensic permission fixture obsahuje nově vyžadované `statistics.view` + `billing.view` a platný job kontrakt;
- PPE storage test používá aktuální typed-only prefix export;
- recurring invoice test ověřuje unikátnost po template+period místo falešného globálního „právě jeden“;
- review queue používá skutečný job fixture;
- vault suite dostává pouze explicitní bezpečný testovací backup trigger secret.

## 4. DB + object restore drill

Drill běžel výhradně na `127.0.0.1` proti jednorázové DB `phase10_test_restore` a bucketu `modvolt-phase10-test`. MinIO community server `RELEASE.2025-09-07T16-13-09Z` byl stažen z oficiálního download serveru a ověřen proti oficiálnímu SHA-256:

`af709e6ba68488404e85acdd22a3030d0f5e56a108d4b27d744f18ceb50861b4`

Test vyžaduje současně:

- `NODE_ENV=test`;
- `BACKUP_RESTORE_TEST_ENABLED=true`;
- `BACKUP_RESTORE_TEST_CONFIRM_ISOLATED=true`;
- loopback PostgreSQL i S3 endpoint;
- DB a bucket se segmentem `test`;
- `S3_FORCE_PATH_STYLE=true`;
- pro object část navíc `FULL_OBJECT_RESTORE_TEST_ENABLED=true`.

Průběh:

1. Do šesti ověřovaných tabulek byly vloženy platné nenulové fixtures.
2. Do všech 12 chráněných object prefixů byl vložen unikátní canary.
3. Aplikace vytvořila šifrovaný PostgreSQL custom dump a uložila jej jako třináctý objekt.
4. Všech 13 objektů bylo zapsáno do samostatného recovery manifestu s velikostí a SHA-256.
5. Testované objekty byly odstraněny a jejich nedostupnost potvrzena 13/13.
6. Recovery bundle obnovil 13/13 objektů; každý obnovený hash souhlasil.
7. Aplikace načetla obnovený šifrovaný dump, ověřila jeho hash/envelope a provedla `pg_restore` do nové temp DB.
8. Počty `jobs`, `customers`, `users`, `people`, `materials` a `activities` přesně odpovídaly zdroji a byly větší než nula.
9. Výsledek `restoreStatus=ok` byl uložen a test po sobě odstranil temp DB, fixtures, backup log i objekty.

Výsledek: 6/6 aktivních testů prošlo, 1 dokumentační skip větev byla správně přeskočena; po drillu zůstalo 0 restore temp DB a 0 objektů v test bucketu.

### Omezení důkazu

Drill prokazuje, že aplikace umí obnovit DB dump a že externí recovery bundle umí obnovit reprezentanty všech chráněných object tříd. Nezavádí automatické produkční zrcadlení bucketu, versioning, Object Lock, jiný účet/provider, WAL/PITR ani úschovu recovery klíčů. Tyto části R08 a konkrétní RPO/RTO musí být dokončeny a schváleny provozně.

## 5. Dependency, peer a lint gate

Aktualizováno nebo bezpečně vynuceno:

- Vite `7.3.5`, esbuild `0.28.1`;
- `uuid 11.1.1`, `markdown-it 15.0.0`, `linkify-it 5.0.2`;
- `js-yaml 4.3.0`, `fast-uri 3.1.4`, `postcss 8.5.18`;
- `brace-expansion 2.1.3` a `5.0.9` podle major větve;
- `@zxing/browser 0.2.1` s kompatibilním peerem `@zxing/library 0.23.0`.

`orval` codegen i následný library typecheck prošly, čímž je ověřen také major override `markdown-it`. Produkční build prošel s Vite 7.3.5 a barcode scanner buildem po ZXing patchi.

Jediný zbytkový auditní nález je Low dev-only advisory `@babel/core <=7.29.0`. Registry doporučuje 7.29.1, ale tato verze není publikovaná; jediná vyšší dostupná verze je nekompatibilní major 8.0.1. Vynucení Babel 8 pod Vite React pluginem bylo odmítnuto jako rizikovější než evidovaný Low build-time nález. `gate:quality` proto failuje od úrovně Moderate.

ESLint baseline kontroluje celý JS/TS/TSX strom a zaměřuje se na syntaktickou a řídicí korektnost plus React Rules of Hooks. Záměrně zatím není type-aware promise/security/import-boundary policy; tu lze rozšiřovat postupně bez stovek plošných kosmetických změn.

## 6. Souhrn kontrol

| Kontrola | Výsledek |
| --- | --- |
| `gate:quality` | PASS; lint 0, peers 0, audit 0 Moderate/High/Critical, 1 Low |
| `pnpm audit --prod` | PASS; 0 advisory všech úrovní |
| hermetický release gate | PASS; typecheck, 5/5 guardů, 127/127 frontend, 15/15 live-events, 286/286 API unit/security |
| API build | PASS; server + migration bundle |
| PWA build | PASS; Vite 7.3.5, 4 013 modulů, 222 precache položek |
| API DB gate | PASS; 137/137 souborů, 102/102 migrací, 524,8 s |
| full restore drill | PASS; 6/6 aktivních, 13/13 object hash round-trip, shodné nenulové DB počty |
| API codegen | PASS; Orval 8.9.1 + library typecheck |
| `git diff --check` | PASS |
| úklid runner/restore DB | PASS; 0 klonů a 0 restore temp DB |

## 7. Zbytkové otázky a rollout hranice

- Není potvrzeno, že produkce automaticky zálohuje celý bucket do nezávislé immutable/off-site hranice.
- Nejsou schváleny konkrétní RPO/RTO, vlastník obnovy, dual control a recovery key custody.
- Nebyl proveden staging browser E2E pro login, upload/download, podpis, PWA user switch/offline replay, mail sandbox a rollback canary.
- GitHub Actions workflow nebyl bez push spuštěn na remote runneru.
- Právní retence, DSAR/hold/erase a důkazní požadavky z předchozího auditu zůstávají mimo FÁZI 10.
- Uživatelský rozpracovaný redesign, preference migrace a další dirty-tree soubory nebyly zahrnuty do phase10 commitu ani měněny kvůli tomuto gate.

## 8. Závěr

VER-01, VER-02, VER-05 a VER-06 jsou lokálně uzavřené. VER-04 má poprvé reprodukovatelný a zelený DB+object restore drill, ale produkční R08 nelze označit za dokončený bez nezávislé automatické object backup infrastruktury a schválené recovery governance. Dalším krokem smí být pouze samostatná staging/release-readiness vlna; produkční deploy, migrace, backfill, rotace secretů a práce s `modvoltapp.cz` vyžadují nový explicitní souhlas.
