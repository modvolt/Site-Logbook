# R11-I – source lock, bezpečné storno a fail-closed legacy backfill

Datum: 2026-08-11
Stav: **LOCAL CODE + DISPOSABLE DB PASS / READY FOR CHILD COMMIT / NOT DEPLOYED**

## Proč byl předchozí R11-H nahrazen

Review před publikací doložilo čtyři mezery:

1. první dvě reconcile stejného source bez historie mohly cílit na různé itemy a
   nikdy se nepotkat na item row locku;
2. `cancel-last` vybíral a stornoval ruční pohyb bez společného item locku a bez
   authoritative nonnegative kontroly;
3. legacy backfill používal PostgreSQL `lower()`, nikoli aplikační
   `trim + NFKC + lower`, takže české a Unicode varianty neměly jednotnou
   identitu;
4. backfill nebyl skutečně bounded a jeho table-lock pořadí mohlo kolidovat s
   běžnými writery.

Checkpoint `17-at-r11-warehouse-backfill-atomicity.md` proto zůstává historickým
záznamem, ale jeho write cesta není schválena pro runtime.

## Implementovaný containment

`reconcileSourceMovementBatch()` před prvním discovery krokem bere
`pg_try_advisory_xact_lock` pro každý `(sourceType, sourceId)`. Lock class je
explicitní collision-free int32 namespace a requesty jsou řazené podle source
type a ID. Try-lock při souběhu okamžitě vrací 409; nevytváří další čekající
source-lock řetězec. Potom zůstává zachovaný společný vzestupný item
`FOR NO KEY UPDATE` plán a re-read ledgeru.

Skladové aplikační chyby jsou označené třídou `WarehouseAppError`. Globální
handler zveřejní pouze její očekávané stavy 400/404/409 s omezeným kódem;
interní 500 zůstává skrytá za generickou odpovědí.

`cancelLastManualMovement()` zamkne item před výběrem posledního ručního pohybu,
odmítne storno storna, ověří záporný delta proti authoritative ledgeru a vloží
přesně jeden reversal ve stejné transakci. Response se následně načítá podle
exact ID vytvořeného reversal, nikoli jako obecně nejnovější pohyb. Pole
`costPriceAtTime` zůstává `null`, což zachovává dosavadní storno semantiku;
změna cost-accounting policy není součástí tohoto containment řezu.

Oba legacy bulk POST endpointy (`assign`, `run`) i exportovaný service helper
jsou nyní fail-closed 409 a nemají DB mutation surface. OpenAPI je označuje jako
deprecated 409-only. Admin UI je pouze read-only report a už nenabízí ani
neoznačuje hromadný backfill jako bezpečný. Budoucí náhrada musí mít schválený,
bounded a restartovatelný NFKC manifest podle přesných source/item ID.

## Ověření

- všech 106 migrací bylo aplikováno pouze do disposable PostgreSQL 16 template;
- `warehouse-fk.test.ts`: **11/11 PASS** po nahrazení historických záporných
  fixture skutečným opening ledgerem;
- `warehouse-ledger.test.ts`: **22/22 PASS** (celý soubor, ne 22 nových testů);
- read-only/backfill a HTTP error kontrakt: **5/5 PASS**;
- workspace typecheck: PASS;
- generated API + audit docs Prettier, cílený ESLint a `git diff --check`:
  PASS;
- dočasný DB kontejner byl po testu odstraněn.

## Rezidua

- outer flow v `cost-document-service` stále spouštějí více oddělených reconcile
  batchů v jedné vyšší transakci; jejich globální source+item plán zůstává R11
  blockerem;
- read-only report stále používá legacy SQL name grouping a není autorizací
  zápisu;
- chybí řízený restartovatelný maintenance plane s plan hashem, capy,
  checkpointem, resume a reconciliation;
- controlled negative-stock override a explicitní `reverses_movement_id`
  evidence neexistují;
- row-version/ETag, unique live billing claim a oddělený one-shot migration
  plane zůstávají otevřené.

Tento checkpoint nic nenasazuje ani nespouští migraci. Produkční aktivace smí
navázat až na exact-head CI a samostatný predeploy/backup gate.
