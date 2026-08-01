# FÁZE 7 – Jednotná remediation roadmapa

- **Auditovaná revize:** `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f` (`main`).
- **Vstupy:** 84 nálezů FÁZÍ 1–6: 22 SEC, 13 GDPR, 13 COMP, 14 ROB, 8 TEST a 14 UX.
- **Výstup:** 26 neduplicitních workstreamů R00–R25, jejich závislosti a doporučené pořadí.
- **Hranice:** tento dokument nic neimplementuje. Odhady jsou relativní velikost změny, nikoli cenová nabídka ani kalendářní závazek.

## 1. Manažerské shrnutí

Nejbezpečnější cesta není zahájit velký redesign. Nejdříve je nutné vytvořit minimální izolovaný release gate, uzavřít cesty k převzetí účtu a obejití oprávnění, oddělit PWA data podle identity, ochránit uploady a privátní objekty a opravit průkaznost veřejných podpisových odkazů. Současně se musí prokázat úplná obnova DB i objektů.

Teprve na tomto základě má smysl zavádět durable audit/outbox, DB invarianty, účetní snapshoty, GDPR workflow a spolehlivý sync. Největší administrativní úspory – dokumentové batch review, jednotný inbox a sjednocení Projekt → Zakázka → Výjezd – jsou P2, protože bez bezpečnostních a datových základů by zrychlily i chybné či neprůkazné operace.

Roadmapa neznamená jeden release. R00–R07 se mají realizovat v malých izolovaných změnách s regresními testy. Každá migrace používá expand–migrate–contract, samostatný backfill, měření a předem ověřený návratový postup.

### Stav realizace po FÁZI 8.8

| Workstream | Stav | Důkaz | Zbývající hranice |
|---|---|---|---|
| R00 | Dokončeno lokálně | `f1bb210`, `2c660c1`; hermetický `pnpm gate:release` prošel 2026-08-01 | potvrdit první běh nového GitHub Actions workflow; rozšířený ephemeral DB/E2E stack patří do R14 |
| R01 | Dokončeno lokálně | `da5e734`, `f5f6349`, `8ddea6d`, `b5ef912`, `bf18843`; izolovaný PostgreSQL test prokázal paralelní setup, rotaci cookie, revokaci dvou agents a odmítnutí znovuuložené staré session | před produkcí aplikovat migraci `0096`, připravit oznámení jednorázového odhlášení a sledovat 401/login chyby |
| R02 | Dokončeno lokálně | `77422e6`, `8d3c4b9`, `96e5e96`, `cf34a09`, `fbff6fa`, `5b7dbb0`; 397 unikátních method/path registrací je generováno ze zdrojů a každá má explicitní public, authenticated-only nebo permission policy | před produkcí read-only inventura legitimních tras/objektů, měřitelný rollout a monitoring nových `route_not_authorized` odpovědí |
| R03 | Dokončeno lokálně | `71bf9d8`, `7e9d819`, `45937f6`, `583eaa4`; identity partition a live scope kontrolu doplňuje atomický IndexedDB lease, durable serverový ledger pro všechny offline mutace, SHA-256 raw uploadů a řízené retry/conflict/ambiguous stavy | před produkcí aplikovat `0097`, nasadit server a frontend jako jeden řízený rollout; plný browser E2E se dvěma reálnými taby zůstává v R14 |
| R04 | Dokončeno lokálně | `63ba086`; auth před nákladným parsingem, pevné body/decompression limity, strukturální MIME validace, re-decode podpisů, scanner/quarantine hook, SHA-256 metadata a durable upload ledger `0098` | před produkcí aplikovat `0098`, ověřit scanner a nasadit API+proxy koordinovaně; inventura, retence a orphan cleanup zůstávají v R12 |

FÁZE 8.1–8.8 nic nenasadily ani neposlaly na remote. R04 lokálně uzavřel request/upload/object-storage ochranu bez mazání nebo backfillu existujících objektů. Podrobnosti, rollout hranice a reprodukovatelné kontroly jsou v [08-phase-checkpoint.md](08-phase-checkpoint.md) a [08-upload-protection-runbook.md](08-upload-protection-runbook.md).

## 2. Definice priorit

| Priorita | Význam v této roadmapě |
|---|---|
| **P0 – okamžitě** | Riziko převzetí účtu, obejití oprávnění, úniku citlivých dat, podvržení dokumentu, zneužití uploadu nebo přehrání PWA dat pod jinou identitou. |
| **P1 – před dalším významným produkčním rozvojem** | Obnova dat, audit/provenance, DB konzistence, lifecycle dokumentů, GDPR, testovací izolace, monitoring a spolehlivé externí integrace. |
| **P2 – významné provozní a administrativní zlepšení** | Snížení večerní administrativy, dávkové zpracování, jednotný inbox, drafty a sjednocení pracovních modulů. |
| **P3 – pozdější optimalizace** | Výkon po změření, hlasové vstupy, vizuální/accessibility polish a pokročilé assurance techniky. |

## 3. Závislosti a pořadí vln

```mermaid
flowchart TD
    W0["Vlna 0: R00 bezpečný release gate"] --> W1["Vlna 1: R01–R07 P0 bezpečnost"]
    W1 --> W2["Vlna 2: R08 obnova + R14 izolované integrační testy"]
    W2 --> W3["Vlna 3: R09–R13 datová průkaznost a transakce"]
    W3 --> W4["Vlna 4: R15–R17 provoz, identity a historie cen/času"]
    W4 --> W5["Vlna 5: R18–R20 výjimky, billing, inbox a draft/sync"]
    W5 --> W6["Vlna 6: R21–R22 doménové a terénní UX změny"]
    W6 --> W7["Vlna 7: R23–R25 optimalizace a assurance"]
```

