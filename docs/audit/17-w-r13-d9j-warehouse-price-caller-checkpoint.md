# R13-D9J – warehouse-price caller dual-write checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako default-dark caller/correction vrstva; bez číslované migrace, bootstrapu/backfillu, read cutoveru, UI změny, provideru, deploye a produkčního zápisu; R13 jako celek NOT READY**

## Zapojený caller

Exact `ACCOUNTING_WAREHOUSE_PRICE_DUAL_WRITE_ENABLED=true` je default-dark a smí být aktivní jen společně s approval a correction dual-write. Samotné schválení dokladu dál potichu nemění skladovou cenu. Immutable observation vzniká pouze při explicitní administrátorské akci `updateWarehousePricesFromDocument` nad již schváleným dokladem:

- caller zamkne document root a znovu ověří, že current mutable obsah přesně odpovídá current immutable `approved` nebo `correction` version;
- pro každý material line vytvoří deterministickou `observed` nebo `corrected` observation, export intent a explicit-currency shadow projection ve stejné transakci jako legacy item/history update;
- exact retry je replay bez další observation nebo outbox řádku; změna warehouse matchu pod stejnou business identitou je fail-closed;
- warehouse itemy se před první price mutation zamykají vzestupně a match se po získání zámku znovu ověří, takže čekající writer nepřepíše mezitím změněný katalogový cíl.

Registry accounting writerů nyní obsahuje 17 veřejných seamů a explicitní price action klasifikuje jako `feature-flagged-price-observation-outbox`.

## Correction a reopen

Při `approved -> needs_review` caller nejprve vyžaduje exact 1:1 pokrytí všech legacy price-history řádků current immutable version observations. Každý warehouse item musí mít canonical shadow head, který se znovu odvodí z celého item streamu a numericky i měnově odpovídá legacy current/history.

Teprve potom stejná transakce:

1. appenduje `review_reopened` event a restricted reason artifact;
2. appenduje jednu `withdrawn` observation za každý aktivní source line;
3. odstraní mutable legacy price rows a obnoví legacy current na poslední zbývající cenu;
4. znovu ověří parity shadow headu a legacy projekce.

Chybějící observation, neúplné pokrytí, už existující withdrawal, projection drift nebo nebootstrapped legacy cena ukončí operaci před commitem. Correction reapproval vytvoří version/event v D8; až následná explicitní price action přidá `corrected` observation. Kontrakt nyní dovoluje correction přidat nebo přesunout řádek i na již neprázdný item stream tak, že superseduje current item head; replacement na stejném itemu může dál přesně odkazovat dřívější withdrawal téhož document aggregate.

## Měna a přesnost

Schválená volba 3A zůstává striktní:

- shadow head vždy uchovává explicitní ISO currency;
- `valuationPolicy.mode=source-currency` a `fxConversionApplied=false` jsou povinné;
- protože současný `warehouse_items.purchase_price` nemá currency sloupec, default-dark caller zatím odmítá non-CZK source místo implicitního FX nebo bezměnového zápisu;
- caller odmítne také source cenu, kterou legacy dvoudecimální sloupec nedokáže uložit beze ztráty.

Jde o bezpečný aktivační limit, ne o tvrzení, že budoucí účetní model je pouze CZK. Multi-currency read cutover vyžaduje samostatnou migraci a UI/API změnu.

## Ověření

- čisté observation/projection/DDL kontrakty: **4 soubory, 22/22 PASS**;
- izolovaný PostgreSQL 16 caller lifecycle: **3/3 PASS** po **105/105** migracích, latest `0105_smooth_nitro`;
- stávající correction guard: **5/5 PASS**;
- observation/outbox/projection persistence a upravený correction-on-existing-item trigger: **4/4 PASS**;
- souhrnný cílený DB důkaz: **3 soubory, 12/12 PASS**;
- API TypeScript: **PASS**;
- celý hermetický API unit balík: **106/106 souborů, 793/793 PASS**. Jediný původně křehký OpenAPI assertion byl zúženě opraven tak, aby dál vyžadoval volitelný deprecated PPE token, ale nebyl závislý na uvozovkách ani zalomení aktuálního Orval výstupu.

DB fault test odmítl právě warehouse-price outbox insert a prokázal rollback legacy current, history, observation, intent i shadow headu. Lifecycle test prokázal `observed -> withdrawn -> corrected`, exact replay, explicitní CZK/no-FX head, nulovou legacy cenu po withdrawal a fail-closed non-CZK/unbootstrapped legacy stav.

## Nezměněné hranice

- neexistuje číslovaná expand migrace; `0100` zůstává vyloučena;
- flag není přidaný do runtime env a není aktivovaný;
- nebyl proveden bootstrap/backfill, read cutover ani UI cutover;
- nebyl kontaktován provider/S3, staging ani produkce;
- neproběhl deploy, commit ani push.

## Další bezpečný řez

Další lokální část R13 má navrhnout controlled warehouse-price bootstrap/backfill preflight a dry-run manifest, nikoli jej spustit. Musí vytvořit jen explicitně označené legacy observations, zachovat neznámou historickou úplnost, prokázat item-by-item parity a oddělit plán od apply. Číslovaná migrace, data mutation, runtime flag activation a read cutover zůstávají samostatnými schvalovacími hranicemi.
