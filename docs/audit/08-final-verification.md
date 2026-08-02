# FÁZE 9 – závěrečné ověření

- **Datum ověření:** 2026-08-02
- **Ověřovaný stav:** čistý commit `5dc93dc` obsahující bezpečnostní commit `7510a9c`
- **Produkce:** nedotčena; nebyla použita produkční databáze, secrets, storage, SMTP/IMAP ani relace na `modvoltapp.cz`

## 1. Verdikt

Lokální bezpečnostní baseline po FÁZI 8 je výrazně lepší a hlavní hermetická release gate je zelená. Tento stav ale zatím není připraven k neřízenému produkčnímu nasazení. Celkové skóre připravenosti je **62/100**.

Blokátory nejsou v typechecku, buildu ani v cílených bezpečnostních testech. Jsou v provozním důkazu: celý DB testovací strom není spolehlivý release gate, několik souběhových a datových invariantů zůstává červených a nebyla prokázána úplná obnova DB spolu s objekty. Aktuální produkce již běží, ale tato zpráva neověřovala její současnou konfiguraci ani shodu s lokálním `HEAD`.

## 2. Manažerské shrnutí

1. **Bezpečnost před auditem:** FÁZE 1 našla 0 Critical, 8 High, 12 Medium a 2 Low bezpečnostní nálezy; FÁZE 4 navíc popsala 2 Critical a 8 High rizik odolnosti. Největší slabiny byly session lifecycle, fail-open autorizace, plaintext secrety, identity-unsafe PWA, veřejné tokeny, měnitelný podepisovaný obsah, uploady, CSP/TLS a neprokázaná obnova.
2. **Největší původní rizika:** převzetí účtu nebo relace, IDOR a obejití permission override, únik secretů ze zálohy, replay offline operací pod jiným uživatelem, změna dokumentu po podpisu, neomezený upload/parser, falešný pocit obnovitelnosti a nekonzistence při souběhu.
3. **Co bylo opraveno:** lokálně jsou dokončeny roadmap workstreamy R00–R07: hermetický gate, account/session lifecycle, fail-closed route a object authorization, identity-scoped offline cache/fronta a idempotency ledger, upload ochrany, envelope encryption, hash-only veřejné tokeny a neměnné job/quote verze, CSP/anti-framing, TLS 1.2+ pro mail a CSV neutralizace.
4. **Co zůstává:** R08–R17 a další P1/P2 workstreamy nejsou obecně dokončeny. Prakticky nejdůležitější jsou úplná DB+object obnova, durable audit/outbox, DB invarianty a optimistic locking, izolovaný full-stack test, monitoring a governance GDPR.
5. **Právní revize:** stále je nutné schválit účely, právní tituly, retence, DSAR/erase/hold, nemoc/BOZP/mzdy, účetní korekce, podpisové důkazy, zpracovatele a přeshraniční přenosy. Technický audit není právní stanovisko.
6. **Odolnost proti ztrátě dat:** migrace a vybrané rollbacky jsou dobře ověřeny, ale úplný restore DB + objektů nebyl proveden. Bez samostatného storage a restore drill nelze tvrdit dosažení RPO/RTO ani úplnou obnovitelnost.
7. **Snížení administrativy:** audit navrhl jednotný inbox výjimek, document-level billing review, obecné drafty, scoped externí přístup a lepší offboarding. Tyto úspory nejsou součástí ověřovaného `HEAD` v rozsahu R18–R22.
8. **Zjednodušení práce:** cílový model zůstává Projekt → Zakázka → Výjezd, přičemž opakovaný výjezd nevytváří novou zakázku. Necommitnutý redesign a preference v pracovním stromu byly z ověření záměrně vyloučeny.
9. **Před produkční změnou:** opravit nebo vědomě uzavřít červené concurrency/datové testy, zavést deterministický full-stack gate, provést DB+object restore drill, uzavřít aktuální dependency advisory, přidat lint a peer gate a ověřit staging canary/rollback.
10. **Horizont 30/90/180 dní:** do 30 dní stabilizovat release gate a restore drill; do 90 dní dokončit R08–R12 a provozní alerty; do 180 dní uzavřít governance, doménové zjednodušení a pravidelné chaos/security drilly.

