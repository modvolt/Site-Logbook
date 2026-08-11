# R09–R13 a R17 – centrální checkpoint uzavření P1 jádra

Datum: 2026-08-11  
Auditovaný commit: `df918a5bbfb786420eba6c48844b632ba139d203`  
Stav: **NOT READY / P1 jádro před redesignem není dokončeno**  
Rozsah: lokální statický audit, kontrakt a pořadí implementace; bez změny produkčního kódu, bez nové migrace, deploye, GHCR zápisu a změny produkčních dat.

## 1. Výsledek

Repozitář má kvalitní izolované stavební bloky: transakční vystavení faktury, některé řádkové a advisory zámky, immutable job/quote/PPE důkazy, operational incident outbox, durable upload intent, effective-dated sazby, work-session eventy a disposable fault gate. Tyto mechanismy ale dosud netvoří jeden důkazní a souběhový kontrakt.

Před bezpečným redesignem a rozšiřováním účetních, časových a dokumentových funkcí je nutné uzavřít šest provázaných oblastí:

1. R09 – canonical transakční audit a ověřitelný export;
2. R10 – řízený privacy/retention/legal-hold proces;
3. R11 – DB invarianty, optimistic concurrency a oddělený migration plane;
4. R12 – durable delivery/storage lifecycle a repair queue;
5. R13 – immutable invoice/cost-document lifecycle;
6. R17 – neměnné časové a cenové snapshoty s auditovanou korekcí.

Nejde o šest nezávislých přepisů. Sdílenými základy musí být canonical event envelope, idempotency/row-version kontrakt, append-only eventy, outbox/lease kernel, immutable artifact manifest a restartovatelný expand–backfill–contract postup.

## 2. Centrální registr P1 nálezů

| Workstream              | Stav                                                                                       | Nejtvrdší potvrzená mezera                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Exit hranice                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| R09 audit/provenance    | **NOT READY**                                                                              | obecný audit vzniká best-effort až po `res.finish`; `audit_log` je mutable, bez canonical envelope a integrity; vault disclosure audit je obejitelný                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | každá kritická operace zapíše event atomicky s doménovou změnou a redigovaný export offline ověří integritu                                           |
| R10 GDPR/governance     | **NOT READY; lokální containment**                                                         | přímý erase/hard-delete je lokálně fail-closed, ale export je materiálně neúplný a neexistuje case, legal hold ani durable storage/provider plán                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | úplný subject resolver, policy/hold check, case workflow a důkaz výsledku pro každý krok                                                              |
| R11 concurrency/migrace | **NOT READY; lokální containment**                                                         | invoice status race je lokálně serializován, ale obecný ETag kontrakt, DB live billing claim a bounded migration plane stále chybí                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | conditional writes/ETag, DB invarianty, kanonický lock order a otestovaný oddělený migration/backfill plane                                           |
| R12 outbox/reconciler   | **NOT READY; kontrakt + inventura**                                                        | lifecycle i tx-adapter jsou lokálně strict a callsite drift je hlídaný, ale 58 běžných SMTP/object volání zůstává bez durable rows a upload ledger nemá reconciler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | kill v každém mezikroku skončí konzistentním stavem nebo viditelnou repair položkou                                                                   |
| R13 účetní lifecycle    | **NOT READY; lokální expand + default-dark lifecycle/correction/disposition/price caller** | canonical model, nečíslovaná trigger šablona, tx adapter, archive worker/verifier a default-dark issue/approve/cancel/status/payment seamy jsou lokálně hotové; cost-document reopen/reapprove vytváří immutable correction chain, explicitní disposition odděluje operational discard od reviewed immutable rejection a explicitní price action atomicky zapisuje version-bound observation/outbox/shadow projection. D9L připravuje fault-testovaný default-deny legacy bootstrap apply primitive, D9M jeho exact approval/preflight/receipt a D9N bounded offline artifact verifier, ale žádný runner ani aktivace neexistuje; skutečný backfill, read cutover, číslovaná migrace, provider aktivace a odvozené payment commands chybí | issued/approved obsah je DB-immutable a correction/storno/payment chain je append-only a exportovatelný                                               |
| R17 čas/sazby           | **DESIGN READY; lokální containment**                                                      | přímý void `ready`/`billed` je blokován, ale backdated sazba může přepsat snapshot a evidence-preserving billed correction chain neexistuje                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | explicitní source clock/date/rate snapshot; business void vytvoří nový time i účetní correction chain a nikdy nepřepíše původní event ani billed link |

### R09 – durable audit, provenance a důkazní export

Potvrzené blockery:

- `artifacts/api-server/src/middlewares/audit.ts` zapisuje obecný audit až po dokončení odpovědi jako fire-and-forget; úspěšná změna proto může existovat bez auditního řádku.
- `lib/db/src/schema/audit-log.ts` nemá event UUID, schema version, actor/source kind, correlation/idempotency, authoritative before/after, reason, artifact reference, completeness ani hash-chain metadata.
- Lokální R09-C odstranila serializaci request body z generic middleware; `audit_log.summary` je nyní pouze metadata-only metoda a bearer-redigovaná cesta. Stále však nejde o atomický ani autoritativní persisted delta a starý `audit_log` zůstává non-evidentiary telemetry.
- `GET /customers/:id/device-credentials` dešifruje a vrací credentialy, zatímco view/copy audit je samostatný klientský POST; skutečné zveřejnění tajemství tedy nelze prokázat.
- AI aplikace a Gmail import nemají vždy atomický immutable provenance event. `ai_raw_json` je mutable raw payload, nikoli minimalizovaný důkaz.
- Neexistuje canonical JSONL/manifest/checksum verifier ani externí append-only export.