R00 je minimální prerequisite, nikoli záminka odložit P0. Plný testovací stack R14 může pokračovat souběžně po uzavření nejnebezpečnějších testovacích hranic. R21 nesmí začít, dokud nejsou hotové R08, R11, R13, R14, R17 a schválené mapování legacy `activities`.

## 4. Portfolio workstreamů

| ID | Priorita | Workstream | Složitost | Migrace | Odstávka |
|---|---|---|---|---|---|
| R00 | P0 | Minimální izolovaný release gate | M | Ne | Ne |
| R01 | P0 | Účty, obnova hesla a session lifecycle | M | Možná malá | Ne |
| R02 | P0 | Fail-closed autorizace a objektové vlastnictví | L | Pravděpodobně | Ne plánovaná |
| R03 | P0 | Identity-safe PWA cache a offline fronta | L | Browser storage | Ne |
| R04 | P0 | Request/upload/object-storage ochrana | L | Možný metadata backfill | Ne plánovaná |
| R05 | P0 | Šifrování trezoru a provozních secretů | XL | Ano | Možná krátká při cutoveru |
| R06 | P0 | Veřejné tokeny a neměnné podepisované snapshoty | XL | Ano | Ne plánovaná |
| R07 | P0 | Perimetr: CSP, dependencies, TLS a interní routy | M | Ne | Ne |
| R08 | P1 | Úplná záloha a prokázaná obnova DB + objektů | L | Ne produkční; izolovaná kopie | Ne |
| R09 | P1 | Durable audit, provenance a důkazní export | XL | Ano | Ne plánovaná |
| R10 | P1 | GDPR governance, DSAR, retence a incidenty | L/XL | Ano | Ne plánovaná |
| R11 | P1 | DB invarianty, optimistic locking a online migrace | XL | Ano | Možné krátké DDL okno |
| R12 | P1 | Durable outbox a reconciler DB–storage–SMTP | XL | Ano | Ne plánovaná |
| R13 | P1 | Neměnný účetní a dokumentový lifecycle | XL | Ano | Ne plánovaná |
| R14 | P1 | Izolované DB/E2E/fault testovací prostředí | L | Ne produkční | Ne |
| R15 | P1 | Monitoring, alerty, fronty a provozní incidenty | M/L | Ne nebo malé metriky | Ne |
| R16 | P1 | Offboarding a dočasný scoped externí přístup | L | Ano | Ne |
| R17 | P1 | Historie času, sazeb, cen a korekcí | L/XL | Ano | Ne plánovaná |
| R18 | P2 | Konsolidovaný billing preview a document-level batch | L/XL | Pravděpodobně | Ne |
| R19 | P2 | Jednotný inbox výjimek s vlastníkem a SLA | L | Ano | Ne |
| R20 | P2 | Obecné user-scoped drafty a sync/conflict model | XL | Ano, DB + IndexedDB | Ne |
| R21 | P2 | Projekt → Zakázka → Výjezd a ukončení `activities` | XL | Ano, vysoce riziková | Možný řízený cutover |
| R22 | P2 | Režim Na místě, progressive disclosure a reklamace | L | Možná | Ne |
| R23 | P3 | Výkon, indexy a worker/queue škálování | L | Možné indexy | Možné krátké DDL okno |
| R24 | P3 | Hlasová poznámka a accessibility/UI polish | M/L | Možná pro média | Ne |
| R25 | P3 | Pokročilé assurance: mutation, chaos a periodické security testy | M/L | Ne | Ne |

## 5. P0 – okamžitě

### R00 – Minimální izolovaný release gate

- **Stav:** dokončeno lokálně ve FÁZI 8.1 (`f1bb210`, `2c660c1`); vzdálený CI běh zatím nepotvrzen.

- **Přínos:** každá P0 změna má reprodukovatelný typecheck, unit/contract testy, cílené auth testy a build bez produkčních secrets.
- **Riziko neprovedení:** bezpečnostní opravy mohou být nasazeny bez regresní ochrany nebo testy zasáhnou sdílenou DB.
- **Rozsah:** rozdělit API unit/DB příkazy, odstranit implicitní DB připojení, přidat root gate a zakázat produkční hostname/DB/bucket v test runneru.
- **Závislosti:** žádné; první úkol.
- **Složitost:** M.
- **Odstávka:** ne.
- **Migrace dat:** ne.
- **Změna uživatelského procesu:** ne; mění vývojový/release proces.
- **Doporučené pořadí:** 1; plný DB/E2E stack dokončí R14.
- **Hotovo když:** čisté prostředí bez `DATABASE_URL` spustí hermetický gate a DB test odmítne neizolovaný cíl.

### R01 – Účty, obnova hesla a session lifecycle

- **Stav:** dokončeno lokálně po FÁZI 8.2 (`da5e734`, `f5f6349`, `8ddea6d`, `b5ef912`, `bf18843`); produkční migrace a rollout zůstávají samostatně schvalovaným krokem.

- **Přínos:** brání převzetí administrátora a zajišťuje, že login/reset/deaktivace mají jednoznačný session stav.
- **Riziko neprovedení:** nízkoentropická obnova, session fixation a platné staré relace po změně credentialů.
- **Rozsah:** odstranit bezpečnostní otázky, použít administrátorem řízený nebo jednorázový recovery tok, regenerovat session ID, atomický bootstrap, global revoke při resetu/deaktivaci.
- **Závislosti:** R00.
- **Složitost:** M.
- **Odstávka:** ne; uživatelé mohou být záměrně odhlášeni.
- **Migrace dat:** možná malá (`sessionVersion`/recovery token metadata).
- **Změna uživatelského procesu:** ano, bezpečnější recovery a opětovné přihlášení.
- **Doporučené pořadí:** 2.
- **Hotovo když:** testy dokazují rotaci session, administrátorem řízený recovery a revokaci všech relací. Lokálně splněno včetně generation guardu proti souběžnému znovuuložení staré session; produkční rollout ještě neproběhl.