## 3. Rozsah a izolace

- Rozhodující kontroly běžely z archivované čisté kopie `HEAD`, nikoli z pracovního stromu s uživatelským redesignem.
- `scripts/run-hermetic-gate.mjs` odstranil DB, provider a mail secrets a nastavil `NODE_ENV=test`.
- DB testy používaly nový PostgreSQL 18 cluster pouze na `127.0.0.1:55439`, role `phase9_test_owner` a databáze s explicitním `test` názvem.
- Docker Desktop byl po neúspěšném pokusu o backend vrácen do původního stavu `stopped`.
- Lokální preview, čistá instalace, DB cluster, dočasné storage adresáře a logy byly po ověření odstraněny.

## 4. Výsledky povinných kontrol

| Oblast                                      | Výsledek               | Důkaz a omezení                                                                                                                                                                                 |
| ------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck                                   | **PASS**               | Root library build a 4/4 artifact/script typecheck.                                                                                                                                             |
| Lint                                        | **NOT AVAILABLE**      | Repozitář nemá `lint` script ani ESLint/Biome/Oxlint konfiguraci. Nelze vydat falešný zelený výsledek.                                                                                          |
| Hermetické unit/security testy              | **PASS**               | 5/5 guard testů, frontend 127/127, live-events 15/15, API 286/286.                                                                                                                              |
| Cílené upload/signature/mail security testy | **PASS**               | 8 souborů, 48/48; parser limity, abort, signatura souboru/obrázku, object policy a mail TLS kontrakt.                                                                                           |
| Integration testy – specializované DB       | **PASS**               | Authorization/session/vault/private-object/offline idempotency 38/38; workflow DB 6/6.                                                                                                          |
| Integration testy – celý API strom          | **FAIL**               | Výchozí runner skončil na 28 položkách kvůli paralelní sdílené DB a chybějícím opt-in guardům. Sekvenční diagnostický běh stále skončil s 19 neúspěšnými testy a 2 suite setup/cleanup chybami. |
| Security dependency audit                   | **PARTIAL**            | Celý graf: 17 advisory (11 High, 4 Moderate, 2 Low), převážně build/codegen. `--prod`: 1 Moderate (`uuid` pod Google Storage).                                                                  |
| Peer dependencies                           | **FAIL**               | `@zxing/browser@0.2.0` požaduje `@zxing/library ^0.22.0`, instalováno `0.23.0`.                                                                                                                 |
| API build                                   | **PASS**               | `dist/index.mjs` a migrační bundle vytvořeny.                                                                                                                                                   |
| Web/PWA build                               | **PASS**               | Vite 7.3.3, 4 013 modulů, service worker, 222 precache položek; upozornění na chunk 844 kB a `heic2any` 1,35 MB.                                                                                |
| DB migration test                           | **PASS**               | Journal OK, 102/102 migrací, 97 tabulek a jejich sloupce odpovídají snapshotu, temp DB odstraněna.                                                                                              |
| DB rollback test                            | **PASS**               | 0086–0090 forward → DOWN v opačném pořadí → forward, idempotentní třetí běh; temp DB odstraněna.                                                                                                |
| Auth/session rollback guard                 | **PASS**               | 0096/0097 forward/down/forward, blokace DOWN po použití generation/idempotency ledgeru.                                                                                                         |
| Základní business workflow                  | **PASS, omezené**      | 6/6 izolovaných job create/status/quote→job-group→invoice DB testů; nejde o plný browser E2E.                                                                                                   |
| PWA offline unit test                       | **PASS**               | 4 soubory, 49/49 pro cache policy, queue, replay a retry.                                                                                                                                       |
| PWA browser smoke                           | **PARTIAL PASS**       | Po online načtení a zastavení preview serveru se shell z precache znovu načetl a zobrazil login. Autentizovaný offline replay v browseru nebyl proveden.                                        |
| Upload/download dokumentu                   | **PARTIAL PASS**       | Unit/security a DB object authorization jsou zelené; skutečný multipart upload + download proti izolovanému S3/MinIO nebyl dostupný.                                                            |
| Podepsaný dokument                          | **PASS, izolované**    | Cílený DB pack pro immutable job/quote evidence, token lifecycle, signature token leak a upload ledger: součást 26/26 zelených testů. Bez browserového podpisu a reálného storage.              |
| E-mail v test režimu                        | **PASS**               | 11/11 pro quote send a OOPP confirm; SMTP i storage jsou mockované, nic nebylo odesláno.                                                                                                        |
| Backup + restore                            | **NOT RUN end-to-end** | Capability probe: 1 pass + 5 správně přeskočených testů, protože chybělo izolované object storage. DB-only migrace/rollback nenahrazuje DB+object restore.                                      |

