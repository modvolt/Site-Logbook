# R13-D9K – warehouse-price bootstrap preflight checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako read-only preflight a dry-run manifest; bez apply režimu, číslované migrace, datového backfillu, runtime aktivace a read/UI cutoveru; R13 jako celek NOT READY**

## Účel a hranice

D9K nepřevádí legacy data na domnělé schválení, korekci ani lifecycle event. Současný native warehouse-price observation kontrakt zůstává vyhrazený pro skutečnou accounting version a její skutečný lifecycle event. Bootstrap planner proto vytváří pouze samostatně označené kandidáty `site-logbook.warehouse-price-legacy-observation/v1` a výslovně ukládá:

- `transition=legacy_observation` a právě jednu kandidátní observation na warehouse item;
- `historicalCompleteness=unknown`;
- `actorKnown=false`, `effectiveAtKnown=false` a `eventHistoryFabricated=false`;
- nulový accounting version a lifecycle event odkaz;
- explicitní source currency, `valuationPolicy.mode=source-currency` a `fxConversionApplied=false`.

Tento canonical objekt je plán budoucího expand/apply kontraktu, nikoli řádek, který současná nečíslovaná SQL šablona umí vložit. Planner neobsahuje SQL, DB adapter ani apply command.

## Exact vstupní vazba

Planner přijme jen exact canonical bytes parity reportu v2 a separátně schválený SHA-256 raw souboru. Report s newline, přeuspořádanými klíči, změněnou semantikou nebo chybným interním digestem je odmítnut. Soubor musí být běžný soubor, nesmí být prázdný a má hard limit **268 435 456 B** ještě před `readFile`.

Každý kandidát váže:

- target fingerprint, interní report digest i raw file digest;
- hash všech minimalizovaných legacy row ID/hash dvojic;
- exact latest legacy row ID/hash, observed document/line reference, cenu, měnu a source recorded timestamp;
- deterministic UUIDv5 odvozené z targetu, reportu, itemu a legacy-row aggregate hashe;
- vlastní domain-separated entry hash.

Observed document/line reference je označený `unverified-legacy-reference`. Source timestamp se neprohlašuje za historický effective time.

## Klasifikace

- `legacy_only` vytvoří přesně jednoho kandidáta pro review;
- `empty`, `native_match` a `native_match_empty` jsou explicitní no-action položky;
- `native_projection_missing`, `native_price_mismatch`, `native_legacy_overlap`, `legacy_projection_mismatch` a `unproven_current_price` jsou blokery;
- alespoň jeden blocker dává celému manifestu `BLOCK`; kandidáti bez blockeru dávají `REVIEW`; nulový kandidát i blocker je jediný `PASS` stav.

Souhrn exactně pokrývá všechny source itemy. Candidate a blocker IDs jsou unikátní, vzestupně seřazené a navzájem disjunktní. `--max-planned-items` je povinný a hard maximum je 20 000.

## Oddělení plánu od apply

Manifest nese hard hodnoty:

- `mode=dry-run`;
- `mutationsSupported=false`;
- `applyCommandAvailable=false`;
- `numberedMigrationIncluded=false`;
- `runtimeActivationIncluded=false`;
- `readCutoverIncluded=false`;
- `explicitFutureApprovalRequired=true`.

CLI odmítá `--apply`, `--execute`, `--backfill`, `--update`, `--delete` i `--write-database`. Nepoužívá `DATABASE_URL`, PostgreSQL klienta ani storage provider. Offline binding verifier vždy vyžaduje současně plán i původní raw parity report a celý plán z něj znovu sestaví.

## Lokální použití

Parity artifact je nutné uložit jako přesné UTF-8 bytes bez BOM a bez přidaného newline. Příklad až pro samostatně schválenou staging inventuru:

```powershell
$tsx = 'scripts\node_modules\tsx\dist\cli.mjs'
$parityPath = '<evidence-dir>\warehouse-price-parity.json'
$parityJson = & node $tsx 'artifacts/api-server/src/scripts/audit-warehouse-price-parity.ts' `
  --database=<exact-db-name> `
  --target-fingerprint=<approved-sha256> `
  --max-items=<approved-cap> `
  --max-observations=<approved-cap> `
  --max-legacy-rows=<approved-cap>
[IO.File]::WriteAllText($parityPath, $parityJson, [Text.UTF8Encoding]::new($false))
$parityFileSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $parityPath).Hash.ToLowerInvariant()

$planPath = '<evidence-dir>\warehouse-price-bootstrap-plan.json'
$planJson = & node $tsx 'artifacts/api-server/src/scripts/plan-warehouse-price-bootstrap.ts' `
  --parity-report=$parityPath `
  --expected-report-file-sha256=$parityFileSha `
  --max-planned-items=<approved-cap>
[IO.File]::WriteAllText($planPath, $planJson, [Text.UTF8Encoding]::new($false))
$planFileSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $planPath).Hash.ToLowerInvariant()

node $tsx 'artifacts/api-server/src/scripts/verify-warehouse-price-bootstrap-plan.ts' `
  --plan=$planPath `
  --expected-plan-file-sha256=$planFileSha `
  --parity-report=$parityPath `
  --expected-report-file-sha256=$parityFileSha
```

Planner používá pro `REVIEW` exit code 2 a pro `BLOCK` exit code 3; manifest bytes přesto vydá. Offline verifier při exact shodě obou souborů a jejich odděleně schválených hashů vrací canonical verification receipt s exit code 0. Žádný z těchto příkazů nic nezapisuje do DB. Skutečný artifact a jeho checksum v tomto lokálním checkpointu nevznikly, protože nebyl schválen ani proveden staging/production read.

## Ověření

- canonical plan, mutation, classification, CLI policy, offline verifier a execution kontrakty: **1 soubor, 9/9 PASS**;
- isolated PostgreSQL 16 parity → exact-hash plan → zero-mutation důkaz: **1 soubor, 2/2 PASS** po **105/105** migracích, latest `0105_smooth_nitro`;
- celý hermetický API unit balík: **107/107 souborů, 802/802 PASS**;
- API TypeScript, scoped ESLint, Prettier a produkční API build: **PASS**.

Disposable PostgreSQL kontejner byl po ověření odstraněn. První dva pokusy skončily ještě před migracemi pouze chybou testovacího readiness harnessu; opravený SQL polling následně prošel a nebyl přidán do produkčního kódu.

## Nezměněné hranice

- nevznikla číslovaná migrace a `0100` zůstává vyloučena;
- současný observation/DDL/runtime kontrakt nebyl rozšířen o persistovatelný legacy transition;
- nebyl spuštěn staging ani production parity read, bootstrap, backfill nebo post-apply parity;
- flag není aktivovaný a žádný read/UI cutover neproběhl;
- provider/S3, Coolify, GHCR ani GitHub nebyly kontaktovány;
- neproběhl commit ani push.

## Další bezpečný řez

Další lokální část může připravit **apply kontrakt pouze jako default-deny návrh a fault-testovaný transaction adapter bez spustitelného CLI**, nebo pokračovat jiným otevřeným R13 P1 řezem. Číslovaná migrace, reálné data mutation, staging dry-run nad kopií produkce, runtime flag activation a read cutover zůstávají samostatnými kritickými rozhodnutími.