### R02 – Fail-closed autorizace a objektové vlastnictví

- **Stav:** dokončeno lokálně po FÁZI 8.5 (`77422e6`, `8d3c4b9`, `96e5e96`, `cf34a09`, `fbff6fa`, `5b7dbb0`). SEC-05, SEC-06, SEC-10 a SEC-22 jsou uzavřeny: trezor vyžaduje fail-closed session-bound password/WebAuthn step-up, generický download povolí jen přesnou DB referenci s oprávněním vlastní domény a všech 397 zdrojových API registrací má explicitní access policy. Necatalogovaná nebo neklasifikovaná route končí `403 route_not_authorized`.

- **Přínos:** permissions platí jednotně pro API, trezor i soubory a nelze stahovat data pouhou znalostí cesty.
- **Riziko neprovedení:** IDOR, obejití deny override a budoucí veřejná `/api/internal/*` route.
- **Rozsah:** centrální policy enforcement, route manifest default-deny, resource ownership/účel, vault step-up fail-closed, odstranit generický implicitní přístup k privátním objektům.
- **Závislosti:** R00; pro externisty později R16.
- **Složitost:** L.
- **Odstávka:** ne plánovaná; feature flag a permission shadow logs před enforcementem.
- **Migrace dat:** ve FÁZÍCH 8.4–8.5 nebyla potřeba; vlastnictví známých objektů se odvozuje z existujících přesných referencí. Případný indexový zásah se má řídit až produkčním měřením výkonu.
- **Změna uživatelského procesu:** minimální; některé dříve dostupné cesty budou správně odmítnuty.
- **Doporučené pořadí:** 3.
- **Hotovo když:** generovaná negativní matice dokazuje 401/403, deny override a wrong-owner chování pro všechny chráněné routy. Lokálně splněno ve FÁZI 8.5: generátor i nezávislý kontrakt pokrývají 397 registrací, odmítají duplicity, dynamické registrace a zastaralý manifest; izolovaná DB/API sada ověřila veřejnou PPE výjimku, authenticated-only self-service i default-deny near-miss routy.

### R03 – Identity-safe PWA cache a offline fronta

- **Stav:** dokončeno lokálně ve FÁZÍCH 8.6–8.7 (`71bf9d8`, `7e9d819`, `45937f6`, `583eaa4`). Server vydává neprůhledný scope identity/autorizační epochy, všechny API odpovědi mají `private, no-store`, service worker ukládá pouze explicitní same-origin field-work allowlist a IndexedDB v3 ukládá operace i blob pod vlastníka. Legacy v1 stores se nečtou ani nereplayují. Cross-tab lease s expirací dovolí flush jediné instanci; každá offline mutace nese stabilní idempotency key a server ji přijímá přes durable ledger s krátkou transakční advisory lock, heartbeat a fail-closed ambiguous stavem. Raw uploady vážou fingerprint na klientský SHA-256 ověřený po načtení těla. Klient rozlišuje auth, transient, conflict, permanent a ambiguous výsledky, používá nejvýše pět automatických pokusů s bounded backoffem a stejné durable ID ručně opakuje jen po transient chybě. SEC-08, SEC-09, GDPR-07, ROB-01 a ROB-02 jsou lokálně uzavřeny.

- **Přínos:** data jednoho uživatele se nezobrazí ani nepřehrají pod jiným účtem; replay je idempotentní.
- **Riziko neprovedení:** únik lokálních dat, mutace pod cizí identitou a duplicity při dvou tabech/retry.
- **Rozsah:** user/session scope cache i IndexedDB, logout purge/partition, idempotency key, lease mezi taby, bounded retry, session-expiry a service-worker-update testy.
- **Závislosti:** R00, R01; obecné drafty až R20.
- **Složitost:** L.
- **Odstávka:** ne.
- **Migrace dat:** ano v browser storage; staré neidentifikované fronty bezpečně karanténovat nebo odstranit, nikoli automaticky přehrát.
- **Změna uživatelského procesu:** ano, přesnější stav sync a možné jednorázové zrušení starých lokálních položek.
- **Doporučené pořadí:** 4.
- **Hotovo když:** logout/user switch a dva taby nemohou replayovat cizí/duplicitní operaci. Lokálně splněno kombinací identity partition, atomického IndexedDB lease race testu a skutečné PostgreSQL/API concurrency sady; plný Playwright scénář dvou reálných tabů a service-worker update zůstává průřezovým důkazem R14, nikoli otevřenou implementační mezerou R03.

### R04 – Request/upload/object-storage ochrana

