# R09-A-B / R10-A / R11-B-C / R12-A-B / R13-A-D0 / R17 – Wave 1 contract and containment checkpoint

Datum: 2026-08-11  
Auditovaný základ: `df918a5bbfb786420eba6c48844b632ba139d203`  
Stav: **lokální implementace ověřena / bez migrace a bez externí mutace**

## 1. R09-A canonical audit envelope

Nový runtime kontrakt `site-logbook.audit-event/v1` je implementován v `artifacts/api-server/src/lib/audit-event-envelope.ts`. Zatím není připojen k produkčním write cestám ani DB.

Envelope ukládá pouze bounded metadata, striktní allowlist projekce a digests:

- canonical event UUID a UTC timestamp;
- actor kind/opaque ID/authentication/delegation;
- source kind/component/operation/exact build revision a hash request ID;
- action code, policy-derived class/critical flag a outcome;
- entity type/ID/version;
- bounded reason code a případný digestovaný `reason-detail` artifact;
- versioned before/after projection data podle exact strict registry a jejich domain-separated digests, ne raw DB row nebo request body;
- correlation/causation/idempotency pouze jako SHA-256;
- canonical sorted immutable artifact refs s SHA-256, velikostí a media type;
- domain-separated `eventSha256`.

`AUDIT_ACTION_POLICY_V1` pokrývá první kritický registr: vault reveal, role/permission/offboarding, invoice issue/status/payment/refund/correction/void, approved cost document a return/delete, signature create/sign/consume/revoke/supersede, privacy access/export/rectify/restrict/erase/hold, time review/correct/void/bill, external account grant/revoke, backup/restore, key rotation, migration/backfill/repair a stock override. Každá registrovaná akce váže přesný entity type, source operation, povolené source/actor/authentication kombinace, bounded reason codes a povinné doménové artifact role. Caller nemůže sám změnit action class, critical flag ani tyto vazby. Registry je seed pro route coverage gate, nikoli tvrzení, že už je každá produkční mutace zapojena.

### Přesná hranice důkazu

`eventSha256` dokazuje canonical obsah jediného envelope. **Nedokazuje pořadí, úplnost ani append-only historii.** Tuto hranici nyní doplňuje lokální R09-B kontrakt; produkční DB wiring a export stále neexistují.

### Secret minimization

- Envelope nemá arbitrary `payload`, `metadata` nebo `context` bag.
- Actor identity je discriminated podle kind/namespace/authentication; source component, system actor ID a source/actor kombinace jsou uzavřené registry a musí odpovídat produceru; vault reveal vyžaduje aktuální user step-up.
- Artifact refs mají uzavřené namespace a role; critical before/after projection binduje exact snapshot artifact SHA a action class určuje povinné role.
- Opaque entity/artifact identity odmítá URL, paths, e-mail, JWT/token body a query fragments strukturálně.
- Before/after obsahují jen bezpečnou exact projection (`job.audit/v1` nebo critical aggregate header) a digest; critical aggregate nese pouze registrovaný entity type, registrovaný lifecycle state, ID/version a digest externího immutable snapshotu.
- `reason.code` je allowlistovaný pro konkrétní action. Caller-derived vysvětlení smí pouze do hashovaného `reason-detail` artefaktu; regex známých tokenů zůstává jen defense-in-depth.
- Heslo, PIN, token nebo jiný nízkoentropický secret se nesmí auditovat ani přímým hashem; ukládá se pouze verze/přítomnost/key ID v bezpečné projection.
- Canonical JSON nyní fail-closed odmítá `Date`, `Map`, `Set`, class instances, accessors, symbol/non-enumerable keys, sparse/extra-property arrays, cycles, `undefined`, function, bigint a nefinite numbers. Validní plain JSON si zachovává dosavadní bytes.

## 2. R09-B chain a transakční outbox kontrakt

Nový `audit-chain-contract.ts` připravuje bez DDL a bez čísla migrace přesný adapter contract pro budoucí DB implementaci:

