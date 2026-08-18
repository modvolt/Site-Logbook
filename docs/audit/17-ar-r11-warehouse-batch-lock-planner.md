# R11-F – batch lock planner skladových zdrojů

Datum: 2026-08-11
Stav: **LOCAL CODE + DISPOSABLE DB PASS / NOT PUSHED / NOT DEPLOYED**

## Problém

R11-B sjednotil pořadí item locků uvnitř jednoho source reconcile. Vyšší
transakce ale mohou postupně zpracovat několik různých zdrojů. Transakce T1 s
pořadím zdrojů A, B mohla držet item A a čekat na B, zatímco T2 s pořadím B, A
držela B a čekala na A. Per-source sorting tento multi-source cyklus neřeší.

## Implementovaný primitiv

`reconcileSourceMovementBatch()` přijme celý známý seznam source requestů a:

1. odmítne duplicitní `(sourceType, sourceId)` v jednom batchi;
2. před prvním movement write načte historicky dotčené itemy každého source a
   přidá jeho desired target;
3. sjednocení item ID deduplikuje a zamkne numericky vzestupně přes
   `FOR NO KEY UPDATE`;
4. po získání všech locků znovu načte source ledger a R11-D pravidlem odmítne
   nově objevený target mimo plán;
5. source requesty zpracuje v původním pořadí, takže business pořadí movement
   insertů se nemění.

Jedno-source API je nyní úzký wrapper nad stejným batch primitivem. Tím zůstává
jediná implementace lock/re-read invariantů.

## První převedená cesta

`reconcileDocumentStockMovements()` nejprve sestaví request pro každou line a
potom je odešle jako jeden batch. Více stock receipts nebo reversals jednoho
cost documentu proto nemůže získávat item locky podle náhodného pořadí řádků.
Vytvoření případné nové warehouse karty stále proběhne ve stejné caller-owned
transakci a při pozdějším konfliktu se rollbackne.

## Concurrency důkaz

Izolovaný PostgreSQL 16 test vytvoří dvě transakce se dvěma disjunktními source:

- první požaduje itemy A, B;
- druhá požaduje itemy B, A;
- trigger pozdrží první movement každé transakce, takže sekvenční per-source
  implementace by držela opačné první locky;
- batch planner oběma transakcím nařídí A, B ještě před prvním movementem.

Výsledek: obě transakce dokončily, authoritative i cached stav A a B je 84 a
součet čtyř source příspěvků je -32.

Ověření:

- API typecheck: PASS;
- cílený ESLint a `git diff --check`: PASS;
- všech 106 migrací pouze v disposable databázi, tail
  `0106_graceful_frog_thor`;
- `warehouse-ledger.test.ts`: **17/17 PASS**;
- testovací kontejner odstraněn.

## Rezidua

R11-F není globální dokončení planneru. `syncJobMaterialsForDocument()` a další
cost-document/bulk flows mají několik fází, mezi nimiž se source rows teprve
vytvářejí, mění nebo mažou. Jednotlivé fáze stále mohou držet item lock z
dřívějšího reconcile a později požádat o nižší item. Tyto callsites musí být
postupně převedeny tak, aby nejdříve vytvořily úplný plán a provedly jediný
batch flush; nelze je bezpečně „opravit“ per-call advisory lockem.

R11 dále zůstává **NOT READY** kvůli obecnému row-version/ETag kontraktu, DB live
billing claimu a oddělenému bounded migration/backfill plane.

## Zakázané automatické pokračování

Checkpoint neopravňuje push, merge, deploy ani migraci. Publikace vyžaduje nový
draft PR a exact-head CI; aktivace je samostatná kritická hranice.