- **Stav:** dokončeno lokálně ve FÁZI 8.8. Autentizace a route policy předcházejí nákladným parserům; uploady i e-mailové přílohy mají pevné limity, strukturální validaci a omezené rozbalování. Podpisové obrázky se skutečně dekódují a sanitizují. Office obsah vyžaduje scanner, generický upload má karanténu, SHA-256 provider metadata a durable stav/claim v aditivní tabulce `object_uploads`. Legacy objekty zůstávají kompatibilní a beze změny; úplný lifecycle/cleanup dokončí R12.
- **Přínos:** omezuje DoS, polyglot/ZIP útoky, falešné podpisové obrázky a orphaned soubory.
- **Riziko neprovedení:** vyčerpání paměti/disku, škodlivý obsah, neautorizovaný objekt a nekontrolovatelný storage růst.
- **Rozsah:** auth před velkým parsingem, streaming limity, decompression budget, MIME+magic validation, skutečné PNG ověření, quarantine/scanner hook, object checksum a upload status.
- **Závislosti:** R00, R02; lifecycle dokončí R12.
- **Složitost:** L.
- **Odstávka:** ne plánovaná.
- **Migrace dat:** možný metadata/checksum backfill; staré objekty se nemažou bez inventury.
- **Změna uživatelského procesu:** ano jen u odmítnutých/velkých souborů; UI musí vysvětlit limit a recovery.
- **Doporučené pořadí:** 5.
- **Hotovo když:** regresní sada odmítne oversized, zip bomb, spoofed MIME/signature a nedokončený upload nezůstane bez evidence. Lokálně splněno ve FÁZI 8.8; nedokončený nový generický upload zanechá ledgerový stav a objekt nelze atomicky claimnout bez správného vlastníka a stavu.

### R05 – Šifrování trezoru a provozních secretů

- **Přínos:** kompromitace DB/dumpu sama neodhalí zákaznické přístupy, SMTP/IMAP ani API klíče.
- **Riziko neprovedení:** jeden dump poskytne přímý přístup k dalším systémům a zákaznickým zařízením.
- **Rozsah:** envelope encryption, externí master key/KMS, versioned ciphertext, dual-read migrace, key rotation, redakce logů a oddělené backup keys.
- **Závislosti:** R00; předem potvrdit KMS/DR vlastnictví.
- **Složitost:** XL.
- **Odstávka:** bez odstávky při dual-read/backfill; krátké maintenance okno pouze pokud stávající formát nelze bezpečně přepnout online.
- **Migrace dat:** ano, citlivý re-encryption backfill s počty a rollbackem bez plaintext exportu.
- **Změna uživatelského procesu:** minimální; administrátor musí spravovat recovery/rotation runbook.
- **Doporučené pořadí:** 6; rozdělit na KMS, aplikační dual-read, backfill, cutover a rotaci.
- **Hotovo když:** DB dump bez KMS klíče neobsahuje použitelný secret a obnova/rotace je otestovaná.

### R06 – Veřejné tokeny a neměnné podepisované snapshoty

- **Přínos:** veřejné odkazy jsou revokovatelné a podpis dokládá přesnou verzi dokumentu.
- **Riziko neprovedení:** dlouhodobě použitelný bearer link, Host-header poisoning, accept/reject race a změna obsahu po podpisu.
- **Rozsah:** jednotný token service (hash, účel, expirace, one-time transition, revoke), trusted public base URL, immutable document version/hash/PDF a korekční verze/storno.
- **Závislosti:** R00, R02, R04; auditní evidence dokončí R09/R13.
- **Složitost:** XL.
- **Odstávka:** ne plánovaná; podporovat přechod starých tokenů s krátkým sunsetem.
- **Migrace dat:** ano; token metadata, snapshoty/verze a bezpečné označení legacy záznamů bez zpětného tvrzení neměnnosti.
- **Změna uživatelského procesu:** ano, znovuodeslání/revokace odkazu a explicitní nová verze po opravě.
- **Doporučené pořadí:** 7.
- **Hotovo když:** podpis/quote transition je atomický, link lze revokovat a hash podepsaného artefaktu je ověřitelný.

### R07 – Perimetr: CSP, dependencies, TLS a interní routy

- **Přínos:** zmenšení snadno zneužitelného povrchu bez velkého doménového redesignu.
- **Riziko neprovedení:** framing/XSS dopad, známé zranitelnosti, downgrade SMTP/IMAP a fail-open budoucí routy.
- **Rozsah:** CSP/frame-ancestors/security headers, dependency aktualizace po balíčcích, STARTTLS/CA fail-closed, explicitní interní router auth, CSV formula neutralizace.
- **Závislosti:** R00; SMTP state machine později R12.
- **Složitost:** M.
- **Odstávka:** ne, rolling release.
- **Migrace dat:** ne.
- **Změna uživatelského procesu:** ne; může vyžadovat aktualizaci starého mail serveru/prohlížeče.
- **Doporučené pořadí:** 8, ale izolované dependency/security-header opravy lze vydat dříve po R00.
- **Hotovo když:** produkční headers, dependency scan, TLS contract a CSV testy procházejí.

## 6. P1 – před dalším významným produkčním rozvojem

### R08 – Úplná záloha a prokázaná obnova DB + objektů

- **Přínos:** doložené RPO/RTO pro celý systém, ne jen část PostgreSQL.
- **Riziko neprovedení:** úspěšný DB restore bez fotografií, dokumentů a podepsaných PDF; falešný stav `ok`.
- **Rozsah:** off-site/versioned DB i object backup, manifest/checksum, nezávislý účet, restore exit-code hardening, business smoke a čtvrtletní drill/runbook.
- **Závislosti:** R00, inventura storage z R04; před každou další datovou migrací.
- **Složitost:** L.
- **Odstávka:** ne pro zálohu/drill; reálný disaster restore má plánované maintenance podmínky.
- **Migrace dat:** ne produkční; restore test vytváří izolovanou kopii.
- **Změna uživatelského procesu:** ne; provozní vlastník musí potvrzovat drill.
- **Doporučené pořadí:** 9.
- **Hotovo když:** čisté izolované prostředí obnoví DB+objekty, ověří checksumy a projde reprezentativní workflow v cílovém RTO.

