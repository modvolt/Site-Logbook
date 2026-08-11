# R13-D9 – ignored/reason/warehouse-price provenance design checkpoint

Datum: 2026-08-11  
Stav: **volby 1A/2A/3A lokálně implementované jako default-dark expand/caller vrstvy; bez nové migrace a runtime aktivace**

## Proč D8 nemůže bezpečně označit celý caller za hotový

`setDocumentStatus` dnes spojuje dvě odlišné operace:

1. řízené znovuotevření už schváleného a účetně verzovaného dokladu;
2. vyřazení dosud neschváleného uploadu stavem `ignored`.

D8 uzavírá první větev default-dark correction chainem. Druhá větev zůstává pouze mutable projection:

- UI nabízí `Ignorovat` bez confirmation dialogu, reason code nebo důvodu;
- API dovoluje `ignored`, ale `reason` je obecně volitelný;
- service změní current status, nevytvoří accounting version/event/outbox a spoléhá jen na obecný post-response audit;
- ignored dokument lze následně hard-delete, protože dnešní delete guard rozlišuje pouze `approved` nebo již existující accounting head;
- exact lifecycle kontrakt sice zná event `ignored` a reasons `duplicate_document|invalid_document`, ale event se musí vázat na konkrétní immutable version. Native incoming version kontrakt dnes připouští jen `approved|correction`, vyžaduje nejméně jeden řádek, nejméně jeden source artifact, známý document type a `human-approved-final-state/v1`. Neúplný nebo chybný upload tyto podmínky nutně nesplňuje.

Nelze proto bezpečně přidat samotný `ignored` event k neexistující verzi ani použít `legacy_observation`; to by zaměnilo nový operátorský úkon za legacy historii s neznámou úplností.

## Doporučené rozdělení místo jednoho `ignored`

### A. Early upload discard – provozní, nikoli účetní evidence

- pouze před vznikem lidské review/extraction decision hranice;
- zdroj nesměl být schválen, spárován, použit ve skladu, cenách, zakázce ani jiné účetní vazbě;
- vyžaduje explicitní reason code a krátké potvrzení operátora;
- výmaz se řídí budoucím R10 retention/privacy case kontraktem a R09 durable auditem, nikoli R13 accounting version;
- dnešní status `ignored` nesmí sám dokazovat, že tyto preconditions platily.

### B. Reviewed source rejection – neměnná R13 observation

- jakmile člověk rozhoduje o dokumentu, který už prošel extraction/review nebo má doménovou vazbu, vznikne native `discarded_observation` version;
- snapshot dokládá přesné dostupné source artifacty a aktuální extracted fields, ale výslovně dovolí `documentType=unknown`, nula řádků a incomplete optional fields;
- `historicalCompleteness=complete` znamená úplný snapshot dostupného stavu v okamžiku rozhodnutí, nikoli tvrzení, že upload je úplný nebo účetně platný;
- append-only `ignored` event nese registrovaný reason code, actor, čas, version binding, export intent a head CAS;
- po vzniku headu je hard delete zakázán; případné obnovení musí být nový event a nová review projection, ne odstranění rejection evidence.

Toto rozdělení zabraňuje tomu, aby náhodný chybný upload dostal neomezenou účetní retenci, a současně neumožní smazat již posuzovaný účetní zdroj.

## Čitelný důvod

D8 ukládá jen domain-separated digest normalizovaného free-text důvodu. Ten dokazuje shodu se známým textem, ale sám text z něj nelze obnovit ani zobrazit auditorovi.

Doporučený cílový kontrakt:

- povinný allowlist reason code;
- povinný, NFC-normalizovaný text 3–1000 znaků u reviewed/reopen cesty, bez free textu u early operational discardu;
- odmítnout control znaky a známé secret formáty;
- text uložit pouze do restricted immutable accounting archive, nikoli do běžného telemetry logu, UI listu nebo object key;
- canonical event nese pouze allowlisted code a digest; čitelný text existuje výhradně v samostatném restricted reason artifactu svázaném s původním eventem;
- export a retention se řídí stejným právním/účetním hold režimem jako source document.

Uložení raw textu do immutable archivu je retenční rozhodnutí: může obsahovat osobní údaje nebo obchodní kontext a později jej nelze selektivně přepsat.