- jediný explicitní stream `site-logbook:audit:global:v1`;
- PostgreSQL-bigint sequence jako canonical decimal string;
- genesis `sequence=1` s `previousLedgerSha256=null`, každý další record váže exact předchozí ledger SHA;
- domain-separated canonical `ledgerSha256`, který váže event ID, ověřený leaf `eventSha256`, sequence, previous digest a `recordedAt` převzaté z event envelope;
- strict export-outbox intent `pending`, který váže stejný event, stream, sequence a head digest a neobsahuje payload ani provider credentials;
- transaction interface v pořadí lock head → insert event → insert chain record → insert export intent → compare-and-advance head; jakákoli chyba nebo head race musí rollbacknout caller transakci.

Kontrakt záměrně nemá `commit()` ani přístup k obecnému DB klientovi: budoucí adapter musí všech pět metod mapovat na tutéž již otevřenou doménovou transakci. Duplicate event ID/sequence/head/outbox uniqueness, immutable DB triggery, dual-write, export lease worker, versioned Hetzner S3 bundle a offline verifier jsou až další expand-only řezy. Historická pozorování se nesmí vložit jako backdated native historie; strict schema odmítá dodatečné legacy timestampy a budoucí backfill musí použít nový observation event s unknown completeness.

## 3. R11-B warehouse lock order

`reconcileSourceMovements()` před prvním čtením aplikované contribution získá row locky všech historických i cílových warehouse item ID v numericky vzestupném pořadí. Používá `FOR NO KEY UPDATE`: stále serializuje quantity/price writery, ale nekoliduje s PostgreSQL `KEY SHARE`, který už mohl vzniknout změnou material FK na nový item. Tím A→B a B→A nemohou držet opačné první write locky. Stávající reversal/desired movement pořadí a výpočet ceny se nemění.

DB regression test vytváří dvě opačné rematch transakce, synchronizuje je po změně FK a test-only trigger krátce zdrží oba storno inserty. Bariéra má bounded timeout a při chybě jednoho workeru uvolní druhý; function/trigger setup i cleanup jsou pod stejným `try/finally`. Po úspěchu musí být oba cached stavy i ledger sum `70`, oba source nety `-30` a každý source musí skončit na opačném cíli.

Residual: patch řeší lock inversion mezi různými source. Dvě souběžné reconciliace **stejného** `(sourceType, sourceId)` mohou stále načíst starý source snapshot před čekáním. Izolovaný transaction advisory lock přidaný uvnitř jednoho `reconcileSourceMovements()` není bezpečný obecný fix: vyšší transakce volají více source reconcile v různém pořadí a deadlock by se mohl přesunout na source locky. Další řez musí nejprve zmapovat celý batch a získat source i item locky v jednom globálním pořadí před prvním reconcile.

## 4. R11-C external-account durable idempotency – lokálně implementováno

Existující `api_idempotency_records` je nyní lokálně znovupoužit bez nové migrace přes fail-closed policy dispatcher:

1. přesný matcher šesti lifecycle mutací;
2. aktuální `requireVaultStepUp` před jakýmkoli ledger read/write;
3. reserved scope `online:external-accounts:v1`, nezávislý na offline epochě;
4. canonical route path a stabilní actor/method/path/key binding;
5. request fingerprint i replay response jako authenticated `mve1` secret envelope; nikdy plaintext nebo prostý password-body hash;
6. serialization/keyring/size chyba přejde do `ambiguous`, nikdy do nového automatického side effectu;
7. replay vrátí uloženou odpověď bez opakování route side effectu;
8. frontend uchovává v `sessionStorage` pouze method/path slot, opaque idempotency key a `retryable|ambiguous`; tělo, username, heslo ani body hash se neukládají;
9. síťový retry i návrat po step-up použije stejný key; po 5xx/ambiguous/reused key se další mutace zablokují, dokud operátor neobnoví seznam/detail, neověří skutečný stav a výslovně nepovolí nový pokus.

Serverový disposable PostgreSQL 16 test ověřuje online scope precedence, encrypted request fingerprint/response, replay bez druhého side effectu, key reuse, ciphertext tamper a chybějící keyring. Frontendový test ověřuje same-key retry, obnovení z uloženého intentu, ambiguous block/explicit clear, biometric retry a absenci citlivého payloadu ve storage.

