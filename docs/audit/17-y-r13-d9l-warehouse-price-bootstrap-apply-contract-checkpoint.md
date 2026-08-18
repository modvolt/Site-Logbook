# R13-D9L – warehouse-price bootstrap apply contract checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako default-deny transakční apply kontrakt; bez spustitelného apply CLI, očíslované migrace, runtime flagu, staging/production čtení nebo zápisu, provideru a read/UI cutoveru; R13 jako celek NOT READY**

## Výsledek

D9L převádí D9K dry-run kandidáta do persistovatelného, ale stále neaktivovaného kontraktu. Legacy cena se nevydává za historické schválení ani lifecycle událost. Vznikne jediná sequence-zero evidence `site-logbook.warehouse-price-legacy-observation/v1` s:

- `historicalCompleteness=unknown`;
- `actorKnown=false`, `effectiveAtKnown=false` a `eventHistoryFabricated=false`;
- nulovým accounting-version a lifecycle-event odkazem;
- explicitní source měnou, `valuationPolicy.mode=source-currency` a `fxConversionApplied=false`;
- exact hashem všech minimalizovaných legacy řádků a zvlášť určeným posledním řádkem podle `recordedAt`, potom ID;
- časem capture, který nesmí předcházet source řádku.

Společný stream verifier přijímá native i legacy větev. Legacy evidence může být jen první položka sequence 0. Její první native nástupce musí být `observed` nebo `corrected`, mít sequence 1 a exactně supersedovat legacy head. `withdrawn` nikdy nesmí zneplatnit unknown-history legacy evidence a pozdější native krok ji nesmí znovu použít jako supersession target.

## Default-deny autorizace

Strict canonical autorizace `site-logbook.warehouse-price-bootstrap-apply-authorization/v1` váže:

- interní i raw-file SHA-256 parity reportu a bootstrap plánu;
- target fingerprint a přesný počet kandidátů;
- schvalující user ID, čas, externí approval-evidence digest a exact confirmation phrase;
- výslovné přijetí unknown history a source-currency/no-FX modelu;
- hard hranice `callerOwnedTransactionRequired=true`, ascending locks, exact replay a současně `numberedMigrationIncluded=false`, `runtimeActivationIncluded=false`, `readCutoverIncluded=false`, `providerWriteIncluded=false`.

Kontrakt sám nevytváří důvěryhodnost externího approval artefaktu; pouze váže jeho předem schválený digest. Budoucí spustitelný runner musí proto samostatně ověřit raw approval bytes, aktuální target fingerprint, oprávnění operátora a přesný plán. V D9L žádný takový runner, route, package script ani runtime flag nevznikl.

## Transakční apply invarianty

`applyAccountingWarehousePriceBootstrapInTransaction` lze volat jen s caller-owned transaction adapterem. Před prvním insertem:

1. rekanonizuje a ověří autorizaci, plán i původní parity report;
2. znovu sestaví plan/report binding a zkontroluje všechny raw-file hashe;
3. ověří live target fingerprint;
4. zamkne všechny candidate warehouse items ve vzestupném numerickém pořadí;
5. pod zámkem znovu načte current cenu, celý unified stream, shadow head a všechny legacy price řádky;
6. přijme pouze přesnou shodu s původním `legacy_only` snapshotem nebo úplný exact replay již uloženého bundle.

Smí existovat pouze dva stavy celé dávky: všechny kandidáty fresh, nebo všechny kandidáty exact replay. Smíšený/partial stav je odmítnut před prvním zápisem. Fresh větev vloží v jedné transakci observation, právě jeden export intent a exact shadow projection head. Outbox fault vyhodí chybu callerovi a databáze rollbackne celý celek.

Post-apply parity ponechává původní legacy rows jako neměnný source snapshot a klasifikuje jejich exact vazbu jako `legacy_bootstrap_match`; nevytváří falešný `native_legacy_overlap`. Current read path stále používá legacy projekci a žádný cutover se v D9L neprovádí.

## Persistence a DB ochrany

Drizzle model i stále nečíslovaná SQL šablona přijímají unified warehouse-price stream. Legacy větev má nullable native source sloupce, partial unique index pouze pro native source event/line a DB invarianty pro:

- legacy pouze v sequence 0 prázdného streamu;
- exact native successor a zákaz legacy withdrawal/later supersession;
- source-currency/no-FX, unknown completeness a nulovou actor/effective/event fabricaci;
- SHA-256 source vazby, bounded positive legacy row count a exact latest-row price/currency;
- source timestamp nejvýše capture timestamp;
- append-only observation, outbox a projection head.

Přímý SQL insert se zfalšovaným `actorKnown=true` byl odmítnut constraintem `accounting_warehouse_price_legacy_semantics_chk`.

## Ověření

- celý API unit balík: **108/108 souborů, 809/809 PASS**;
- isolated PostgreSQL 16 bootstrap/parity sada: **1/1 soubor, 6/6 PASS** po **105/105** migracích, latest `0105_smooth_nitro`;
- PostgreSQL pokrytí: fresh apply, exact replay, post-apply PASS, transactional outbox rollback, stale locked snapshot a direct-SQL legacy provenance tamper;
- API TypeScript, scoped ESLint a production API build: **PASS**;
- vybrané D9L TypeScript soubory po Prettier formátu; SQL syntax ověřena skutečným načtením celé nečíslované šablony do disposable PostgreSQL;
- disposable PostgreSQL kontejner používal limit 1,5 CPU / 768 MiB a byl po každém běhu odstraněn.

## Nezměněné hranice

- šablona nebyla přesunuta do `lib/db/migrations`; žádné nové číslo migrace nebylo přiděleno a `0100` zůstává vyloučena;
- nevznikl apply CLI, API route, package script, env flag ani provider client;
- nebyl vytvořen skutečný parity/plan/authorization artifact ze staging nebo produkce;
- staging ani produkční DB, S3, Coolify, GHCR a GitHub nebyly změněny ani kontaktovány;
- nebyl proveden bootstrap/backfill, read cutover, UI cutover, deploy, commit ani push;
- současné default-dark accounting flags zůstávají neaktivované.

## Další bezpečný řez

R13-D9M může připravit pouze activation-preflight kontrakt pro budoucí staging kopii: exact approval artefakt, migration-lineage binding, před/po parity receipt, bounded batch policy a recovery/abort postup. Očíslování expand migrace, provedení apply nad staging kopií produkce, zapnutí price calleru, exporteru nebo read cutoveru jsou nadále samostatné kritické schvalovací hranice. Nejdřív je nutné integrovat aktuální public `main` a vyřešit kolizi migračního journalu; `0100` se nesmí použít.