## Warehouse purchase-price provenance

`warehouse_price_history` není append-only ledger:

- unikátní klíč dovoluje jen jeden řádek na cost-document line;
- reapproval používá `ON CONFLICT DO UPDATE`;
- reopen/delete cleanup řádky maže a přepočítá current purchase price.

Starý komentář byl opraven na „legacy mutable projection“ a D8 nyní před correction reopen fail-closed odmítne každý doklad, který už takovou projection vytvořil. Bezpečný cílový expand vyžaduje samostatný immutable ledger, například:

- stable observation UUID a canonical JSON/hash;
- `warehouse_item_id`, accounting version ID, source line identity a observed price/currency;
- `supersedes_observation_id` pro correction, bez update/delete původního řádku;
- append-only trigger, restrictive FK a export intent nebo vazbu do accounting bundle;
- current `warehouse_items.purchase_price` zůstane pouze projekcí odvoditelnou z poslední platné observation;
- legacy `warehouse_price_history` se backfilluje jako observation s `historicalCompleteness=unknown`, nikdy jako domyšlený correction chain.

Do vytvoření a ověření této expand vrstvy zůstává price-history guard správně fail-closed.

## Implementační pořadí po rozhodnutí

1. Rozdělit API/UI na explicitní early discard a reviewed rejection; odstranit přímé obecné `Ignorovat`.
2. Přidat strict reason-code/note kontrakt a retention-class metadata.
3. Rozšířit canonical version/event kontrakt a nečíslovanou SQL šablonu o `discarded_observation`; nepřidělovat číslo migrace.
4. Přidat DB fault/replay/delete/restore testy a exact seam policy teprve poté označit plně atomicky.
5. Samostatně navrhnout a otestovat immutable warehouse-price observation ledger; D8 guard odstranit až po parity důkazu.
6. Číslovanou expand migraci řešit až po integraci live `main`, forward-only opravě kolize `0096`; `0100` zůstává vyloučena.

## Schválená rozhodnutí 2026-08-11

1. **1A – retenční hranice ignored:** early junk discard zůstane retenčně omezenou provozní cestou; reviewed rejection vytvoří neměnnou R13 observation.
2. **2A – raw reason note:** bounded čitelný text se uloží do restricted immutable accounting archivu společně s reason code a digestem; nesmí se objevit v telemetry, list API ani object key.
3. **3A – warehouse měna:** current-price projekce ponese explicitní ISO měnu. Cizí měna se nesmí implicitně ani automaticky převádět; FX vyžaduje samostatný později schválený canonical kontrakt.

Warehouse-price ledger je technický prerequisite, nikoli důvod měnit současná business pravidla. Lze jej dále navrhovat bez produkční migrace, ale jeho číslování, backfill a aktivace zůstávají samostatnými rizikovými checkpointy.

## Technický checkpoint D9A

Čistý canonical warehouse-price observation kontrakt a jeho fail-closed verifier jsou lokálně hotové bez DDL a runtime wiring. Model váže cenu na exact accounting version, lifecycle event a material source line, používá item-local hash chain a explicitní `observed|withdrawn|corrected` supersession. Současný mutable price-history guard zůstává aktivní. Přesný stav a testovací důkaz jsou v `17-o-r13-d9a-warehouse-price-observation-contract-checkpoint.md`.

## Technický checkpoint D9B

Additive Drizzle model, nečíslovaná SQL šablona a transaction-owned DB adapter jsou lokálně hotové. Warehouse item lock serializuje i první append, DB triggery odmítají update/delete, source drift, gap a neplatnou supersession a exact replay je no-op. Vrstva není připojena k callerům ani exportu a nemá číslovanou migraci; D8 guard proto zůstává aktivní. Přesný checkpoint: `17-p-r13-d9b-warehouse-price-persistence-checkpoint.md`.

## Technický checkpoint D9C