### R09 – Durable audit, provenance a důkazní export

- **Přínos:** významná změna má dohledatelného aktéra, zdroj, před/po, důvod a vazbu na immutable artefakt.
- **Riziko neprovedení:** best-effort log selže spolu s requestem, obsahuje nadbytečná data nebo neprokáže AI/automatickou změnu.
- **Rozsah:** transakční audit/outbox, canonical event envelope, redakce, hash chain/externí export, provenance AI/importů a autoritativní serverové vault events.
- **Závislosti:** R05 pro citlivá pole, R06 pro verze, R11 pro transakční hranice.
- **Složitost:** XL.
- **Odstávka:** ne při expand-contract.
- **Migrace dat:** ano; nová audit/event tabulka a backfill pouze označených legacy metadat, ne domyšlené historie.
- **Změna uživatelského procesu:** ano u korekcí – povinný důvod u právně/účetně významných změn.
- **Doporučené pořadí:** 10–12 souběžně s R11/R13 po návrhu event modelu.
- **Hotovo když:** kritické operace mají atomický event a důkazní export ověří integritu bez citlivého payloadu.

### R10 – GDPR governance, DSAR, retence a incidenty

- **Přínos:** práva subjektů a mazání se provádějí řízeně, úplně a s právním holdem.
- **Riziko neprovedení:** neúplný export, destruktivní výmaz účetních/BOZP důkazů, neurčené retence a zmeškání 72hodinového incidentního procesu.
- **Rozsah:** ROPA/procesor registry, účely/tituly, data inventory, DSAR case, access/export/restrict/erase/anonymize, legal hold, retention jobs, breach register/runbook.
- **Závislosti:** právní/účetní/BOZP rozhodnutí; R05, R08, R09, R13 a R16.
- **Složitost:** L/XL podle schválených pravidel.
- **Odstávka:** ne plánovaná.
- **Migrace dat:** ano pro request/hold/retention metadata; historický backfill opatrně.
- **Změna uživatelského procesu:** ano, řízené žádosti místo přímého erase a schvalování výjimek.
- **Doporučené pořadí:** 13; governance rozhodnutí začít dříve, automatické mazání až po R08/R13.
- **Hotovo když:** testovací subjekt má úplný export a každá delete/anonymize akce má policy, hold check a důkaz výsledku.

### R11 – DB invarianty, optimistic locking a online migrace

- **Přínos:** kritická business pravidla drží i při souběhu, retry a více instancích.
- **Riziko neprovedení:** last-write-wins, dvojí billing, záporný sklad, nekonzistentní stav a startup DDL lock.
- **Rozsah:** verze řádků/ETag, unique/check constraints, atomické transitions, idempotency registry, explicitní lock order, expand-contract migrace a velkoobjemové testy.
- **Závislosti:** R00, R08, R14; doménové invarianty schválit před DDL.
- **Složitost:** XL.
- **Odstávka:** bez odstávky pro většinu změn; možné krátké DDL okno u validace constraintu/index cutoveru.
- **Migrace dat:** ano, více malých migrací a backfillů.
- **Změna uživatelského procesu:** ano, konflikt se zobrazí místo tichého přepsání.
- **Doporučené pořadí:** 10–14 po doménách; fakturace/podpis/sklad před obecnými editacemi.
- **Hotovo když:** concurrency testy dokazují jediný authoritative výsledek a online migration runbook je otestovaný.

### R12 – Durable outbox a reconciler DB–storage–SMTP

- **Přínos:** přerušení mezi DB, objektem a e-mailem má dohledatelný a bezpečně opakovatelný stav.
- **Riziko neprovedení:** orphaned objekty, DB záznam bez souboru, duplicitní/nezjistitelný e-mail a ruční hádání výsledku.
- **Rozsah:** outbox/inbox state machine, stable idempotency/message IDs, storage staging/finalize, reconciler, dead-letter, operator retry a delivery telemetry.
- **Závislosti:** R04, R09, R11, adapter fault testy R14.
- **Složitost:** XL.
- **Odstávka:** ne při dual path/feature flag.
- **Migrace dat:** ano; outbox/object-state tabulky a inventura orphanů bez automatického mazání.
- **Změna uživatelského procesu:** ano, stav `čeká/neznámé/selhalo/doručeno` a bezpečný retry.
- **Doporučené pořadí:** 14–15; nejdříve podpisové a fakturační e-maily, poté ostatní integrace.
- **Hotovo když:** kill test v každém mezikroku skončí konzistentním stavem nebo viditelnou repair položkou.

### R13 – Neměnný účetní a dokumentový lifecycle

- **Přínos:** schválení, vystavení, storno, oprava a archivace mají jednotnou korekční historii.
- **Riziko neprovedení:** přepis schváleného dokladu/faktury a nejasný účetní či právní důkaz.
- **Rozsah:** document/invoice versions, line snapshots, append-only status/payment events, correction/storno relations, approved locks, archive manifest a provenance AI vs human.
- **Závislosti:** R06, R09, R11; právní/účetní review z R10.
- **Složitost:** XL.
- **Odstávka:** ne při expand-contract.
- **Migrace dat:** ano; legacy rows označit jako legacy snapshot, nevytvářet falešnou historii.
- **Změna uživatelského procesu:** ano, oprava přes `vrátit ke kontrole`/novou verzi/storno, nikoli volný edit.
- **Doporučené pořadí:** 16; rozdělit nabídky, nákladové doklady a vystavené faktury.
- **Hotovo když:** po schválení/vystavení nelze významný obsah tiše změnit a celý correction chain je exportovatelný.

### R14 – Izolované DB/E2E/fault testovací prostředí

