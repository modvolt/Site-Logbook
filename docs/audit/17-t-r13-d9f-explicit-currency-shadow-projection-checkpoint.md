# R13-D9F – explicit-currency shadow projection checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako neaktivovaná expand/shadow vrstva; bez caller wiring, read cutoveru, backfillu, číslované migrace a produkční změny; R13 jako celek NOT READY**

## Schválené pravidlo 3A

Current warehouse purchase price musí nést explicitní ISO měnu. Hodnota v EUR, USD nebo jiné měně se uchová jako tato měna. Aplikace nesmí předpokládat CZK a nesmí provést implicitní ani automatickou FX konverzi. Budoucí převod vyžaduje samostatný canonical FX artefakt, schválený kurz, okamžik, zdroj a rounding policy; nic z toho D9F nezavádí.

## Implementovaný shadow model

Nový strict canonical `site-logbook.warehouse-price-projection-head/v1` je plně odvozený z D9A immutable observation streamu a obsahuje:

- exact stream-head observation ID, digest a sequence;
- exact stále účinnou observation, cenu a explicitní měnu, nebo celý null tuple;
- `valuationPolicy.mode = source-currency`;
- `fxConversionApplied = false`;
- `projectedAt` odvozené z immutable stream headu a vlastní SHA-256.

Nečíslovaná SQL šablona a Drizzle model přidávají samostatnou tabulku `accounting_warehouse_price_projection_heads`. Tabulka je shadow read model; záměrně nemění `warehouse_items.purchase_price`, aby nevznikl poloviční runtime cutover bez měny.

## Transakční a DB invarianty

Preferovaný caller seam vloží observation, její archive intent a obnoví explicit-currency projection ve stejné caller-owned transakci. Adapter:

1. zamkne owning warehouse item;
2. načte celý ordered immutable stream;
3. deterministicky přepočítá canonical head;
4. provede initial insert nebo exact one-sequence CAS advance;
5. exact replay je no-op; gap vyžaduje samostatně reviewovaný bootstrap.

DB trigger navíc kontroluje, že stream head je skutečně poslední observation položky, efektivní cena je nejnovější newithdrawnutá price-bearing observation a update navazuje přesně o jednu sequence a previous digest. Projection row nelze smazat. Přímá změna currency bez odpovídajících canonical bytes a observation je odmítnuta.

## Ověření

- projection-head canonical/no-FX/binding kontrakt: **4/4 PASS**;
- projection reducer + parity + SQL marker slice: celkem **4 soubory, 18/18 PASS**;
- isolated PostgreSQL 16 observation/outbox/projection persistence po migracích **105/105**, latest `0105_smooth_nitro`: **4/4 PASS**;
- DB test ověřil initial insert, exact replay, exact one-step CAS advance, explicitní CZK, nezměněný legacy `warehouse_items.purchase_price`, odmítnutí currency tamperu a delete;
- DB declarations, API typecheck, scoped ESLint a Prettier: **PASS**.

## Nezměněné hranice

- projection tabulka je pouze v nečíslované expand šabloně;
- approval/reopen/correction caller stále používá starý guarded path a nevytváří observations ani projection head;
- žádné runtime API/UI zatím shadow tabulku nečte;
- D9G report už exactně váže shadow head do immutable streamu; caller/backfill/read cutover však dál nejsou aktivované;
- nevznikl backfill ani automatická oprava rozdílů;
- nebyl změněn env, staging, produkce, S3 ani GitHub a `0100` zůstává vyloučena.

## Další bezpečný řez

Rozšířit read-only parity report tak, aby strictně načetl a revalidoval canonical projection head, odlišil missing/stale shadow head od price driftu a až po samostatném parity checkpointu umožnil plánovat caller dual-write a controlled backfill. Legacy current sloupec se do té doby nepřepisuje.