Warehouse-price observation je nově atomicky svázána s jednopoložkovým export intentem ve stejné caller-owned transakci. Sdílený archive worker načte exact canonical observation, bundle i offline verifier kontrolují její digest, identitu a vazbu source aggregate a SQL outbox přijímá nový operation pouze jako neaktivovanou expand cestu. Exact replay vyžaduje observation i shodný intent; DB fault test dokládá rollback obou řádků při chybě outboxu. Provider, worker runtime, caller dual-write, migrace a S3 zápis nejsou aktivované. Přesný checkpoint: `17-q-r13-d9c-warehouse-price-archive-checkpoint.md`.

## Technický checkpoint D9D

Čistý projection verifier nyní přehrává úplný item-local stream, rozlišuje stream head od poslední stále platné ceny a po withdrawal novějšího dokladu deterministicky obnoví předchozí newithdrawn cenu. Kontrakt dovolí `corrected` jako první observation prázdného item streamu, což je nutné pro correction, která nově vytvoří nebo přesune materiál na jinou skladovou kartu; první `withdrawn` zůstává zakázán. Parity vyžaduje cenu i explicitní měnu. Současné `warehouse_items.purchase_price` však měnu neuchovává, takže runtime cutover pro více měn zůstává fail-closed do schválení currency/FX modelu. Přesný checkpoint: `17-r-r13-d9d-warehouse-price-projection-checkpoint.md`.

## Technický checkpoint D9E

Bounded CLI nyní pořídí fixed `REPEATABLE READ READ ONLY` snapshot current warehouse prices, native observations a legacy price rows, před inventurou vynutí hard limity a vydá strict canonical parity report. Legacy metadata je minimalizované a každá native cena bez explicitně uložené current měny skončí poctivě `native_currency_unbound`/`BLOCK`; audit proto nepředstírá implicitní CZK. Neobsahuje žádný apply/backfill režim. Přesný checkpoint: `17-s-r13-d9e-warehouse-price-parity-audit-checkpoint.md`.

## Technický checkpoint D9F

Schválená volba 3A je lokálně formalizována jako samostatný canonical shadow projection head s explicitní měnou, `source-currency` policy a hard `fxConversionApplied=false`. Nečíslovaná tabulka se CAS posouvá přesně po jedné immutable observation a DB znovu odvozuje efektivní price observation. Legacy `warehouse_items.purchase_price` se nemění a runtime čtení není přepnuto. Přesný checkpoint: `17-t-r13-d9f-explicit-currency-shadow-projection-checkpoint.md`.

## Technický checkpoint D9G

Parity report v2 nyní načítá exact canonical shadow head a znovu jej váže na celý immutable observation stream. Native stream bez headu je samostatný `native_projection_missing` blok; validní head dodá explicitní current měnu a report dál kontroluje numerickou continuity vůči legacy current sloupci. Celá cesta zůstává read-only a bez apply režimu. Přesný checkpoint: `17-u-r13-d9g-projection-aware-parity-checkpoint.md`.

## Technický checkpoint D9H/D9I

Schválené volby 1A/2A jsou lokálně zapojené. Strict disposition policy odděluje untouched `early_discard` bez accounting evidence od `reviewed_rejection`, který atomicky vytváří `discarded_observation` version, `ignored` event, head, běžný initial export a samostatný restricted reason artifact/outbox. Čitelný reason je pouze v `accounting-evidence-restricted/v1`, zatímco event, běžný audit, list metadata a object key nesou jen code/digest/identitu. API i klienty mají explicitní discriminated endpoint; UI, migrace, flags a provider zůstávají neaktivované. Přesný checkpoint: `17-v-r13-d9h-d9i-reason-disposition-checkpoint.md`.

## Technický checkpoint D9J

Default-dark `ACCOUNTING_WAREHOUSE_PRICE_DUAL_WRITE_ENABLED=true` nyní připojuje explicitní approved-document price action k current immutable `approved|correction` version/eventu. Observation, export intent, explicit-currency shadow head, legacy current/history a line projection sdílejí caller-owned transakci; reopen nejprve vyžaduje úplné native pokrytí a parity, appenduje withdrawals a až potom odstraní mutable history. Exact replay je no-op, item locky jsou vzestupné a match se po zámku revaliduje. Non-CZK a precision-loss jsou do multi-currency cutoveru fail-closed, bez implicitního FX. Bootstrap/backfill, read/UI cutover, migrace a flag activation zůstávají neprovedené. Přesný checkpoint: `17-w-r13-d9j-warehouse-price-caller-checkpoint.md`.