- **Přínos:** kritická workflow lze opakovaně ověřit bez sdílené DB a produkčních providerů.
- **Riziko neprovedení:** 53 API suite vyžaduje externí DB, live E2E má pevný účet a rizikové změny zůstanou bez gate.
- **Rozsah:** ephemeral PostgreSQL, MinIO, SMTP/IMAP/AI fake, deterministic seed, authorization matrix, PWA browser tests, migration/restore a fault-injection jobs.
- **Závislosti:** R00; contracts průběžně doplňují R01–R13.
- **Složitost:** L.
- **Odstávka:** ne.
- **Migrace dat:** ne produkční.
- **Změna uživatelského procesu:** ne; release proces ano.
- **Doporučené pořadí:** základ hned po R00, plný stack do pořadí 17.
- **Hotovo když:** CI vytvoří a zruší celý izolovaný stack a kritický smoke/concurrency/failure pack je povinný.

### R15 – Monitoring, alerty, fronty a provozní incidenty

- **Přínos:** selhání záloh, storage, mailu, AI, importů, queue a auth událostí je zachyceno dříve než zákazníkem.
- **Riziko neprovedení:** tiché backlogy a alert přes stejný selhávající SMTP kanál.
- **Rozsah:** SLI/SLO, queue age/depth, backup freshness, restore result, storage reconciliation, SMTP/IMAP/AI failures, role/session security events, externí alert kanál a runbook ownership.
- **Závislosti:** R08, R09, R12; incident registry R10.
- **Složitost:** M/L.
- **Odstávka:** ne.
- **Migrace dat:** ne nebo malé agregace/metriky.
- **Změna uživatelského procesu:** ano pro on-call/incident triage, ne pro techniky.
- **Doporučené pořadí:** 18.
- **Hotovo když:** simulované selhání každé kritické fronty vyvolá actionable alert nezávislým kanálem.

### R16 – Offboarding a dočasný scoped externí přístup

- **Přínos:** bývalý pracovník ztratí všechen přístup jednou akcí a externista dostane jen potřebný scope s expirací.
- **Riziko neprovedení:** platné sessions, zapomenuté overrides a široký trvalý auditor/externista účet.
- **Rozsah:** global revoke/offboarding checklist, device/session/token revocation, assignment transfer, role templates, resource scope, expiry, read-only default a export alternative.
- **Závislosti:** R01, R02, R09, pravidla GDPR R10.
- **Složitost:** L.
- **Odstávka:** ne.
- **Migrace dat:** ano pro grants/scope/expiry a případné session generation.
- **Změna uživatelského procesu:** ano, nový onboarding/offboarding průvodce.
- **Doporučené pořadí:** 19.
- **Hotovo když:** jediná potvrzená akce revokuje veškerý přístup a všechny externí grants mají vlastníka a expiraci.

### R17 – Historie času, sazeb, cen a korekcí

- **Přínos:** fakturační a mzdové podklady lze rekonstruovat podle tehdy platných hodnot.
- **Riziko neprovedení:** antedatování, přepočet minulosti novou sazbou a neprokazatelná korekce času/ceny.
- **Rozsah:** effective-dated rates, line snapshots, source timezone/clock, approval workflow času, correction reason/event a oprávnění vedoucí vs pracovník.
- **Závislosti:** R09, R11, R13; účetní/mzdová pravidla R10.
- **Složitost:** L/XL.
- **Odstávka:** ne plánovaná.
- **Migrace dat:** ano; historické hodnoty backfillovat jen z doložených zdrojů, jinak označit unknown.
- **Změna uživatelského procesu:** ano, potvrzení/korekce času a ceny s důvodem.
- **Doporučené pořadí:** 20.
- **Hotovo když:** vystavený billing preview používá explicitní snapshot a korekce nemění původní event.

## 7. P2 – významné provozní a administrativní zlepšení

### R18 – Konsolidovaný billing preview a document-level batch

- **Přínos:** vedení řeší skutečné anomálie místo potvrzení každého řádku a kontroluje zakázku na jedné obrazovce.
- **Riziko neprovedení:** vysoký backlog, potvrzovací slepota, opakované přepisování a pozdní fakturace.
- **Rozsah:** customer/job billing pack, hodiny+materiál+doprava+doklady+marže, confidence/rule exceptions, document-level approve, dry-run bulk a jasné interní vs `rebill`.
- **Závislosti:** R09, R11, R13, R14, R17.
- **Složitost:** L/XL.
- **Odstávka:** ne; starý tok držet při pilotu jako fallback.
- **Migrace dat:** pravděpodobně snapshot/provenance a batch-operation metadata.
- **Změna uživatelského procesu:** ano, administrátor potvrzuje dokument/balíček a otevírá pouze výjimky.
- **Doporučené pořadí:** 21.
- **Hotovo když:** běžný jistý dokument vyžaduje nejvýše jedno potvrzení a draft faktury ukazuje všechny blokátory.

### R19 – Jednotný inbox výjimek s vlastníkem a SLA

- **Přínos:** jeden seznam odpovídá na co, proč, kdo, do kdy a co položka blokuje.
- **Riziko neprovedení:** dashboard, billing, importy a sync mají oddělené backlogy bez odpovědnosti.
- **Rozsah:** federovaný attention model nad zdrojovými objekty, owner, due/age, impact, snooze/waiting, doporučená akce, dedupe a role-specific views.
- **Závislosti:** R09, R12, R15, R18; nevytvářet kopii účetních dat.
- **Složitost:** L.
- **Odstávka:** ne.
- **Migrace dat:** ano pro assignment/SLA state; zdrojová data zůstanou ve své doméně.
- **Změna uživatelského procesu:** ano, večerní práce začíná v inboxu, nikoli obcházením modulů.
- **Doporučené pořadí:** 22.
- **Hotovo když:** všechny kritické backlogy mají owner/age/action a vyřešení zdrojového problému položku atomicky uzavře.

