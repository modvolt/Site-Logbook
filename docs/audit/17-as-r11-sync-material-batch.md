# R11-G – společný batch material sync

Datum: 2026-08-11  
Stav: **LOCAL CODE + DISPOSABLE DB PASS / NOT PUSHED / NOT DEPLOYED**

## Převáděná cesta

`syncJobMaterialsForDocument()` může v jedné caller-owned transakci:

- vytvořit nebo změnit několik job materials;
- vytvořit nebo změnit několik activity materials;
- reverse-nout a odstranit dříve propagované rows;
- pro každý přežívající source dopočítat nový skladový výdej.

Původně každá položka volala single-source reconcile a držela svůj item lock až
do konce celé transakce. Pořadí zdrojů proto mohlo určovat pořadí locků.

## Implementace

Nový exportovaný builder vytvoří z uloženého material row přesný
`SourceMovementReconcileRequest`; zachovává stávající pravidla `done`, stabilní
`warehouseItemId`, quantity, cenu a job vazbu.

Material sync nyní:

1. provede dosavadní upsert a identifikuje zaniklé i přežívající source;
2. sestaví jeden request list v původním business pořadí: mazané job materials,
   mazané activity materials, přežívající job materials a přežívající activity
   materials;
3. předá celý list `reconcileSourceMovementBatch()`;
4. zaniklé source rows smaže až po úspěšném movement batchi.

Při chybě batch i všechny předchozí upserty rollbackne caller transaction.
Movement insert pořadí se nemění; pouze acquisition všech item locků proběhne
před prvním pohybem.

## Nonnegative fixture korekce

Dvě starší price-propagation fixture předem založily warehouse kartu s nulovou
cache a následně očekávaly úspěšný výdej. R11-E správně čte authoritative ledger
a tuto premisu odmítl. Fixture nyní vytvářejí skutečný ruční příjem 10 kusů přes
produkční ledger API. Testy tak dál dokazují idempotentní re-approve a blokaci
duplicate documentu, aniž by obcházely nonnegative invariant přímým přepsáním
`warehouse_items.quantity`.

## Ověření

- API typecheck a cílený ESLint: PASS;
- `git diff --check`: PASS;
- disposable PostgreSQL 16, všech 106 migrací pouze v test DB, tail
  `0106_graceful_frog_thor`;
- warehouse ledger: **17/17 PASS**;
- material integrity: **3/3 PASS**;
- document price propagation po opravě fixture: **19/19 PASS**;
- každý disposable kontejner byl odstraněn.

## Rezidua

Některé outer cost-document flows volají `syncJobMaterialsForDocument()` a
potom samostatně `reconcileDocumentStockMovements()`. Obě funkce mají vlastní
interně úplný batch, ale první batch drží své locky do commitu a druhý může
později potřebovat nižší item. Úplné uzavření vyžaduje outer plán/flush přes obě
fáze nebo přesnou strukturální analýzu, že jejich item množiny nemohou vytvořit
opačný cyklus. R11-G toto netvrdí.

Stejně zůstávají otevřené row-version/ETag, DB live billing claim a oddělený
bounded migration/backfill plane. Push, merge, deploy a migrace vyžadují další
samostatné schválení.
