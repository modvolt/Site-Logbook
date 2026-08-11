# R11-E – nonnegative invariant běžného skladu

Datum: 2026-08-11  
Stav: **LOCAL CODE + DISPOSABLE DB PASS / NOT PUSHED / NOT DEPLOYED**

## Rozhodnutí

Schválená politika říká, že běžná cesta nesmí vytvořit záporný authoritative
stav skladu. Controlled override může vzniknout až se zvláštní rolí, povinným
důvodem, omezeným limitem a immutable `warehouse.override` eventem. Dokud tento
celek neexistuje, výjimka z nonnegative pravidla není dostupná.

## Implementovaný řez

`warehouse-service.ts` nyní pod již drženým `FOR NO KEY UPDATE` lockem:

1. načte aktuální signed sum přímo z append-only `warehouse_movements`;
2. pro každý záporný delta vypočte nový stav na přesnost ledgeru;
3. odmítne operaci statusem 409, pokud by nový stav klesl pod nulu;
4. vloží movement a aktualizuje cache `warehouse_items.quantity` pouze po
   úspěšné kontrole.

Kontrola je společná pro source reconciliation i ruční pohyb. Pokrývá proto
zakázkové a activity materiály, ruční výdej i záporný reversal dřívějšího
příjmu. Nevěří cache `warehouse_items.quantity`; authoritative vstup je vždy
ledger sum načtený až po item locku.

## Transakční chování

- materiál vytvořený v téže transakci jako nekrytý výdej se spolu s pohybem
  rollbackne;
- návrat schváleného příjmu do kontroly se rollbackne, pokud už spotřebovaná
  zásoba nedovoluje bezpečné storno příjmu;
- dva souběžné ruční výdeje stejné položky se serializují a pouze jeden uspěje,
  jestliže jejich součet přesahuje dostupnou zásobu;
- odmítnutí nevytvoří movement ani nezmění cached quantity.

## Ověření

- API TypeScript typecheck: PASS;
- cílený ESLint: PASS;
- `git diff --check`: PASS;
- izolovaný PostgreSQL 16 kontejner s digest-pinned image, 1 CPU, 1 GiB RAM a
  256 PID;
- všech 106 migrací aplikováno pouze do disposable test databáze, tail
  `0106_graceful_frog_thor`;
- `warehouse-ledger.test.ts`: **16/16 PASS**;
- disposable kontejner byl po testu odstraněn.

## Zbývající hranice

Tento řez neimplementuje controlled override. Nestačí přidat boolean nebo
admin-only route: před jeho povolením musí existovat přesná role/permission,
limit, povinný reason code + detail, atomický canonical audit event a exportní
outbox z R09. Do té doby je záporný stav úmyslně nedostupný i při opravě nebo
stornu dřívějšího příjmu.

R11 jako celek zůstává **NOT READY**. Otevřené jsou zejména společný lock planner
pro vyšší transakce s více source, row-version/ETag kontrakt, DB live billing
claim a oddělený online migration/backfill plane.

## Zakázané automatické pokračování

Tento checkpoint neopravňuje push, merge, deploy ani spuštění migrace. Změna
produkčního chování musí před publikací projít samostatně schváleným draft PR a
exact-head CI; aktivace zůstává oddělenou hranicí.