### R20 – Obecné user-scoped drafty a sync/conflict model

- **Přínos:** zavření aplikace, slabý signál, session expiry ani PWA update nezničí rozepsanou práci.
- **Riziko neprovedení:** technik administrativu odloží nebo znovu zadává data; konflikty se tiše přepíší.
- **Rozsah:** server drafts, encrypted/user-scoped local draft, explicitní saved/sync/conflict states, optimistic merge, failed item přímo v kontextu a remote invalidation.
- **Závislosti:** bezpečnost R03, verze R11, monitoring R15, inbox R19.
- **Složitost:** XL.
- **Odstávka:** ne.
- **Migrace dat:** ano, DB draft/version schema + IndexedDB upgrade.
- **Změna uživatelského procesu:** ano, uživatel vidí stav a řeší pouze skutečný konflikt.
- **Doporučené pořadí:** 23.
- **Hotovo když:** kill/reload/offline/session-expiry test obnoví formulář a user switch nikdy neotevře cizí draft.

### R21 – Projekt → Zakázka → Výjezd a ukončení `activities`

- **Přínos:** jedna terminologie a jeden tok času, materiálu, dokladů a fakturace; opakovaný výjezd nevytváří novou zakázku.
- **Riziko neprovedení:** tři paralelní moduly, duplicitní evidence a trvalá administrativní volba na začátku každé práce.
- **Rozsah:** `job-groups` přejmenovat/omezit na volitelný Projekt, Zakázka jako dlouhodobý obal, `job-visits` jako pracovní dny, mapování a read-only sunset `activities`, sjednocení API/UI/exportů/billingu.
- **Závislosti:** R08, R09, R11, R13, R14, R17; schválená klasifikace každé legacy activity.
- **Složitost:** XL.
- **Odstávka:** preferovaný online dual-read cutover; možná krátká řízená write-freeze při finálním přepnutí.
- **Migrace dat:** ano, vysoce riziková a dávková; vyžaduje reconciliation counts, per-record mapping, rollback/forward-fix a archive origin IDs.
- **Změna uživatelského procesu:** ano, významná, ale cílem je méně voleb a žádná nová zakázka pro každý výjezd.
- **Doporučené pořadí:** 24; nikdy nespojovat s jinou velkou migrací.
- **Hotovo když:** každý výjezd patří právě jedné zakázce, Projekt nevlastní výjezdy a všechny historické finance/důkazy jsou dohledatelné.

### R22 – Režim Na místě, progressive disclosure a reklamace

- **Přínos:** technik zachytí čas, foto, materiál a poznámku bez hledání mezi administrativními sekcemi.
- **Riziko neprovedení:** dlouhé formuláře, odklad evidence a nesouvisející nová zakázka při opravě/reklamaci.
- **Rozsah:** minimální create job, sticky next action, `Na místě` mode, tým z výjezdu, jednoznačné accessible labels, lehký navazující případ opravy/reklamace s původní vazbou.
- **Závislosti:** R17, R20, po stabilizaci modelu R21; neměnit důkazní pravidla R06/R13.
- **Složitost:** L.
- **Odstávka:** ne.
- **Migrace dat:** možná pro complaint relation/status; UI progressive disclosure ne.
- **Změna uživatelského procesu:** ano, méně polí a jedna doporučená akce.
- **Doporučené pořadí:** 25; accessibility názvy lze dodat dříve jako izolovaný fix.
- **Hotovo když:** běžná zakázka má ≤3 viditelná povinná pole a terénní evidence nevyžaduje otevření billing/admin sekcí.

## 8. P3 – pozdější optimalizace

### R23 – Výkon, indexy a worker/queue škálování

- **Přínos:** stabilní odezva při růstu dokumentů, faktur a dlouhých transakcí.
- **Riziko neprovedení:** pomalé dashboardy, lock contention a dlouhé fronty; dnes jde o statický indikátor, ne potvrzený incident.
- **Rozsah:** tracing bez payloadů, slow-query baseline, EXPLAIN, batch/parallel bounded I/O, indexy, zkrácení transakcí a queue concurrency.
- **Závislosti:** telemetry R15 a reprezentativní test data R14.
- **Složitost:** L.
- **Odstávka:** ne, kromě možného krátkého index/constraint cutoveru; preferovat concurrent index.
- **Migrace dat:** možné indexy, ne business transformace.
- **Změna uživatelského procesu:** ne.
- **Doporučené pořadí:** 26 podle naměřeného bottlenecku, ne podle dojmu.
- **Hotovo když:** stanovené SLO je doloženo load testem a změna nezhorší lock/DB náklady.

### R24 – Hlasová poznámka a accessibility/UI polish

- **Přínos:** méně psaní v rukavicích a lépe rozlišitelné akce pro mobil i asistivní technologie.
- **Riziko neprovedení:** poznámky se doplňují večer z paměti; generické `Upravit` zvyšuje chybovost.
- **Rozsah:** jednoznačné accessible labels, touch target/focus/contrast audit, confirmed voice transcription, audio retention a explicitní souhlas/indikace nahrávání.
- **Závislosti:** UX měření, pravidla retence R10, storage R12 a drafty R20.
- **Složitost:** M/L.
- **Odstávka:** ne.
- **Migrace dat:** možná pro audio/transcript metadata; čistý accessibility polish ne.
- **Změna uživatelského procesu:** volitelná hlasová cesta; text zůstává.
- **Doporučené pořadí:** 27; základní accessibility chyby lze řešit dříve.
- **Hotovo když:** přepis se nikdy tiše nepoužije jako authoritative údaj a keyboard/screen-reader smoke pro kritické toky prochází.

