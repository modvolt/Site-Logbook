# R11-H – atomický warehouse material backfill

Datum: 2026-08-11
Stav: **LOCAL CODE + DISPOSABLE DB PASS / NOT PUSHED / NOT DEPLOYED**

## Nalezená mezera

Admin endpoint `warehouse-material-backfill/run` prováděl dvě samostatné raw SQL
aktualizace `warehouse_item_id`: nejprve job materials, potom activity materials.
Nevytvářel jejich warehouse movements. Pád mezi update kroky zanechal částečný
stav a pozdější editace mohla teprve dodatečně vytvořit výdej. FK a
authoritative ledger proto nebyly atomicky svázané.

Ruční `assign` varianta movementy vytvářela, ale každý source reconcile spouštěla
samostatně v loopu.

## Implementace

`runUnambiguousWarehouseMaterialBackfill()` nyní vlastní jednu DB transakci:

1. nastaví `lock_timeout = 5s` a `statement_timeout = 30s`;
2. vezme table-level `SHARE` lock na `warehouse_items`, takže se během mapování
   nemůže změnit množina stejně pojmenovaných karet;
3. CTE vybere pouze názvy s právě jednou warehouse kartou a oběma source
   tabulkám nastaví FK s `RETURNING id`;
4. načte přesné aktualizované rows, vytvoří job/activity reconcile requesty a
   provede jediný `reconcileSourceMovementBatch()`;
5. commitne FK i ledger pouze společně.

Když nonnegative invariant odmítne jediný issue, rollbacknou se všechny FK i
movementy. Ambiguous name zůstává bez vazby. Druhé spuštění nenajde žádný nový
source a nevytvoří duplicitní movement.

Ruční `warehouse-material-backfill/assign` také nejprve aktualizuje source rows,
potom sestaví jeden batch a commitne pouze úplný výsledek.

## DB důkaz

Pozitivní test:

- job material 5 a activity material 4 se stejným jednoznačným názvem;
- skutečný opening ledger 20;
- první backfill vrátí 1 + 1, oba FK ukazují na správný item a stav je 11;
- stejně pojmenovaná dvojice warehouse karet je ambiguous a její material
  zůstane bez FK;
- druhé spuštění vrátí 0 + 0, stav i počet movementů se nemění.

Negativní test:

- done material 2 proti kartě bez opening stock;
- backfill skončí 409;
- material FK zůstane `null`, ledger i cache zůstanou přesně 0.

Ověření po finálním testu:

- API typecheck, cílený ESLint a `git diff --check`: PASS;
- všech 106 migrací pouze v disposable PostgreSQL 16 databázi, tail
  `0106_graceful_frog_thor`;
- warehouse ledger: **19/19 PASS**;
- disposable kontejner odstraněn.

## Rezidua

Table lock je záměrně bounded a endpoint je explicitní admin operace, ne startup
DDL/backfill. Pro velké produkční objemy stále chybí obecný restartovatelný
chunk/checkpoint plane s canonical plan hashem; timeout proto bezpečně odmítne
dlouhý nebo blokovaný běh místo nekontrolovaného pokračování.

Audit summary endpointu zůstává legacy non-evidentiary zápis mimo doménovou
transakci. Jeho převod na canonical R09 event/outbox čeká na schválenou DB expand
migraci. R11 dále blokují outer multi-batch plány, row-version/ETag a DB live
billing claims.

Push, merge, deploy ani migrace nebyly provedeny a vyžadují oddělené schválení.