## 5. R13-A approved cost-document containment – lokálně implementováno

`splitLine()` a `deleteDocument()` nyní zamknou cílový `billing_documents` row pomocí `FOR UPDATE`, znovu načtou stav uvnitř stejné transakce a před první obsahovou nebo destruktivní změnou odmítnou `approved` dokument s HTTP 409. Hard-delete zároveň kontroluje invoiced lines až pod stejným zámkem, takže mezi předběžnou kontrolou a delete/reconciliation cestou nevzniká dřívější race window.

DB regrese dokládají dvě oddělené hranice:

- approved stock line nelze rozdělit; původní line, cached quantity i append-only warehouse ledger zůstávají beze změny;
- approved source document nelze hard-delete a price provenance zůstává navázaná; až explicitní návrat do `needs_review` dovolí dnešní delete tok a jeho stávající release/reconciliation chování.

Toto je záměrně pouze containment. Není to immutable účetní lifecycle: DB trigger/privilege lock, canonical document version, correction relation, append-only payment/status eventy, PDF/source digests a archive export zatím neexistují. Přímý SQL writer proto stále není pokryt a R13 zůstává **NOT READY**.

## 6. R13-B invoice payment containment – lokálně implementováno

`updateInvoiceStatus()` nyní načte fakturu pod `FOR UPDATE` uvnitř jediné transakce. Pouze `issued`/`sent` může postoupit na `sent`/`paid`; `paid → sent`, změna již zaznamenaného data/částky a payment fields na cíli `sent` jsou odmítnuty. Přesný `paid → paid` replay je idempotentní. Status změna a audit s konkrétním actorem a serverovým bounded reason code (`manual_delivery_confirmation` nebo `manual_payment_confirmation`) se zapíší ve stejné transakci, takže chyba audit insertu rollbackne i fakturu.

Disposable DB regrese pokrývá immutable payment evidence, exact replay, validaci data/částky, deterministický souběh `paid` proti `sent` a rollback při selhání auditu. Tento řez neimplementuje refund, storno ani append-only payment/correction event. Původní `invoices` row zůstává current projection a R13 je nadále **NOT READY**.

## 7. R13-C invoice cancellation containment – lokálně implementováno

Storno request nyní povinně nese jeden z pěti registrovaných reason codes (`customer_complaint`, `incorrect_job`, `billing_error`, `duplicate_invoice`, `order_cancelled`). Service jej znovu validuje, zapíše pouze bounded code do atomického auditu a pod stejným invoice row lockem odmítne přímé storno stavu `paid` i jakéhokoli řádku s nenulovým `paidDate` nebo `paidAmount`.

Klient stejný uzavřený registr nabízí jako povinný výběr. U zaplacené faktury už nezobrazuje „Upravit úhradu“ ani přímé „Stornovat“; backend zůstává autoritativní pro starého nebo upraveného klienta. DB test dokládá invalid reason, bounded audit, payment-evidence rejection, deterministický payment-vs-cancel race a rollback storna při selhání auditu.

Toto stále není účetní correction chain: nezaplacené storno mutuje current row a teprve budoucí immutable version/event/relation model vytvoří nový linked artifact. Zaplacená faktura je do té doby fail-closed a její legitimní refund/correction cesta zatím není implementována.

## 8. R10-A direct privacy deletion containment – lokálně implementováno

Nový fail-closed middleware je umístěný přímo před pěti legacy handlery: `/gdpr/erase`, `DELETE /customers/:id`, `DELETE /customer-contacts/:id`, `DELETE /customer-sites/:id` a `DELETE /people/:id`. Každá cesta bez čtení subjektu nebo DB/storage side effectu vrátí `409 privacy_case_required`. Gate záměrně nemá environment flag, bypass header ani `next()` větev; budoucí řízený výmaz musí vzniknout jako nová, samostatně auditovaná privacy-case cesta.

