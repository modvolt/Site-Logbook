# R13-D5 – approved cost-document dual-write checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako default-dark druhý caller seam; R13 jako celek NOT READY**

## Výsledek

R13-D5 zapojuje právě `approveDocument` do caller-owned accounting transakce připravené v R13-D2:

- exact gate `ACCOUNTING_APPROVE_DOCUMENT_DUAL_WRITE_ENABLED` přijme pouze hodnotu `true`; bez ní běží původní schvalovací cesta a nepřistupuje k dosud nemigrovaným accounting tabulkám;
- schválení vytváří canonical `incoming-cost-document` version 1, sequence-zero `approved` lifecycle event, export intent a aggregate-head transition ve stejné DB transakci jako status, reviewer a line confirmation;
- snapshot váže approved header, supplier, ordered lines, totals, canonical references a každý původní soubor přes content SHA-256, velikost, media type a domain-separated hash objektové cesty;
- importní `sourceRef` a raw AI response se do evidence neukládají. Evidence uchovává pouze jejich domain-separated SHA-256;
- nový `sourceTrace` výslovně ukládá původní zdroj, parser, extraction schema version, původ rozhodnutí o typu dokladu, případné potvrzení uživatelem a volitelný AI model/confidence/time/completed extraction-run ID;
- leaf provenance používá `source=human`, protože jde o human-approved final state. Neprohlašuje historické per-field autorství; původní AI/ISDOC/e-mail kontext je oddělen v `sourceTrace`;
- builder failuje na chybějícím lidském actorovi, souboru/hashi/object path/velikosti, necanonical textu/decimalu, neznámém enumu, neúplné AI stopě nebo nekonzistentní potvrzovací dvojici actor/time;
- accounting write-seam registry nyní označuje `issueInvoice` i `approveDocument` jako `feature-flagged-version-event-outbox`.

## Replay, tamper a reopen hranice

- opakované `approveDocument` nad evidence-backed schváleným dokladem znovu sestaví canonical version z aktuálních DB hodnot a porovná její `versionSha256` se zamčenou hlavou; pouze exact shoda je idempotentní no-op;
- přímá změna schváleného řádku způsobí při replay 409 a nevytvoří druhý stream;
- dříve schválený legacy doklad bez accounting head se po zapnutí gate nesmí vydávat za nově nativně schválený. Replay skončí 409 a vyžádá řízený `legacy_observation` backfill;
- evidence-backed approved dokument nelze přes `setDocumentStatus` vrátit do editovatelného stavu. Dokud neexistuje append-only correction/reopen chain, skončí tato cesta 409 před první změnou;
- při dark gate zůstává původní reopen i opakované legacy approve chování beze změny.

## Fault důkaz

Izolovaný PostgreSQL 16 test vloží fault trigger před INSERT do `accounting_export_outbox`:

- selhání rollbackne status dokumentu, reviewer/time, line `matchConfirmed`/`approved`, version, event i aggregate head;
- po odstranění faultu retry vytvoří právě jeden version/event/outbox stream;
- schvalovací seam nemá vlastní S3/object-storage write, takže před accounting appendem ani po něm nepřibyl nový externí side effect;
- čtení snapshotu uvnitř caller transakce je sekvenční; test skončil bez deprecated concurrent-query chování PostgreSQL driveru.

## Bezpečnostní a provozní hranice

- flag se nesmí zapnout před číslovanou expand migrací, kontrolou journalu a samostatným staging cutoverem;
- SQL zůstává pouze v `docs/audit/17-f-r13-accounting-evidence-expand.template.sql`; migration journal zůstává 105/105, tail `0105_smooth_nitro`, bez `0100`;
- současný DB model zatím nemá trigger, který by přímo zamkl celý původní `billing_documents`/lines/files/references obsah. D5 přidává caller guard a tamper detekci při replay, nikoli ještě úplný R11 DB invariant;
- `sourceTrace` dokládá metadata viditelná při schválení, ne rekonstruovanou historii všech draft editací;
- nebyl proveden commit, push, PR, workflow dispatch, GHCR/S3 zápis, deploy, backfill ani staging/produkční migrace.

## Ověření

- celý API unit/contract gate: **96 souborů, 745/745 PASS**;
- disposable PostgreSQL 16 fault/replay/tamper/dark-gate sada: **3/3 PASS** nad standardními migracemi **105/105**, latest `0105_smooth_nitro`;
- API TypeScript, scoped ESLint, Prettier a produkční API build: **PASS**;
- `git diff --check`: **PASS** kromě očekávaného Windows LF→CRLF upozornění;
- disposable PostgreSQL měl limit 0.75 CPU / 1 GiB, data na bounded tmpfs a po testu byl odstraněn; Docker skončil s nulou běžících kontejnerů.

## Co zbývá v R13

1. Integrovat aktuální veřejný `main` a forward-only vyřešit konflikt dvou různých `0096`; až potom přidělit skutečné číslo expand migrace. `0100` zůstává vyloučena.
2. Implementovat append-only invoice cancellation/correction a payment event cesty pro `cancelInvoice`, `updateInvoiceStatus` a `confirmBankPayments`.
3. Doplnit append-only `review_reopened`/correction version cestu pro evidence-backed cost document; teprve potom lze bezpečně nahradit dočasný reopen zákaz.
4. Doložit Hetzner S3 capability preflight a pak přidat create-only/versioned adapter a samostatně aktivovat archive worker.
5. Připravit dry-run legacy inventory a idempotentní `legacy_observation` backfill bez domyšlených actorů, eventů nebo časů.

## Doporučený další řez

R13-D6 má zůstat bez migrace a bez externích zápisů: zapojit nejmenší append-only invoice lifecycle seam s již schválenými důvody storna/void a současně zachovat zákaz přímého přepisu vydané verze. Payment eventy a cost-document reopen/correction mají zůstat oddělenými podřezy, aby fault a replay důkazy nebyly smíchány.