Počet testů v tabulce se nepřičítá do jednoho součtu: cílené balíky se částečně překrývají s hlavní release gate.

## 5. Zbytkový registr FÁZE 9

### VER-01 – Celý API DB runner není použitelný jako deterministický release gate

- **Priorita:** High pro release proces.
- Výchozí `test:db` spouští mnoho souborů proti jedné databázi paralelně a zahrnuje fail-closed opt-in soubory bez jejich guard proměnných.
- Sekvenční režim počet selhání snížil, ale neodstranil test-state a fixture problémy.
- Náprava: per-suite disposable DB nebo transakční isolation, explicitní skupiny testů, lokální S3/SMTP/IMAP fakes, jednotný seed a povinný CI job.

### VER-02 – Neuzavřené souběhové a datové invarianty

- **Priorita:** High, vyžaduje samostatnou diagnostiku před rolloutem.
- Reprodukované červené scénáře zahrnují `scheduler-lock-concurrent`, překryv manuálních `work_sessions` a warehouse rematching mezi dvěma položkami.
- Červené byly také legacy time-entry synchronizační scénáře; jejich význam je nutné porovnat s novým authoritative modelem `work_sessions`, nikoli automaticky vracet staré chování.
- Tyto výsledky jsou testovací důkaz, ne hotová root-cause analýza; FÁZE 9 produkční kód neměnila.

### VER-03 – Zastaralé nebo neizolované testovací kontrakty

- **Priorita:** Medium.
- `ppe-storage-access` očekává odstraněný export, `review-queue-actions` předpokládá neexistující fixture ID, `ppe-broken-signature` očekává JSON parsing jinak vráceného bufferu a část `forensic-baseline` je sama označena jako dosud neimplementovaná acceptance sada.
- Health test očekává `200`, zatímco izolovaný proces bez backup/storage readiness správně vrací `503`; kontrakt musí rozlišit liveness a readiness.

### VER-04 – Obnovitelnost systému není prokázána

- **Priorita:** High.
- Restore test vyžaduje DB a object storage. Izolovaná DB byla dostupná, izolovaný MinIO/GCS ne.
- Chybí důkaz obnovy fotografií, příloh, podepsaných PDF, manifestu a šifrovacích klíčů spolu s DB.
- Do úspěšného drill nelze deklarovat R08, konkrétní RPO/RTO ani status „backup OK“ jako záruku obnovy.

### VER-05 – Nové advisory ve vývojovém dependency grafu

- **Priorita:** Medium, s okamžitou triage před dalším buildem.
- Aktuální registry nově označují Vite `<=7.3.4`, `linkify-it`, `brace-expansion`, `js-yaml`, `fast-uri` a související transitive tooling.
- Produkční graf má jeden Moderate `uuid` přes `@google-cloud/storage`; dřívější reachability review nenašla použití zranitelných bufferových variant, ale upgrade upstreamu je stále vhodný.
- High ve vývojovém nástroji není automaticky runtime High, ale dev server, codegen a CI zůstávají součástí supply chain.