OpenAPI označuje staré mutace jako deprecated a dokumentuje fail-closed 409. GDPR UI ponechává export, ale vysvětluje nutnost privacy case, kontroly zákonné retence a legal hold; zákaznické, kontaktní, site a person obrazovky už přímé delete mutace nevolají ani nenabízejí.

Tento řez pouze odstraňuje aktuální destruktivní bypass. Neimplementuje úplný subject resolver, identity verification, retention/hold policy, durable DB–S3/provider execution, reconciler, incident clock ani evidence bundle. R10 proto zůstává **NOT READY** a právní hodnoty zůstávají `DECISION_REQUIRED`.

## 9. R12-A-B durable side-effect contract a callsite inventory – lokálně implementováno

Nový čistý runtime kontrakt sjednocuje tři dosud oddělené crash-window třídy: produktový e-mail, managed-object write/delete a inbox message ingest. Každá operace má strict canonical intent s UUID, hashed idempotency key, `mve1` payload-reference protection, pouze hashovanými recipient/object/provider identitami a domain-separated SHA-256. Write intent objektu začíná `planned`; samostatný delete intent začíná `delete_pending`, takže zfalšovaný delete nemůže vstoupit do write větve.

Mutable projection má monotonic revision/attempt a aktivní `delivering`/`writing`/`deleting`/`processing` stav vždy nese bounded hashed lease. Každý přechod vytváří strict append-only event s expected/next revision. Start práce outcome evidence zakazuje; každý dokončený krok ji naopak vyžaduje. `unknown`, `dead_letter` a `repair_required` nelze automaticky retrynout ani označit za úspěch: je nutný operator trigger a samostatný resolution-evidence digest.

R12-B přidává minimální port pro jednu již otevřenou doménovou transakci. Inicializace vloží intent před revision-zero projekcí. Přechod nejprve zamkne a ověří identitu projekce, vytvoří immutable event a až poté provede compare-and-advance; neúspěch vždy vyhodí výjimku a vyžaduje rollback caller transakce. Rozhraní záměrně neobsahuje commit/rollback, obecný DB klient ani provider call.

Exact source-tree drift registr obsahuje 40 kombinací soubor/symbol. Pokrývá 13 syntaktických delivery/provider invokací, 45 běžných managed-object write/delete invokací a dvě recovery-stream invokace svázané s odděleným object-recovery evidence plane. Všech 58 běžných invokací je označeno `legacy-unbound`; přidání, odebrání nebo přesun přímého volání bez review nyní failuje hermetický test. Počty jsou statická invokace ve zdrojovém kódu, nikoli počet unikátních business operací.

Kontrakt zatím nevytváří durable tabulku, konkrétní DB adapter, worker, provider adapter, inventory reconciler ani repair UI a žádný dnešní SMTP/S3/IMAP caller na něj není přepojen. R12 proto zůstává **NOT READY**. Další expand-only řez musí dodat durable rows/constraints a teprve potom lze migrovat první fakturační nebo podpisovou cestu.

## 10. R13-D0/D1/D2 immutable accounting lifecycle, persistence a DB expand vrstva – lokálně implementováno

Nový version envelope pokrývá outgoing invoice i incoming cost document. Strict schema váže aggregate ID, verzi a účel na úplný snapshot, canonical součty řádků, ověřené source/rendered artifact digests, provenance a domain-separated SHA-256 snapshotu, artifact setu i celého envelope. U vystavené faktury snapshot zahrnuje customer i supplier identitu, line/source-link set, payment terms, presentation mode a totals; u cost documentu header, supplier, lines, references a všechny source files.

Nativní verze vyžaduje exact sorted provenance záznam pro každý scalar/null leaf snapshotu. Každý leaf proto nese explicitní zdroj `human`, `isdoc`, `ai`, `email` nebo `system`, actor/source evidence a případný extraction run. Raw AI odpověď není součástí immutable důkazu. Legacy cutover smí vytvořit právě jeden `legacy_observation`, zaznamenaný migration plane s `historicalCompleteness = unknown`, bez domyšleného effective času, historického actora nebo field eventů. Legacy invoice PDF a cost-document source file musí mít skutečný content digest; chybějící nebo neshodný objekt bude budoucí exception queue, nikoli vymyšlený hash.