Požadovaný základ: `audit_events`, `audit_chain_heads`, `audit_export_outbox`, shared transakční writer, strict allowlist payloadů, server-owned vault reveal a export worker podle již ověřeného lease/outbox vzoru. Starý `audit_log` zůstane `legacy_non_evidentiary`; nesmí být zpětně vydáván za neměnnou historii.

### R10 – GDPR governance, DSAR, retence a incidenty

Potvrzené blockery:

- chybí ROPA/data inventory, processor/subprocessor registry, účely/právní tituly a schválená retention/hold matrix;
- neexistuje privacy case, identity verification, lhůta, vlastník, stavový automat, schválení ani evidence výjimky;
- export customer/contact/person nepokrývá související invoice/quote snapshoty, OOPP, work sessions, účty, podpisy, soubory, logy, veřejné tokeny a další domény;
- legacy erase handler nejdříve commituje DB a objekty maže best-effort; R10-A jej proto lokálně blokuje fail-closed middlewarem ještě před prvním read/write side effectem;
- přímé delete routy customer/contact/site/person jsou stejným neodemknutelným middlewarem zablokované a jejich ovládání odstraněné z UI; skutečný privacy-case executor ale dosud neexistuje;
- `operational_incidents` není breach register: chybí scope osobních údajů/subjektů, 72hodinová lhůta, risk assessment, DPO/úřad a rozhodnutí o oznámení;
- nejsou GDPR/DSAR acceptance testy.

Bezpečná technická hranice je nejprve governance packet a fail-closed návrh. Právní hodnoty zůstávají `DECISION_REQUIRED`; aplikace je nesmí domyslet. Automatický výmaz nesmí začít před R08/R12/R13 a schváleným legal-hold modelem.

### R11 – DB invarianty, optimistic locking a online migrace

Potvrzené blockery:

- business API nemá jednotný `row_version`/`ETag`/`If-Match`; zastaralý klient může přepsat novější změnu;
- lokální R13-B nyní `updateInvoiceStatus()` serializuje přes `FOR UPDATE`, takže souběh `paid`/`sent` neztratí platební údaje; obecný aggregate revision/ETag standard však chybí;
- dvojí billing je omezen aplikačními zámky, ale DB dovolí dvě live vazby na stejný zdroj;
- external-account mutace byly v lokálním R11-C řezu odděleny od offline epochy explicitním stabilním route contractem, pre-ledger vault step-up a encrypted-at-rest replay metadata; změna zatím není commitnutá, publikovaná ani nasazená a obecný online opt-in pro ostatní domény chybí;
- lokální R11-B řadí item locky a odstraňuje doložený A→B/B→A cross-source deadlock; R11-D po lock waitu znovu načte source ledger a nový nezamknutý target odmítne konfliktem; R11-F/G přidává sdílený batch item-lock plán a převádí cost-document stock lines i material sync. Vnější transakce s několika navazujícími batch fázemi stále vyžadují jeden společný outer plan před prvním reconcile;
- lokální R11-E už běžné záporné warehouse delty po item locku kontroluje proti authoritative součtu append-only ledgeru a odmítá je konfliktem 409; auditovaný controlled override, globální multi-source planner a publikace/nasazení této změny zatím chybí;
- API container spouští migrátor při startu; advisory lock nemá bounded wait, `lock_timeout` ani `statement_timeout`;
- chybí jednotný restartovatelný backfill s canonical plan hashem, checkpointem, resume a reconciliation na realistickém objemu.

Požadovaný základ: aggregate version kontrakt, conditional update, durable idempotency opt-in, unique live billing claim, kanonický lock order a one-shot predeploy migrátor. Expand, backfill, validate a contract musí být oddělené checkpointy.

### R12 – durable outbox a reconciler DB–storage–SMTP

Potvrzené blockery:

- quote, invoice reminder, PPE confirmation, invoice a credential e-maily používají přímé SMTP bez obecného durable delivery row a stabilního RFC Message-ID;
- pád po SMTP acceptance před DB acknowledge může vytvořit doručený, ale neevidovaný e-mail a další retry může zprávu zdvojit;
- job sheet může být odeslán i po selhání interní archivace;
- většina `putPrivateObject`/`deletePrivateObject` callsites obchází `object_uploads` a nemá desired/observed lifecycle;
- upload ledger nemá worker pro `pending` bez objektu, `pending` s objektem, `failed` s objektem ani neclaimnutý `stored` stav;
- neexistuje inventory comparison a operator UI pro missing/unbound/failed finalize/failed delete;
- manuální IMAP poll obchází scheduler lock a message není rezervována před ingestem;
- R14 ověřuje provider outage, ne kill/restart po každém skutečném DB–SMTP–S3 mezikroku.

Požadovaný základ: `delivery_outbox` + immutable attempt events, stabilní delivery key, explicitní `unknown`, encrypted payload/reference, `managed_objects` + storage operations, inbox lease a redigovaná repair queue. Legacy mail zůstane `legacy_unknown`; orphan inventory nikdy automaticky nemaže.

Lokální R12-A tento základ formalizuje bez DDL: společný canonical intent neobsahuje adresáta, object key ani payload, pouze bounded metadata, SHA-256 reference a povinnou `mve1` ochranu. Delivery, samostatný object write/delete a inbox reservation mají exact state graph, monotonic revision/attempt, active-state lease a append-only transition event. Přechod ze stavů `unknown`, `dead_letter` nebo `repair_required` vyžaduje operátora i resolution evidence; každý dokončený krok nese outcome evidence.

