# R13-D9G – projection-aware warehouse-price parity checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako read-only pre-cutover gate; bez caller/backfill/read cutoveru, migrace a produkčního čtení; R13 jako celek NOT READY**

## Výsledek

D9E parity report byl povýšen na strict `site-logbook.warehouse-price-parity-report/v2`. Každý warehouse item nyní zahrnuje exact canonical D9F projection head, pokud existuje. Verifier:

1. znovu přehraje celý immutable observation stream;
2. rekanonizuje a rehashuje projection head;
3. vyžaduje exact stream/effective observation binding;
4. odvodí current měnu pouze z tohoto headu;
5. samostatně porovná číselnou continuity proti stále používanému legacy `warehouse_items.purchase_price`.

Native stream bez projection headu už není neurčité „currency unbound“, ale přesný blokující stav `native_projection_missing`. Validní head s explicitní měnou a shodnou legacy current cenou je `native_match`. Cena nebo měna odlišná od immutable streamu se nedostane do reportu jako přijatelná data; strict binding skončí fail-closed.

## Read-only DB hranice

CLI v témže `REPEATABLE READ READ ONLY` snapshotu počítá i projection heads, odmítne více heads než warehouse items a po načtení ověří count parity. Projection canonical bytes se načtou bez secret-bearing metadata a jejich sémantika se ověří až proti úplnému ordered observation streamu.

Audit dál nemá žádný apply/backfill/update/delete režim. Výstup pouze říká, které položky mohou později pokračovat do kontrolovaného cutover plánu.

## Ověření

- celý API unit/contract balík: **102/102 souborů, 779/779 PASS**;
- D9E–D9G focused unit slice: **4 soubory, 18/18 PASS**;
- isolated PostgreSQL 16: parity audit + observation/outbox/projection persistence **2/2 soubory, 6/6 PASS**, migrace **105/105**, latest `0105_smooth_nitro`;
- DB integrace ověřila `native_match` z exact projection headu, explicitní `CZK`, initial/replay/one-step CAS, nulovou mutaci read-only auditu, hard cap abort, currency tamper a delete rejection;
- DB declarations, API typecheck, scoped ESLint, Prettier, API production build a `git diff --check`: **PASS**;
- build byl po sandbox read-denial zopakován mimo sandbox a uspěl; nešlo o code failure.

## Nezměněné hranice

- žádný audit nebyl spuštěn proti staging ani produkci;
- nebyl změněn caller, runtime read path ani `warehouse_items.purchase_price`;
- neproběhl backfill, auto-fix, S3/provider zápis, deploy, commit ani push;
- shadow schema zůstává pouze v nečíslované šabloně;
- `0100` zůstává vyloučena.

## Další práce

Warehouse-price větev je připravena pro samostatný default-dark caller dual-write a pozdější controlled bootstrap/backfill, nikoli ještě pro aktivaci. V D9 lze nyní pokračovat schválenými volbami 1A/2A: oddělit early operational discard od reviewed immutable rejection a vytvořit bounded čitelný reason artifact v restricted archive.