Lifecycle vrstva odděluje tři append-only proudy: hash-linked document status events, invoice payment delta events a immutable version relations. Přijetí platby je kladný event; correction/refund/reversal je nový nenulový nebo záporný event s odkazem na dřívější event. `supersedes`, `corrects`, `credits` a `voids` vždy vážou dvě konkrétní immutable verze. Business void vyžaduje cancellation-notice artifact a `void_confirmed` event na původní faktuře; correction verifier vyžaduje shodný actor, recorded time, reason-detail a evidence digest mezi eventem a relation. Current invoice/cost-document row se tím nestává důkazem a nesmí být přepsán jako náhrada historie.

R13-D1 přidává adapter surface pro jednu již otevřenou doménovou transakci. Neexponuje commit/rollback ani obecný DB klient. Zamyká existující accounting rooty v deterministickém pořadí, vynucuje exact successor version/lifecycle/payment headu a pro initial version, standalone event, payment nebo correction bundle vloží ve stejné transakci také canonical `accounting-export-intent/v1`. Correction bundle atomicky váže nový version, relation, lifecycle event, outbox intent a všechny dotčené head transitions; CAS failure vyžaduje rollback caller transakce.

Source-tree drift registr exactně sleduje 15 veřejných write seamů. Šest terminálních seamů zůstává označeno `contract-defined-not-persisted`; devět draft/provenance seamů má row-locked approved nebo accounting-terminal containment. `updateDocument` nyní bere invoice-document row lock před kontrolou `approved` i před updatem. Forced AI nesmí přepsat approved/ignored/reviewed/merged doklad a extraction worker smí forced duplicate zpracovat pouze jako dosavadní explicitní recovery výjimku; schválený doklad nikdy automaticky nevrací do review.

R13-D2 rozšiřuje head state o monotónní revision, přidává šest additive Drizzle tabulek a konkrétní tx adapter bez vlastního commit/rollback. Nečíslovaná SQL šablona mimo migrační adresář obsahuje canonical-envelope identity CHECKy, append-only triggery, root/version binding, omezeně mutovatelný export outbox a exact revision+1 head guard. Šablona prošla na disposable PostgreSQL 16, ale nebyla přidělena jako migrace ani spuštěna proti stagingu či produkci.

Číslovaná migrace, route cutover šesti terminálních seamů, legacy backfill, archive worker/verifier, fault cutover testy a UI stále chybí. R13 proto zůstává **NOT READY**.

## 11. R17 direct-void containment – lokálně implementováno

`voidWorkSession()` i aggregate `removeTimeTracking()` zamykají session řádky v numerickém pořadí a před první změnou odmítnou `ready`/`billed` stav nebo aktivní `reserved`/`billed` billing link. Aggregate cesta ověří celý set, takže částečný void nevznikne. Po explicitním uvolnění billing linku může dnešní `unbilled` session projít standardním append-only work-session eventem.

Toto je pouze bezpečná blokace destruktivní cesty. Schválený business void billed práce při reklamaci nebo chybné zakázce stále vyžaduje nový linked time event, zápornou korekci a R13 correction/storno artifact; původní session, link ani doklad se nesmí přepsat.

## 12. Kontroly checkpointu