R12-B přidává úzký transakční port. Inicializace vloží canonical intent a jeho revision-zero projekci přes jeden caller-owned transaction adapter; přechod nejprve zamkne a znovu ověří projekci, poté vloží immutable event a provede compare-and-advance. Každá chyba nebo ztracený compare vyhodí výjimku, takže caller musí zrušit celou doménovou transakci. Port záměrně neobsahuje commit/rollback, obecný DB klient ani provider side effect.

Exact source-tree registr a drift test navíc evidují 40 kombinací soubor/symbol: 13 syntaktických delivery/provider volání a 45 běžných managed-object write/delete volání zůstává `legacy-unbound`; dvě recovery-stream volání jsou odděleně označena `independently-bound` k existujícímu object-recovery evidence plane. Jde o počet syntaktických invokací, nikoli počet unikátních odeslaných zpráv či objektů. Nové nebo změněné přímé volání nyní bez aktualizace registru hermetický test odmítne. Durable tabulky, konkrétní DB adapter, worker, reconciler, repair UI a zapojený produktový caller stále neexistují.

### R13 – neměnný účetní a dokumentový lifecycle

Potvrzené blockery:

- immutable versioning existuje pro job/quote/PPE, nikoli pro `invoices`, `invoice_lines`, `billing_documents` a jejich lines;
- invoice customer fields jsou snapshotované, ale supplier/settings, source links, line set, PDF/ISDOC a presentation mode nejsou spojeny canonical manifestem;
- invoice uchovává jen object path bez digestu; nahrazení objektu nelze offline odhalit;
- lokální R13-B zakazuje `paid → sent`, změnu zaznamenané platby i payment fields na `sent`; exact replay je idempotentní a status audit s actorem vzniká atomicky, ale append-only payment event stále neexistuje;
- lokální R13-C vyžaduje jeden z pěti registrovaných reason codes a odmítá přímé storno řádku s payment evidence; původní row se však stále mutuje a `corrects`/`supersedes` relation ani immutable storno event neexistují;
- návrat cost documentu ke kontrole mutuje schválený row a odstraňuje odvozenou price history;
- lokální R13-A nyní oba service-level bypassy blokuje pod row lockem; bez DB triggeru/privilege locku a immutable version však přímý SQL writer nebo jiná nezapojená cesta zůstává mimo důkazní hranici;
- forced AI reanalysis už lokálně pod row lockem odmítá schválený a účetně terminální doklad; extraction worker jej nesmí automaticky vrátit do review. Nový immutable snapshot uchovává leaf-level AI/import/human provenance, ale dosud se nikam durable neukládá.

Požadovaný základ: immutable invoice/billing-document versions, status/payment events, correction relations, canonical snapshot + artifact digests, DB triggers/privilege lock a archive verifier. Legacy rows dostanou jeden observation snapshot s `historicalCompleteness = unknown`; backfill nesmí fabricovat event sequence ani actor timestamps.

Lokální R13-D0 tento model formalizuje bez DDL. Immutable version envelope exactně váže aggregate/version/purpose, úplný invoice nebo cost-document snapshot, součty řádků, ověřené source/rendered artifact digests a SHA-256 celého envelope. Nativní verze musí mít právě jeden provenance záznam pro každý scalar/null leaf snapshotu, takže AI/ISDOC/e-mail/human původ nelze nahradit jediným mutable `aiRawJson`. Legacy issued/approved row smí vytvořit jen version-one `legacy_observation`, recorded migration plane, s neznámou historickou úplností; legacy event type záměrně neexistuje a známý invoice PDF nebo cost-document source musí být skutečně zahashovaný.

Oddělený lifecycle kontrakt přidává contiguous hash chain stavových eventů, samostatný append-only payment-delta chain a immutable `supersedes`, `corrects`, `credits`, `voids` relations. Refund/reversal je záporný event odkazující na dřívější payment event, nikoli přepis původní částky. Correction-chain verifier navíc vyžaduje, aby nový artifact, relation a event sdílely exact actor, recorded time, reason-detail a evidence digest; business void je tak reprezentován novým cancellation artifactem a eventem na původní faktuře. Bez budoucích DB constraints/triggerů a atomického writeru jde stále pouze o runtime kontrakt.

R13-D1 doplňuje transakční writer port bez commit/rollback a bez obecného DB klienta. Adapter musí zamknout existující invoice/billing-document root; empty evidence stream tak nelze obejít závodem na prvním insertu. Více rootů se zamyká deterministicky, nový version/event/payment musí být přesný následník locked headu a correction bundle ukládá version, relation, lifecycle event, canonical export intent a head transition v jedné caller-owned transakci. Compare-and-advance selhání vždy vyžaduje rollback celého doménového zápisu.

R13-D2 přidává explicitní monotónní aggregate revision, šest additive Drizzle tabulek a konkrétní adapter pro caller-owned transakci. Adapter zamyká původní invoice/billing-document root i head, zapisuje přesné canonical bytes a provádí compare-and-advance nad celým očekávaným stavem. Nečíslovaná expand SQL šablona mimo migrační adresář přidává root/version FK, canonical-envelope identity CHECKy, append-only evidence triggery, guard export intentu a head trigger, který přijme jen revision+1 svázanou s již vloženým exact successor version/event/payment řádkem. Izolovaný PostgreSQL test ověřuje tamper/delete/root mismatch, stale CAS i platný outbox lease.