### R25 – Pokročilé assurance: mutation, chaos a periodické security testy

- **Přínos:** ověří, že testy skutečně zachytí porušení permission, billing a recovery invariantů.
- **Riziko neprovedení:** zelený coverage report může skrývat neúčinné assertions a netestované failure kombinace.
- **Rozsah:** mutation test permission/billing decision functions, chaos kill points outbox/reconciler, dependency/DAST scan proti izolovanému prostředí a čtvrtletní restore/security drill.
- **Závislosti:** R14, R15 a hotové invarianty R11–R13.
- **Složitost:** M/L.
- **Odstávka:** ne; nikdy proti produkci bez samostatného schválení.
- **Migrace dat:** ne.
- **Změna uživatelského procesu:** ne; provozní odpovědnost za pravidelné drilly.
- **Doporučené pořadí:** 28/průběžně po stabilizaci P1.
- **Hotovo když:** definované mutace jsou zabity testy a chaos scénáře končí opravitelným, monitorovaným stavem.

## 9. Mapa pokrytí všech 84 nálezů

| Zdroj | Konsolidace do workstreamů |
|---|---|
| SEC-01–04 | R01 |
| SEC-05–06, SEC-10, SEC-22 | R02 |
| SEC-07 | R05 |
| SEC-08–09 | R03 |
| SEC-11, SEC-13, SEC-21 | R04, R12 |
| SEC-12, SEC-14, SEC-18 | R06 |
| SEC-15 | R09 |
| SEC-16–17, SEC-19–20 | R07 |
| GDPR-01–04, GDPR-08–10, GDPR-13 | R10; R08/R09/R13 jako technické závislosti |
| GDPR-05–06 | R02, R16 |
| GDPR-07 | R03, R20 |
| GDPR-11 | R06 |
| GDPR-12 | R00, R14 |
| COMP-01, COMP-11, COMP-13 | R09 |
| COMP-02, COMP-07 | R06 |
| COMP-03–05, COMP-12 | R13 |
| COMP-06 | R12 |
| COMP-08–10 | R17 |
| ROB-01–02 | R03, R20 |
| ROB-03, ROB-06–07 | R11 |
| ROB-04–05 | R12 |
| ROB-08–10, ROB-12 | R08 |
| ROB-11 | R15 |
| ROB-13 | R20 |
| ROB-14 | R23 |
| TEST-01–02, TEST-08 | R00, R14 |
| TEST-03–04 | R14; R02 jako testovaný invariant |
| TEST-05 | R03, R20, R14 |
| TEST-06 | R08, R14 |
| TEST-07 | R12, R14 |
| UX-01 | R21 |
| UX-02–05, UX-14 | R20, R22, R24 |
| UX-06 | R19 |
| UX-07–08 | R18 |
| UX-09 | R06, R13 |
| UX-10 | R12 |
| UX-11–12 | R16 |
| UX-13 | R03, R20 |

## 10. Implementační pravidla pro FÁZI 8

1. Jeden workstream není jeden commit ani jeden release. Každá izolovaná oprava má vlastní test, commit a rollback/forward-fix.
2. Před každým úkolem znovu ověřit aktuální `main`; auditní revize je snapshot a může být zastaralá.
3. Nemíchat auth, data migration, UX redesign a dependency upgrade do stejného pull requestu.
4. Schema změny vždy expand → backfill → verify → dual-read/cutover → contract. Destruktivní contract až po samostatném checkpointu.
5. Backfill má immutable vstupní snapshot/counts, restartovatelnost, dry-run, progress, reconciliation a audit výsledku.
6. Produkční data se nepoužívají v testu; restore, DAST, chaos, SMTP/IMAP/AI a object tests běží pouze v doložené izolaci.
7. U R05, R06, R09, R10, R13, R17 a R21 nesmí fallback vytvořit falešnou historii nebo tvrdit zpětnou neměnnost.
8. Nasazení s nevratným externím efektem (e-mail, podpis, faktura, storage delete) vyžaduje idempotency, outbox nebo explicitní reconciliation plán.
9. Každý release má předem definovaný success metric, abort condition, monitoring a vlastníka.
10. Po dokončení logického celku aktualizovat centrální roadmapu stavem a odkazem na důkaz; původní nález se nemaže.

## 11. Rozhodnutí potřebná před implementací

- vlastník KMS/backup recovery a přípustné maintenance okno;
- schválené RPO/RTO a nezávislý storage/backup účet;
- právní, účetní, mzdová a BOZP pravidla retence, korekcí a důkazů;
- přesné role/scope externisty a datové hranice údajů o nemoci;
- mapování každého legacy `activity` na Projekt/Zakázku/archivní případ;
- odpovědnost za time approval, reklamaci vs placený servis a billing SLA;
- provider možnosti delivery telemetry a sandbox SMTP/IMAP/AI;
- CI hosting a povinné merge/release gates.

## 12. Omezení roadmapy

Roadmapa vychází z revize `a25c312` a read-only produkčního snapshotu předchozích fází. Neověřuje aktuální externí infrastrukturu, smlouvy, cloud policies ani právní rozhodnutí. Složitost zahrnuje kód, testy, migraci a rollout, ale ne kalendářní odhad. P0 neznamená automatické povolení produkční změny; každá implementace vyžaduje samostatný scope a ověření.