### VER-06 – Chybí lint a peer gate

- **Priorita:** Medium/Low.
- TypeScript zachytí typové chyby, nikoli všechna pravidla pro promise handling, security footguns, import boundary a React hooks.
- ZXing peer rozpor může být kompatibilní, ale bez explicitního ověření není uzavřený.

### VER-07 – Browser E2E a accessibility jsou jen částečně ověřeny

- **Priorita:** Medium pro test strategii, Low pro konkrétní login label.
- Login shell fungoval online i ze service-worker cache. Browser API ale nenašlo programovou label vazbu pro username/password, přestože text byl viditelný.
- Live E2E konfigurace má pevný účet a očekává již běžící prostředí; v této fázi nebyly použity produkční credentials.

## 6. Skóre 0–100

| Oblast                             |  Skóre | Evidence                                                                                                                                                   |
| ---------------------------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autentizace                        |     82 | Session regenerace/generation, reset lifecycle, setup race, WebAuthn a 4/4 session DB důkazy; produkční rollout neověřen.                                  |
| Autorizace                         |     80 | Explicitní politika všech 397 rout, object ownership, vault step-up a 27/27 vault/private-object důkazů; některé staré acceptance testy zůstávají červené. |
| Ochrana dat                        |     72 | Envelope encryption a šifrované backup payloady v kódu; key custody, produkční backfill a DR nejsou provedeny.                                             |
| GDPR připravenost                  |     55 | Datová mapa a návrh existují; chybí schválený ROPA, tituly, retence, DSAR/hold/incident workflow.                                                          |
| Bezpečnost souborů                 |     76 | Upload limity, scanner contract, dekódování podpisů, ledger, object authorization a 48/48 cílených testů; bez reálného S3 malware E2E.                     |
| Auditní stopa                      |     70 | Hash-only tokeny, immutable versions/events a evidence hash; obecný durable audit/provenance export R09 není dokončen.                                     |
| Robustnost DB                      |     64 | 102/102 migrací, parity a rollbacky jsou silné; scheduler/work-session/warehouse invarianty jsou červené a optimistic locking není obecný.                 |
| PWA/offline                        |     78 | 49/49 offline testů a browser precache reload; bez autentizovaného offline replay/user-switch browser E2E.                                                 |
| Backup/restore                     |     45 | DB migrace a restore implementace existují, ale úplný DB+object restore drill byl přeskočen.                                                               |
| Monitoring                         |     50 | Health/admin základ existuje; chybí úplné SLI/SLO, queue/storage/mail alerty a nezávislý incidentní kanál.                                                 |
| Testování                          |     65 | Hermetická gate je zelená a specializované DB suites jsou kvalitní; full API runner, lint a izolovaný full-stack chybí.                                    |
| UX                                 |     62 | Silný mobilní capture základ a PWA shell; dlouhé workflow, accessibility label a jednotná další akce zůstávají otevřené.                                   |
| Administrativní efektivita         |     55 | Doporučený cílový model je jasný, ale jednotný inbox, batch billing a obecné drafty nejsou v ověřovaném HEAD.                                              |
| **Celková produkční připravenost** | **62** | Silná lokální bezpečnostní baseline, ale bez zeleného celého gate, restore drill a staging/prod canary nelze doporučit slepý rollout.                      |

## 7. Co musí projít právní a provozní revizí

- role správce/zpracovatele, účely a právní tituly po datových doménách;
- retence a právní hold pro faktury, nabídky, podpisy, OOPP/BOZP, nemoc, mzdy, GPS/fotografie a logy;
- DSAR export, oprava, omezení a výmaz včetně příloh, záloh a downstream providerů;
- přiměřenost biometrie/WebAuthn a údajů o zdravotním stavu;
- důkazní význam elektronického potvrzení, PDF hashe, timestampu a e-mailu;
- smlouvy a přenosy pro hosting, object storage, mail, Google/OpenAI a případné subprocesory;
- RPO/RTO, vlastník recovery klíčů, dual control a incidentní 72hodinový postup.