R13-D3 přidává strict canonical archive bundle, checksum, manifest commit marker a offline verifier. Bounded lease worker načte právě evidence uvedené v intentu, zapíše content-addressed objekty přes create-only versioned port, přečte exact provider `VersionId` zpět a až poté CAS uloží úplný receipt. PostgreSQL store používá `FOR UPDATE SKIP LOCKED`, expirovatelný lease, retry/dead-letter a immutable terminální stav; partial upload a lost lease jsou testované jako idempotentní. Běžný object-storage adapter se nepoužívá, protože zahazuje provider version ID. Worker není runtime aktivován, nebyl proveden S3 zápis a schema zůstává pouze nečíslovanou šablonou.

R13-D4 zapojuje jediný terminální seam `issueInvoice`. Po finálním přepočtu vytváří exact issued invoice/customer/supplier/line/source-link snapshot, rendered PDF digest, úplnou leaf-level system-capture provenance pod autentizovaným issuing userem a sequence-zero `issued` event. Caller-owned adapter uloží version, event, export intent a head CAS před PDF uploadem ve stejné DB transakci. Fault test dokazuje, že odmítnutí outbox insertu rollbackne fakturu i číselnou řadu a storage call se neprovede; retry pak vytvoří právě jeden stream. Gate přijme pouze exact `ACCOUNTING_ISSUE_INVOICE_DUAL_WRITE_ENABLED=true` a default je vypnutý, protože účetní tabulky stále nejsou v číslované migraci.

R13-D5 zapojuje `approveDocument` za samostatným exact default-dark flagem. Canonical approved snapshot váže source-file content/location digesty, ordered lines, totals, references a explicitní AI/ISDOC/e-mail/human `sourceTrace`; raw AI payload ani sourceRef se neukládají. Initial approved version/event/outbox/head vznikají ve stejné transakci jako status a line confirmations. Replay znovu sestaví current version hash a pouze exact shoda je no-op; legacy approved row bez headu se nepřepisuje na nativní historii a evidence-backed reopen zůstává blokovaný do correction chainu. Fault trigger prokázal rollback dokumentu, řádků i celé evidence.

R13-D6 zapojuje `cancelInvoice` za třetím exact default-dark flagem. Vyžaduje nativní issued head a vytváří v jednom correction bundle version 2 `cancellation_notice`, deterministický PDF artifact, `voids` relation, `void_confirmed` event, export intent a head CAS. Původní issued version se nepřepisuje; mutable invoice status zůstává pouze current-state projection. Paid evidence je dál blokována, legacy invoice bez nativní hlavy čeká na backfill a outbox fault proběhne před storage uploadem.

R13-D7 zapojuje `updateInvoiceStatus` a `confirmBankPayments` za dvěma dalšími exact default-dark flagy. `sent` je samostatný lifecycle event nad current immutable version; ruční i bankovní přijetí platby jsou `received` payment eventy a nikdy se nemodelují jako lifecycle status. Event, export intent, aggregate-head CAS, audit i mutable projection sdílejí jednu caller-owned transakci. Exact replay nepřidá duplicitní řádek, legacy nebo lifecycle-drifted invoice se nefabrikuje a bankovní batch řadí invoice locky vzestupně. Bankovní source digest váže normalizovaný confirmation input, nikoli raw statement bytes; partial/multiple/refund/reversal command cesty proto zůstávají otevřené.

R13-D8 přidává default-dark cost-document correction path. Nativně verzovaný approved doklad lze vrátit pouze do `needs_review`, pouze s normalizovaným důvodem a pouze při současně zapnutém approval i correction flagu. Reopen přidá `review_reopened` event nad nezměněnou current version; následné schválení vytvoří version N+1 `correction`, `supersedes` relation a `correction_linked` event. Fault na export intentu rollbackuje i mutable projection a replay nevytváří duplicitní evidence. Accounting-backed root nelze hard-delete ani po reopen. Doklad s existující legacy warehouse price-history projection se před první změnou odmítne, protože současná tabulka je navzdory starému komentáři mutable a nemá version binding. Canonical event zatím uchovává jen digest důvodu a nikoli jeho čitelný obsah.

Exact registry nyní sleduje 17 public accounting write seamů. Devět draft/provenance cest má row-locked approved nebo accounting-terminal guard; `issueInvoice`, `approveDocument`, `cancelInvoice`, `updateInvoiceStatus` a `confirmBankPayments` jsou označeny jako plně feature-flagged atomic seamy. Explicitní `updateWarehousePricesFromDocument` je samostatný feature-flagged observation/outbox/projection seam. `setDocumentStatus` zůstává historicky smíšený, ale nový `disposeCostDocument` přesně rozděluje operational early discard a feature-flagged reviewed version/event/reason/outbox. Po aktivaci rejection flagu je přímý legacy přechod na `ignored` odmítnut. Registr je drift gate, nikoli tvrzení o dokončeném produkčním cutoveru. Warehouse-price bootstrap/read cutover, číslovaná migrace, derived payment commands, provider adapter/aktivace a UI cutover proto nadále zůstávají P1; šablona nesmí dostat číslo před vyřešením kolize veřejného `0096` a `0100` zůstává vyloučena.

