# FÁZE 8.12 – návrh neměnných job/quote verzí

## Problém

Veřejný podpis zakázky dnes zobrazuje živý řádek `jobs` a po potvrzení ukládá pouze PNG a čas. Nabídka sice odesílá PDF, ale veřejná stránka znovu skládá obsah z živé nabídky, token není svázán s PDF verzí a rozhodnutí neukládá identitu, potvrzovací text ani verzi. Pozdější stav proto nedokládá přesný obsah, který zákazník viděl.

## Rozsah změny

- nové aditivní tabulky `job_document_versions`, `job_signature_events`, `quote_versions` a `quote_decision_events`;
- vazba `public_access_tokens` na přesnou job nebo quote verzi;
- serverový canonical JSON + SHA-256 pro oba snapshoty;
- serverově generovaný finální job PDF s podpisem a SHA-256;
- quote PDF, veřejná stránka a decision event ze stejného uloženého snapshotu;
- explicitní self-declared jméno a neměnný potvrzovací text;
- oprava zachová původní verzi/event a otevře měnitelný parent pro novou verzi; důkazní řádek se nepřepisuje;
- klientem poslaný příznak `signed` u obecného job-sheet uploadu nesmí vytvářet důkazní označení.

## Invarianty

1. Nový job/quote token je `bound` právě k jedné odpovídající verzi; PPE token má vazbu `not_applicable`.
2. Legacy neprovázaný job/quote token se novou aplikací nepoužije a musí být znovu vydán. Historie se nebude zpětně vydávat za neměnnou.
3. Snapshot hash je SHA-256 deterministického canonical JSON. PDF hash je SHA-256 skutečných uložených bytů.
4. Veřejný GET čte obsah ze snapshotu, nikoli z parent tabulek.
5. Consume tokenu, doménový stav a důkazní event vzniknou v jedné DB transakci.
6. Finální verze a event tabulky chrání DB trigger proti UPDATE/DELETE; oprava je nový řádek/event.
7. Upload před DB commitem používá unikátní object key. Prohraný souběh nebo DB chyba uklidí osiřelý objekt.

## Možné regrese a kontroly

- **Staré odkazy:** po aplikačním cutoveru vrátí 410; rollout musí předem oznámit znovuodeslání.
- **Souběh:** paralelní podpis či accept/reject smí vytvořit právě jeden terminální event; ostatní objekty se uklidí.
- **Editace po vydání:** změna parentu nesmí změnit veřejný snapshot ani PDF/hash verze.
- **Opravy:** původní signed/accepted verze zůstane čitelná; nový obsah dostane vyšší číslo verze a nový token.
- **Storage chyba:** nevznikne finální DB důkaz odkazující na chybějící objekt.
- **Migrace:** čerstvý řetězec, DB trigger tamper test, guarded rollback a izolovaný backfill/cutover drill.

## Návrat

Preferovaný návrat je oprava aplikace při ponechání aditivního schématu. Down migrace smí proběhnout pouze před vznikem bound tokenu nebo document version/eventu. Po prvním novém odkazu je návrat roll-forward; odstranění vazby by obnovilo replay nebo oddělilo rozhodnutí od důkazu.

## Realizace FÁZE 8.12

Implementace je v commitu `fefc67e` a odpovídá návrhu:

- migrace `0102_immutable_job_quote_versions.sql` vytváří čtyři důkazní tabulky, vazby tokenů a DB triggery;
- `job-document-service.ts` vytváří verzovaný snapshot při vydání odkazu, zapisuje podpisový event a podporuje korekci bez přepsání staré verze;
- `job-handover-pdf.ts` generuje finální podepsané PDF na serveru a ukládá hash snapshotu, podpisu a PDF;
- `quote-version-service.ts` vytváří snapshot, PDF a bound token v řízeném toku, rozhodnutí zapisuje atomicky a při opravě nebo novém vydání zachová superseded event;
- veřejné stránky zobrazují číslo verze, hash a neměnný potvrzovací text a vyžadují self-declared jméno;
- správcovské detailní stránky nabízejí stažení podepsaného PDF a explicitní „Opravit verzí“ s povinným důvodem;
- obecný klientský job-sheet upload zůstává obyčejnou přílohou a ignoruje legacy příznak `signed`.

### DB neměnnost a výmaz účtu

Po podpisu lze `job_document_versions` změnit pouze jedním přechodem `pending_signature → signed`. Poté UPDATE/DELETE odmítne trigger. Quote verze a oba event logy jsou append-only od vzniku.

Jediná úzká výjimka umožňuje databázovému `ON DELETE SET NULL` odstranit z důkazního řádku zaniklé interní `actor_user_id` nebo `created_by_user_id`. Trigger ověří, že se současně nezměnilo žádné jiné pole. Jméno aktéra, identity assurance, potvrzovací text, čas, snapshot i hashe tak zůstávají zachované.

### Produkční cutover

1. Nejprve záloha a obnova v izolovaném prostředí; poté aplikovat `0101` a `0102` před nasazením nového API/frontendu.
2. Stávající neprovázané job/quote tokeny se označí `legacy_unbound` a nová aplikace je fail-closed odmítne. Aktivní příjemci musí dostat nový odkaz.
3. PPE tokeny se označí `not_applicable`; jejich tok zůstává funkční.
4. Ověřit dostupnost privátních bucketů `job-signatures`, `job-signed-documents` a `quotes` a oprávnění pro historické verze.
5. Po cutoveru sledovat 409/410 veřejných odkazů, chyby storage cleanupu a nesoulad migration parity.
6. Legacy plaintext sloupce odstranit až v pozdějším contract kroku po inventuře nulových hodnot; tato fáze je záměrně pouze expand/cutover-safe.

### Ověřené kontroly

- čistý migrační řetězec: 102/102 migrací, 97 tabulek proti snapshotu;
- cílené DB/API integrační testy: 14/14;
- relevantní hermetické kontrakty: 53/53 v hlavním stromu i čistém exportu commitu;
- TypeScript: DB, API klient, Zod klient, API server a frontend bez chyb;
- produkční Vite/PWA build: úspěšný;
- celý API unit gate: 273/274; jediný neúspěch je souběžná nezahrnutá změna field navigace, která rozšířila očekávanou množinu cest v `field-job-workflow-contract.test.ts`.