## 8. Manuální postupy pro neprovedené E2E

### Úplný backup/restore drill

1. Vytvořit jednorázový PostgreSQL a MinIO/GCS test stack bez produkčních credentials.
2. Aplikovat 102/102 migrací a seednout reprezentativní DB záznamy i objekty všech chráněných prefixů.
3. Nastavit testovací encryption keyring s recovery kopií mimo stack.
4. Spustit `createBackup`, ověřit hash/envelope a fyzickou přítomnost dumpu a object manifestu.
5. Obnovit do nového názvu DB a nového bucket/prefixu, nikdy přes zdroj.
6. Porovnat tabulky, counts, klíčové vazby, hashe objektů, podepsaná PDF a decrypt.
7. Změřit RPO/RTO, uložit protokol, následně odstranit celý stack.

### Upload/download a podpis v browseru

1. Spustit staging se sandbox S3 a scannerem, deterministickým seedem a test rolemi.
2. Nahrát čistý dokument, škodlivý/karanténní fixture a přerušený upload; ověřit ledger a cleanup.
3. Stáhnout objekt jako vlastník, jiná role a anonym; porovnat SHA-256 a `Content-Type`/`nosniff`.
4. Vytvořit verzi dokumentu, podepsat ji, ověřit PDF/content hash, jednorázové consume, replay, revoke a novou verzi po opravě.

### Mail sandbox

1. Použít Mailpit/MailHog a IMAP fake, nikdy reálného příjemce.
2. Ověřit STARTTLS policy, stabilní message ID/idempotency, PDF hash přílohy a canonical origin odkazu.
3. Simulovat accepted, timeout/unknown, retry a hard bounce; výsledek musí mít dohledatelný stav bez duplicit.

## 9. Kroky před jakoukoli produkční změnou

1. Diagnostikovat a opravit nebo formálně překlasifikovat VER-02 na aktuální business kontrakt.
2. Přestavět `test:db` na deterministický izolovaný gate a přidat lint/peer/dependency job.
3. Provést úplný DB+object restore drill a schválit RPO/RTO/key custody.
4. Aktualizovat zranitelné build/codegen balíky a znovu spustit všechny gate.
5. Ověřit staging: auth matrix, upload/download, podpis, sandbox mail, PWA user switch a offline replay.
6. Připravit success metriky, abort podmínky, rollback/forward-fix, monitoring a vlastníka release.
7. Teprve samostatně schválit produkční migrace, backfill secretů/tokenů, deploy a canary. Tato FÁZE 9 je neschvaluje.

## 10. Plán 30/90/180 dní

### Do 30 dní

- uzavřít VER-01, VER-02, VER-05 a VER-06;
- zavést izolovaný PostgreSQL + S3 + SMTP test job;
- provést první úplný restore drill a stanovit RPO/RTO;
- zavést povinný CI release gate a dependency alerting.

### Do 90 dní

- dokončit R08–R12: úplná obnova, durable audit, GDPR governance základ, DB invarianty a outbox/reconciler;
- přidat queue age, backup freshness, storage reconciliation a externí alert kanál;
- zavést staging E2E pro upload, podpis, e-mail, billing a offline user switch.

### Do 180 dní

- dokončit R13–R22 podle schválených business/právních rozhodnutí;
- sjednotit Projekt → Zakázka → Výjezd bez tvorby nové zakázky pro každý výjezd;
- zavést jednotný inbox výjimek, batch billing, draft/conflict model a scoped externí přístup;
- spouštět čtvrtletní restore/security/incident drill a periodické mutation/chaos testy.

## 11. Checkpoint FÁZE 9

FÁZE 9 je dokončena jako ověřovací a dokumentační fáze. Produkční kód, produkční data ani infrastruktura nebyly změněny. Automaticky se nepokračuje do žádné další fáze. Samostatný checkpoint a doporučení pro případné další spuštění jsou v `docs/audit/09-phase-checkpoint.md`.