R13-D9 design přesně rozdělil tři rozhodnutí. Early chybný upload nemá bezdůvodně získat neomezenou účetní retenci; již lidsky posouzený source se naopak nesmí jen označit `ignored` a později hard-delete. Schválený model odděluje operational discard od native `discarded_observation` version/eventu a ukládá čitelný bounded reason note do restricted immutable archivu; D9H/D9I jej už lokálně implementují. Warehouse price provenance používá version-bound append-only observation ledger a explicit-currency projection, ale současný D8 guard zůstane aktivní do caller dual-write a controlled parity cutoveru. Přesný decision checkpoint: `17-n-r13-d9-ignored-reason-price-provenance-design.md`.

R13-D9A lokálně uzavírá pouze čistý warehouse-price observation kontrakt. Canonical entry váže cenu a měnu na exact cost-document version/event/material line, actor/reason/timestamps a item-local sequence/hash/supersession. Verifier pokrývá initial observation, reopen withdrawal a corrected cenu i source/chain/integrity mutace. Drizzle/DDL, tx adapter, outbox/export, parity/backfill a caller activation zatím neexistují; D8 guard proto zůstává fail-closed. Checkpoint: `17-o-r13-d9a-warehouse-price-observation-contract-checkpoint.md`.

R13-D9B doplňuje neaktivovanou persistence expand vrstvu. Drizzle a nečíslovaná šablona mají immutable observation tabulku s restrictive FK, unique item sequence a exact canonical/source/chain triggery; transaction-owned adapter zamyká warehouse item i pro prázdný stream a exact replay je no-op. Disposable PostgreSQL 16 ověřil insert/replay, update/delete guard, source-price drift a predecessor drift. Export/outbox entry, parity/backfill, projection pravidlo, caller dual-write a číslovaná migrace stále chybí, takže současný D8 guard zůstává aktivní. Checkpoint: `17-p-r13-d9b-warehouse-price-persistence-checkpoint.md`.

R13-D9C atomicky přidává ke každé warehouse-price observation přesně jeden export intent ve stejné caller-owned transakci. Archive repository, bundle, manifest, bounded worker a offline CLI přijímají nový entry/operation a exactně ověřují canonical bytes, digest, observation identitu i incoming source aggregate. Exact replay bez shodného intentu je odmítnut a PostgreSQL fault injection prokázala nulový observation/outbox zbytek po selhání intent insertu. Cesta stále není připojena k approval/correction callerům, provideru ani runtime workeru; parity/backfill, current-price projection, číslovaná migrace a D8 guard zůstávají otevřené. Checkpoint: `17-q-r13-d9c-warehouse-price-archive-checkpoint.md`.

R13-D9D doplňuje čistý projection/parity verifier a opravuje correction-first item gap. Prázdný item stream může začít `corrected`, ne však `withdrawn`; pozdější observed krok musí supersedovat previous head. Reducer drží stream head odděleně od efektivní ceny a withdrawal invaliduje jen cílovou price-bearing observation, takže po odebrání novějšího dokladu obnoví poslední stále platnou cenu. Parity vyžaduje i explicitní měnu, kterou dnešní `warehouse_items` neuchovává; DB projection writer a multi-currency/FX volba proto zůstávají fail-closed. Checkpoint: `17-r-r13-d9d-warehouse-price-projection-checkpoint.md`.

R13-D9E přidává pouze read-only DB inventuru. Bounded CLI v `REPEATABLE READ READ ONLY` načte počty před daty, odmítne překročení hard capů a vydá canonical/hashovaný parity report current ceny, native streamu a minimalizovaných legacy řádků. Legacy-only položky vyžadují review; native cena bez explicitní current měny, drift, overlap nebo neprokázaná cena blokují cutover. Isolated PostgreSQL test porovnal DB snapshot před/po a prokázal nulovou mutaci. Schválené volby 1A/2A/3A oddělují early discard od reviewed rejection, ukládají bounded důvod v restricted archivu a vyžadují explicitní měnu bez implicitního FX. Checkpoint: `17-s-r13-d9e-warehouse-price-parity-audit-checkpoint.md`.

R13-D9F formalizuje volbu 3A bez zásahu do legacy runtime. Canonical shadow projection head nese exact stream/effective observation, source currency a hard `fxConversionApplied=false`; nečíslovaná projection tabulka je z observation streamu DB-validovaná, nesmazatelná a po initial insertu se posune jen exact one-sequence CAS. Preferovaný helper ukládá observation, archive intent i projection ve stejné caller-owned transakci. Approval/correction caller ani read path zatím zapojen není a `warehouse_items.purchase_price` se nemění. Checkpoint: `17-t-r13-d9f-explicit-currency-shadow-projection-checkpoint.md`.

R13-D9G povyšuje read-only parity report na v2 a načítá exact canonical projection head. Verifier jej rekanonizuje, přehraje celý observation stream a vyžaduje exact stream/effective binding; native stream bez headu je explicitní `native_projection_missing` block. Validní head dodá current ISO měnu a report zároveň porovná numeric continuity se stále používaným legacy item sloupcem. API unit 779/779 a dva isolated DB soubory 6/6 prošly; žádný apply/backfill režim neexistuje. Checkpoint: `17-u-r13-d9g-projection-aware-parity-checkpoint.md`.