- Unit/contract: targeted `evidence-hash` + `audit-event-envelope` + `audit-chain-contract` **40/40 PASS**, včetně exact canonical UTF-8 bytes, chain/head/outbox mutations a rollback interface paths.
- API TypeScript: `tsc --noEmit` **PASS**.
- Warehouse DB test: disposable loopback PostgreSQL 16 přes `run-safe-test-db.mjs`, **11/11 PASS**. Dočasný container měl limit 1 CPU / 1 GiB a po testu byl odstraněn.
- Cost-document price/provenance DB test: disposable loopback PostgreSQL 16, **19/19 PASS**; approved delete rejection i následný explicitní návrat do review jsou ověřeny a container byl odstraněn.
- Invoice status/cancellation containment DB test: disposable loopback PostgreSQL 16, **9/9 PASS**, včetně obou race a rollback hranic; container byl odstraněn.
- Pět dotčených invoice lifecycle DB souborů: **45/45 PASS** v pěti disposable databázích; ověřeny také activity/job rebill, cost-document release a storno-vs-rebill souběhy.
- Work-session DB test: disposable loopback PostgreSQL 16, **9/9 PASS**, včetně `ready`/`billed`/active-link odmítnutí a následného povoleného voidu po release; container byl odstraněn.
- External-account DB test: disposable loopback PostgreSQL 16, **9/9 PASS**; container byl po testu odstraněn.
- Frontend durable-intent kontrakt: **6/6 PASS**, včetně malformed retained intent fail-closed větve; frontend typecheck a scoped ESLint **PASS**.
- Invoice cancellation frontend contract: **3/3 PASS**; full frontend unit po R10-A: **179/179 PASS**.
- Privacy deletion backend contract: **11/11 PASS**; frontend containment contract: **3/3 PASS**. Oba typechecky a scoped ESLint **PASS**.
- R12 lifecycle + transaction + callsite kontrakty: **26/26 PASS**, včetně tamper/rehashed mutation, write/delete oddělení, lease, outcome evidence, operator-only unknown recovery, transakčního pořadí/rollback hranic a exact source-tree driftu.
- R13 immutable version/lifecycle/payment/relation kontrakty: **23/23 PASS**, včetně snapshot/artifact tamperu, exact leaf provenance, AI/human zdroje, legacy observation bez falešných eventů, totals/sign/date invariants, payment refund chainu a atomického correction/void bindingu.
- Full API unit po R13-D0: **710/710 PASS**; API typecheck, cílený ESLint a produkční API build **PASS**.
- R13-D1 persistence + exact write-seam kontrakty spolu s D0: **36/36 PASS**; pokrývají deterministic multi-root lock order, initial/legacy/lifecycle/payment/correction bundle, stored target binding, stale head, rollback-required CAS, canonical outbox bytes a exact 15-callsite drift.
- Forced-AI/terminal-state DB test: disposable loopback PostgreSQL 16, **24/24 PASS**; schválený doklad zůstal beze změny, stávající explicitní duplicate recovery zůstala funkční a omezený container byl po testu odstraněn.
- Extraction-worker DB regresní test: disposable loopback PostgreSQL 16, **2/2 PASS**; no-job/no-publish i queued-to-skipped publish cesta zůstala funkční a container byl po testu odstraněn.
- Full API unit po R13-D1: **723/723 PASS**; API typecheck, cílený ESLint a produkční API build **PASS**.
- R13-D2 canonical/transaction/expand kontrakty: **39/39 PASS**; revision postupuje právě jednou na změněný root a SQL/schema/adapter drift gate chrání šest exact tabulek, canonical identity, root locks a caller-owned CAS.
- R13-D2 disposable PostgreSQL 16: **5/5 PASS**; nečíslovaná SQL šablona prošla nad standardními 105/105 migracemi, immutable tamper/delete, cross-root binding, stale adapter CAS i outbox lease byly ověřeny. Kontejner měl limit 1 CPU / 1 GiB a po testu byl odstraněn.
- Full API unit po R13-D2: **726/726 PASS**; DB i API typecheck, scoped ESLint, Prettier, `git diff --check` a produkční API build **PASS**.
- OpenAPI codegen byl spuštěn dvakrát po sobě: všechny tři generované soubory měly mezi běhy shodné SHA-256; trailing blank lines generátoru byly následně odstraněny a `git diff --check` zůstává gate.
- Cílený ESLint, dokumentační Prettier a `git diff --check` před lokálním commitem.

## 13. Co tento celek nedělá

- nevytváří ani nespouští migraci;
- nezapisuje do produkční DB, Coolify, GitHub, GHCR ani S3;
- nepřepojuje obecný audit middleware;
- netvrdí, že R09, R10, R11, R12, R13 nebo R17 jsou dokončeny;
- nezařazuje `0100` a nepřiděluje nové migrační číslo.
