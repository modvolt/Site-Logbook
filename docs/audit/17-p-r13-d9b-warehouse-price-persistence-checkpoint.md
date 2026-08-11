# R13-D9B – warehouse-price persistence checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako neaktivovaná expand vrstva; bez číslované migrace, caller wiring a produkčních změn; R13 jako celek NOT READY**

## Výsledek

D9B převádí čistý D9A kontrakt do transaction-owned persistence návrhu, aniž by měnil běh aplikace:

- Drizzle model a nečíslovaná SQL šablona obsahují additive `accounting_warehouse_price_observations`;
- adapter vždy nejprve zamkne owning `warehouse_items` row, takže serializuje i úplně první observation prázdného item streamu;
- insert ukládá přesné canonical bytes a sloupce pro item, cost-document root, accounting version/event, source line, sequence, predecessor, supersession, cenu, měnu, match evidence a časy;
- exact replay stejného observation ID a stejných canonical bytes je no-op; stejné ID s jinými bytes, gap, chybný predecessor nebo chybějící superseded observation jsou fail-closed;
- item sequence a source event/line jsou unikátní, všechny root/version/event/item FK používají `ON DELETE RESTRICT`; mutable physical billing line záměrně není FK target, protože immutable accounting version už uchovává její snapshot a correction draft smí fyzický řádek nahradit;
- DB insert trigger exactně váže referenced incoming version, lifecycle event, actor/reason/timestamps, material source line, cenu a měnu. Ověřuje contiguous predecessor a transition-specific supersession;
- canonical shape check vyžaduje všechny a pouze schválené top-level/source/integrity/match klíče a používá fail-closed `IS NOT DISTINCT FROM` vazby;
- update i delete observation tabulky odmítá společný immutable trigger.

## Transaction boundary

`appendAccountingWarehousePriceObservationInTransaction` neotevírá vlastní transakci. Caller mu musí předat adapter stejné transakce, ve které už vzniká accounting version/lifecycle event a budoucí skladová projection. Při chybě insertu funkce chybu propaguje a caller-owned transakce může rollbacknout celý celek.

Vrstva zatím není připojena k `approveDocument`, correction reopen/reapprove ani k přepočtu `warehouse_items.purchase_price`. Neexistuje ani export-intent entry pro price observation. D9B proto není cutover a neopravňuje odstranit D8 guard.

## Ověření

- pure source/chain/persistence a mutation kontrakty: **7/7 PASS**;
- schema/template parity spolu s D9A kontraktem: **2 soubory, 11/11 PASS**;
- celý API unit/contract balík: **99 souborů, 763/763 PASS**;
- isolated PostgreSQL 16 D9B test po migracích **105/105**, latest `0105_smooth_nitro`: **1/1 PASS**;
- společná původní R13 expand + D9B regrese: **3/3 files, 12/12 PASS**;
- testová časová race v původním outbox testu byla opravena odvozením monotónního času z DB `updated_at`; produkční kód ani trigger se tím nezměnil;
- API typecheck, scoped ESLint, schema declaration build, API production build a Prettier: **PASS**;
- Docker test běžel jednotlivě s limitem 0.75 CPU / 1 GiB RAM / 768 MiB tmpfs a kontejner byl odstraněn.

## Zbývající P1 hranice

- atomic export/outbox binding pro warehouse-price observation;
- parity checker a explicitní `historicalCompleteness=unknown` legacy backfill;
- current-price projection pravidlo a jeho souběhové/fault testy;
- caller dual-write, default-dark flag, fault injection a controlled cutover;
- odstranění legacy cleanup a D8 guardu až po doložené paritě;
- číslovaná forward-only migrace až po vyřešení live `0096` lineage; `0100` zůstává vyloučena.

`ignored`/discard retention a ukládání čitelného reason note zůstávají samostatnými business rozhodnutími popsanými v `17-n-r13-d9-ignored-reason-price-provenance-design.md`.

## Následné rozšíření

Původně chybějící export/outbox hranici následně lokálně doplnil R13-D9C. D9B checkpoint tím zůstává přesným záznamem stavu před rozšířením; aktuální stav a ověření jsou v `17-q-r13-d9c-warehouse-price-archive-checkpoint.md`.