R13-D9H/D9I implementuje schválené volby 1A/2A. Canonical restricted reason artifact váže čitelný NFC reason 3–1000, code a digest na exact lifecycle event; DB řádek i archive bundle jsou immutable a používají oddělený `accounting-evidence-restricted/v1` namespace. Explicitní disposition endpoint/policy dovolí early operational discard jen před review/extraction/domain hranicí a reviewed rejection ukládá native `discarded_observation`, `ignored` event, reason artifact, dva export intents a head ve stejné transakci jako status. Outbox fault rollbackuje celý celek a hard delete je po vzniku headu blokován. OpenAPI/klienti jsou připravené, ale UI, číslovaná migrace, flags a provider nejsou aktivované. Checkpoint: `17-v-r13-d9h-d9i-reason-disposition-checkpoint.md`.

R13-D9J připojuje explicitní warehouse-price action k current immutable approval/correction versionu za exact default-dark flagem. Deterministická observation, export intent, source-currency/no-FX shadow head a legacy current/history jsou atomické; reopen vyžaduje úplné coverage/parity, appenduje withdrawals a teprve potom odstraňuje mutable history. Item locks jsou vzestupné, match se po čekání revaliduje a correction smí bezpečně navázat i na neprázdný cílový item stream. Non-CZK, precision loss a nebootstrapped legacy state jsou fail-closed. Číslovaná migrace, bootstrap/backfill, read/UI cutover, provider a activation nejsou provedené. Checkpoint: `17-w-r13-d9j-warehouse-price-caller-checkpoint.md`.

R13-D9K doplňuje čistě read-only bootstrap preflight. Exact canonical parity bytes a schválený raw-file digest se deterministicky převádějí na strict canonical dry-run plán. Každý `legacy_only` item má právě jednoho kandidáta `legacy_observation`, který váže všechny legacy row hashe, explicitní current source měnu a unknown historical completeness bez actor/effective/lifecycle fabricace. Unsafe parity stavy jsou blokery a CLI nemá apply, DB ani provider surface. Cílené kontrakty prošly 9/9, isolated parity→plan DB důkaz 2/2 a celý API unit balík 802/802. Migrace, skutečný bootstrap/backfill, staging/production read, runtime activation a cutover nejsou provedené. Checkpoint: `17-x-r13-d9k-warehouse-price-bootstrap-preflight-checkpoint.md`.

R13-D9L rozšiřuje pouze lokální default-deny apply vrstvu. Canonical autorizace exactně váže report, plán, jejich raw-file hashe, target fingerprint, candidate count, externí approval digest a přijetí unknown-history/source-currency hranice. Transaction-owned adapter nejprve vzestupně zamkne a pod zámkem revaliduje všechny itemy; teprve úplná fresh dávka atomicky vloží legacy observation, export intent a shadow head. Úplný exact replay je no-op, stale/mixed partial stav a outbox fault jsou odmítnuty. Unified stream dovolí legacy jen jako sequence 0 s jediným explicitním native successor pravidlem a DB constraint odmítá i přímou actor/event/effective/FX fabricaci. API unit 809/809 a isolated PostgreSQL sada 6/6 prošly. Neexistuje apply CLI/route/flag, očíslovaná migrace, skutečný staging/production bootstrap ani cutover. Checkpoint: `17-y-r13-d9l-warehouse-price-bootstrap-apply-contract-checkpoint.md`.

R13-D9M doplňuje strict raw approval, activation-preflight a post-commit receipt bez spuštění. Preflight vyžaduje exact `site-logbook-staging`, source/target binding, předem strictně ověřené staging release evidence, shodný known code/applied migration set, přesně dvě opaque produkční identity bez odvozeného významu, `0100` exclusion, již aplikovanou expand migraci a čerstvý restore test do 256 MiB. Receipt odděluje approved source report od skutečného before/after snapshotu, správně rozlišuje fresh apply a exact replay a znovu váže všechny raw bytes; candidate itemy musí skončit jako exact `legacy_bootstrap_match` a ostatní se nesmí změnit. API unit 816/816, typecheck, lint a build prošly. Neexistuje runner, skutečné číslo migrace, staging artifact/run ani feature/read/UI cutover. Checkpoint: `17-z-r13-d9m-warehouse-price-activation-preflight-checkpoint.md`.

R13-D9N přidává výhradně offline verifier přes exact dedicated artifact directory. Preflight set má devět, receipt set dvanáct přesně pojmenovaných souborů; extra/missing/symlink/read-time drift a všechny mutation aliasy jsou fail-closed. Trusted entry point je explicitní preflight file SHA a u receipt režimu i receipt file SHA. Canonical lineage/backup sidecary se porovnají s embedded preflightem a staging PASS summary nově váže hash exact root release evidence. Souhrnný limit je 384 MiB, čtení sekvenční a CLI nic nezapisuje. D9M/D9N 12/12, schema-v4 evidence 12/12 a runtime contract 27/27 prošly; aktivace zůstává NO-GO. Checkpoint: `17-aa-r13-d9n-warehouse-price-offline-verifier-checkpoint.md`.

R13-D9O ukládá provozní capture/readiness/abort kontrakt, nikoli runner. Každý z 12 souborů má jediný povolený producer a preflight/receipt trusted hash musí vzniknout v separately reviewed kroku mimo ověřovaný adresář. Matrix výslovně zakazuje blind retry po unknown outcome, přepis/mazání evidence po commitu, automatický second apply při partial stavu a jakýkoli feature/read cutover bez PASS receipt. Dokumentovaný postup obsahuje pouze D9N read-only verifier příkazy; public-main integration, migrace, apply, deploy a provider write jsou stále BLOCKED. Checkpoint: `17-ab-r13-d9o-warehouse-price-activation-capture-runbook.md`.

### R17 – historie času, sazeb, cen a korekcí

Detailní nálezy a cílový kontrakt jsou v:

- `docs/audit/17-a-time-rate-history-gap-audit.md`;
- `docs/audit/17-b-time-rate-history-contract.md`.

P1 exit vyžaduje zejména:

- nepřepisovat žádný existující nenulový rate snapshot;
- uložit source clock, IANA timezone, UTC offset a effective work date;
- manager-only approve/reject s reason, actor, expected revision a eventem;
- korekci jako nový linked row, nikoli změnu původní session;
- prostý destruktivní void pouze pro unbilled/non-billable session;
- `ready` uvolnit atomicky přes billing service; business void `billed` práce povolit jen jako nový append-only time event a navázaný R13 correction/storno chain bez změny původní session nebo dokladu.

Lokální containment nyní první hranici vynucuje také podle aktivních billing linků a odmítá `ready`/`billed` ještě před první změnou. Druhá, evidence-preserving correction cesta zatím implementována není.

## 3. Společné příčiny

### C1 – current row plní současně projekci i údajný důkaz

Invoice status/payment, cost document status a některé work-session stavy se přepisují na aktuálním řádku. Current projection je užitečná pro rychlé čtení, ale nesmí být jediným historickým důkazem. Historii musí tvořit immutable version/event rows; projection se aktualizuje ve stejné transakci a lze ji z eventů zkontrolovat.

### C2 – kritické requesty nemají společný atomic writer

Audit, outbox a artifact binding vznikají po doménové změně, best-effort nebo v jiné transakci. Sdílený writer musí ve stejné DB transakci vytvořit doménovou změnu, canonical event a případný outbox intent.

### C3 – concurrency je řešena lokálně, ne kontraktem

Některé services zamykají správně, jiné používají read-check-write nebo nemají expected revision. Aggregate version, idempotency a lock order musí být standard, ne ručně odlišná implementace v každé route.

### C4 – DB, S3 a SMTP nemají společný desired/observed lifecycle

Přímé provider volání nemůže atomicky potvrdit DB i externí systém. DB musí nejprve uložit intent a stabilní identitu; worker provede side effect, zaznamená výsledek a nejednoznačný výsledek pošle do `unknown/repair`, nikoli do tichého retry.

### C5 – migrační a backfill plane není oddělen od API startupu

P1 změny budou potřebovat více expand-only migrací a řízených backfillů. API startup nesmí čekat na DDL ani spouštět velký backfill. Každá dávka musí mít přesný plan hash, DB fingerprint, cursor, reconciliation a abort podmínky.

## 4. Doporučené pořadí dokončení

### Vlna 0 – integrace větve a migračního journalu

1. **Dokončeno 2026-08-11:** read-only zachytit skutečný produkční deployed commit a migration journal; výsledek je v `17-d-production-lineage-inventory.md`.
2. Integrovat aktuální public `main` až po samostatném schválení konflikt resolution.
3. Vyřešit kolizi dvou různých migrací `0096` bez přepsání již aplikované identity a bez zařazení `0100`.
4. Regenerovat snapshot/journal/API klienty a zopakovat Quality gate na přesném výsledném SHA.

Dokud není znám skutečný produkční journal, nesmí být přiděleno číslo žádné R09–R13/R17 migraci.

### Vlna 1 – kontrakty a negativní testy, bez migrace

1. canonical event envelope + critical-operation inventory;
2. aggregate version/ETag/idempotency/lock-order kontrakt;
3. **Lokálně implementován kontrakt a exact inventura, bez DDL:** delivery/object/inbox state machines, canonical intent/event hash, bounded lease, fail-closed unknown recovery, caller-owned transaction port a drift gate všech přímých callsiteů;
4. **Lokálně implementován canonical kontrakt, bez DDL:** invoice/cost-document version, leaf provenance, artifact manifest, hash-linked lifecycle/payment eventy a correction relation/binding;
5. R17 time/rate/review/correction kontrakt;
6. R10 data map a všechny právní hodnoty jako `DECISION_REQUIRED`;
7. characterization testy dnešních bypassů a negativní acceptance testy cílových invariantů.

### Vlna 2 – úzké containment opravy bez nové tabulky

Po schválení behavior změny:

1. kanonický warehouse lock order a reverse-order deadlock test;
2. **Lokálně implementováno, bez deploye:** skutečný durable idempotency opt-in pro external accounts;
3. **Lokálně implementováno, bez deploye:** fail-closed blokace approved `splitLine`/`deleteDocument` pod řádkovým zámkem;
4. **Lokálně implementováno, bez deploye:** zákaz destruktivního `paid → sent` a změny payment evidence; actor + bounded reason na status operacích ve stejné transakci;
5. **Lokálně implementováno, bez deploye:** blokace přímého voidu `ready`/`billed` work session i aktivního billing linku; evidence-preserving correction chain pro reklamaci/chybnou zakázku zůstává dalším R13/R17 řezem;
6. **Lokálně implementováno, bez deploye:** povinný registrovaný důvod storna faktury a blokace přímého storna při jakémkoli payment evidence; paid UI nenabízí změnu úhrady ani přímé storno;
7. **Lokálně implementováno, bez deploye:** fail-closed blokace přímého GDPR erase a customer/contact/site/person hard-delete cest bez environment/header bypassu; UI ponechává export, ale přímé destruktivní akce nenabízí.

### Vlna 3 – sdílené expand-only tabulky

Oddělené migrace, ne jeden velký release:

1. R09 event/chain/export outbox;
2. R11 row versions, live billing claims a případné stock override evidence;
3. R12 delivery/object/inbox lifecycle;
4. R13 invoice/billing-document versions/events/relations;
5. R17 source-time/review/correction fields a immutable event enforcement;
6. R10 privacy requests/holds/policies/tasks/evidence.

### Vlna 4 – dual-write a doménové převody

Po jednotlivých kritických cestách převést:

1. invoice issue/status/payment/cancel;
2. approved cost-document lifecycle;
3. vault reveal, AI apply a Gmail import;
4. quote/job/PPE/invoice e-mail;
5. work-session completion/review/correction/billing;
6. privacy export/restrict/erase tasky.

Staré sloupce zůstanou dočasnou projekcí. Žádný destructive contract krok neproběhne ve stejné vlně.

### Vlna 5 – workers, export a repair

1. audit export worker + offline verifier;
2. delivery/storage/inbox workers s bounded lease/retry/dead-letter;
3. accounting archive manifest a correction-chain export;
4. privacy execution/reconciliation a breach deadline worker;
5. redigovaná operator UI pro conflict/unknown/dead-letter/hold/repair.

### Vlna 6 – řízený backfill a cutover

1. read-only inventory a canonical plan artifact;
2. legacy rows pouze jako observed/unknown, bez falešného actor/reason/event času;
3. malé restartovatelné dávky s reconciliation;
4. parity report, constraint validation a read cutover;
5. contract cleanup až v samostatném pozdějším release.

### Vlna 7 – staging a evidence

1. izolovaná obnova úplné schválené produkční kopie;
2. volume/lock/latency měření migrací a backfillů;
3. kill-point testy pro každý DB–S3–SMTP mezikrok;
4. concurrency testy pro status, claims, stock, review a correction;
5. immutable manifest/checksum/export verifier;
6. přesný final-SHA Quality gate před jakýmkoli rolloutem.

## 5. Kritická rozhodnutí

### D1 – migrační lineage

**Read-only zjištění 2026-08-11:** produkce běží na `6ae3072a3eb80b9647bc66abb80d979c5ec9e2a5`, obsahuje všech 97 očekávaných journal položek do `0096_far_smiling_tiger` a dvě další opaque legacy položky. Přesný produkční checkpoint je v `17-d-production-lineage-inventory.md`. D9P následně ověřil live public `main`, draft PR #15, exact konfliktový strom a uložil nejmenší forward-only reconciliation tvar v `17-ac-r13-d9p-public-main-migration-integration-readiness.md`: produkční `0096` zůstane byte-exact, dosud neprodukční session/idempotency změny se mají po schválení spojit do jedné regenerované `0097`, `0098`–`0105` si zachovají význam a `0100` zůstane vyloučena. Integrace, nové timestamps, snapshot rebuild, commit/push ani migrace nebyly provedeny.

### D2 – záporný sklad

Je nutné zvolit jednu politiku:

- strict: authoritative quantity nikdy neklesne pod nulu;
- controlled override: záporný stav smí vytvořit pouze zvláštní role s povinným důvodem, limitem a immutable eventem.

**Rozhodnutí 2026-08-11:** běžná cesta nesmí vytvořit záporný authoritative stav. Controlled override může později dostat pouze zvláštní role s povinným důvodem, limitem a immutable eventem; bez těchto podmínek fail-closed.

### D3 – časová korekce a billed práce

**Rozhodnutí 2026-08-11:** korekce konkrétní session dědí její effective work date a rate snapshot; agregovaná korekce vyžaduje explicitní datum a schválení. Business void billed práce je povolen například při reklamaci nebo chybné zakázce, ale musí atomicky vytvořit nový append-only time event, zápornou korekci a R13 účetní correction/storno vazbu. Původní session, billed link a doklad se nepřepisují.

### D4 – účetní storno a platby

**Rozhodnutí 2026-08-11:** vystavená faktura a schválený cost document jsou immutable version. Storno/credit/correction vytvoří linked event nebo nový artifact s povinným důvodem. Přijetí, vrácení a oprava platby jsou append-only payment events; nikdy se nemažou přepsáním `paidDate`/`paidAmount`.

### D5 – privacy/legal policy

Technicky lze připravit registry, workflow a `DECISION_REQUIRED` placeholdery, ale nelze bezpečně odhadnout právní titul, retenční délku, hold, anonymizaci, identitu žadatele, dual control, zpracovatele ani 72hodinový decision threshold. Tyto hodnoty musí schválit správce dat s právním/účetním/BOZP vstupem.

## 6. Checkpoint

- R17-A gap audit: uložen.
- R17-B implementační kontrakt a test matrix: uložen.
- R09/R10/R11/R12/R13 read-only gap audity: sloučeny do tohoto centrálního registru.
- Produkční kód: lokálně změněn pouze v úzkých R10-A, R11-B/R11-C, R12-A contract, R13-A/R13-B/R13-C a R17 direct-void containment řezech; bez commitu, pushnutí a deploye.
- Databáze/migrace: beze změny; nová migrace nebyla vytvořena ani očíslována.
- Docker, deploy, GitHub push/merge, workflow dispatch a GHCR: neprovedeno.
- D2–D4: business policy schválena 2026-08-11; service containment a jeho DB regrese jsou lokálně doplněny, další bezpečný krok bez externí mutace je append-only event/correction schema a route coverage kontrakt.
- Další kritický krok: podle uložené read-only inventury připravit forward-only lineage plán; následná lokální integrace aktuálního `main` a řešení migračních konfliktů vyžadují samostatné schválení.