## Technický checkpoint D9K

Read-only bootstrap planner nyní přijme pouze exact canonical parity report v2 a jeho separátně schválený raw-file SHA-256. Každý `legacy_only` item převede výhradně do jednoho deterministického dry-run kandidáta `legacy_observation` s explicitní source currency, `historicalCompleteness=unknown` a hard zákazy fabricace actor/effective/event historie; ostatní stavy jsou exact no-action nebo blocker. Canonical plán váže všechny minimalizované legacy row hashe, má bounded 256MiB vstup a nemá žádný apply/DB/provider režim. Isolated DB test prokázal report → plán i nulovou mutaci. Přesný checkpoint: `17-x-r13-d9k-warehouse-price-bootstrap-preflight-checkpoint.md`.

## Technický checkpoint D9L

Default-deny apply kontrakt nyní rekanonizuje exact parity report, dry-run plán a samostatnou autorizaci, váže jejich raw i semantic hashe na live target fingerprint a před prvním insertem zamkne a revaliduje všechny kandidáty ve vzestupném pořadí. Fresh dávka atomicky ukládá legacy observation, export intent a explicit-currency shadow head; povolen je pouze úplný fresh stav nebo úplný exact replay, zatímco stale či partial stav a outbox fault končí bez commitu. Unified stream dovolí legacy pouze jako sequence-zero head a vyžaduje jeho první explicitní native supersession; unknown-history legacy řádek nelze withdrawnout. Nečíslovaná SQL šablona vynucuje no-actor/no-event/no-effective/no-FX semantiku i proti přímému SQL tamperu. Apply CLI, route, flag, očíslovaná migrace, staging/production data run a cutover nevznikly. Přesný checkpoint: `17-y-r13-d9l-warehouse-price-bootstrap-apply-contract-checkpoint.md`.

## Technický checkpoint D9M

Canonical approval nyní poskytuje exact raw artefakt, jehož SHA-256 musí odpovídat D9L autorizaci. Activation preflight je fail-closed na exact staging environment/source/target, předem ověřené staging release evidence, integrovaný migration journal bez známého driftu, přesně dvě opaque legacy identity bez domyšleného významu, čerstvý restore test, 256MiB payload ceiling a již aplikovanou expand migraci mimo `0100`. Post-commit receipt odděluje původní source report od skutečného before/after snapshotu, rozlišuje fresh apply a exact replay a znovu ověřuje raw evidence chain i nezměněné non-candidate itemy. Runner, číslo migrace, DB/provider/deploy operace ani cutover nevznikly; operativní activation zůstává NO-GO. Přesný checkpoint: `17-z-r13-d9m-warehouse-price-activation-preflight-checkpoint.md`.

## Technický checkpoint D9N

Offline verifier nyní přijímá jen exact devíti- nebo dvanáctisouborový dedicated adresář, trusted preflight/receipt SHA-256 a strict read-only argumenty. Canonical lineage a backup sidecary jsou exactně porovnány s embedded preflightem; schema-v4 staging PASS summary obsahuje a D9N ověřuje hash právě čteného root release evidence. Reporty mají 256MiB strop, celý set 384MiB, čtení je sekvenční a symlink, extra/missing file, read-time drift i mutation alias jsou odmítnuty. CLI zapisuje pouze canonical summary na stdout a nemá DB/provider/runtime surface. Přesný checkpoint: `17-aa-r13-d9n-warehouse-price-offline-verifier-checkpoint.md`.

## Technický checkpoint D9O

Capture/readiness runbook nyní přesně přiřazuje jediný přípustný producer každému z 12 D9N souborů, zakazuje self-derived trusted hash a vyžaduje nový dedicated adresář pro preflight i receipt. Abort matrix odděluje pre-transaction NO-GO, potvrzený rollback, unknown commit outcome, committed-without-receipt, partial incident a exact replay. Po nejasném outcome není povolen blind retry ani mazání evidence; feature/read cutover zůstává vypnutý. Runbook neobsahuje apply, migration, deploy ani provider-write příkaz. Přesný checkpoint: `17-ab-r13-d9o-warehouse-price-activation-capture-runbook.md`.
