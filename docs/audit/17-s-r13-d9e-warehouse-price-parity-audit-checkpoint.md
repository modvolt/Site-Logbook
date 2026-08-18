# R13-D9E – warehouse-price read-only parity audit checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako bounded read-only inventura; bez backfillu, projection writeru, migrace a produkčního čtení; R13 jako celek NOT READY**

## Výsledek

Nový CLI audit pořídí v jediné PostgreSQL transakci `REPEATABLE READ READ ONLY` konzistentní snapshot:

- aktuální `warehouse_items.purchase_price`;
- native immutable `accounting_warehouse_price_observations`;
- legacy mutable `warehouse_price_history`.

Nejdřív načte jen počty. Pokud překročí schválený limit položek, observations nebo legacy řádků, skončí před jejich inventurními dotazy. CLI nemá mutation režim a explicitně odmítá `--apply`, `--execute`, `--backfill`, `--update` a `--delete`.

Výstup je strict canonical `site-logbook.warehouse-price-parity-report/v1` s SHA-256. U každé položky znovu přehraje native observation stream přes D9D projection verifier a zařadí ji do jedné z přesných tříd:

- `empty`, `native_match`, `native_match_empty` → `PASS`;
- `legacy_only` → `REVIEW`, protože historie je pouze pozorovaná a její úplnost zůstává `unknown`;
- currency/price drift, native/legacy overlap nebo neprokázaná current cena → `BLOCK`.

Legacy výstup je minimalizovaný na identity, cenu, měnu, čas a domain-separated row digest. Supplier metadata, poznámky, názvy dokladů ani source payload se nenačítají ani nevypisují.

## Důležitý fail-closed výsledek pro volbu 3A

Současný `warehouse_items.purchase_price` nemá uloženou měnu. Native nenulová cena proto nemůže být označena za shodnou jen implicitním předpokladem CZK a audit ji klasifikuje jako `native_currency_unbound`/`BLOCK`. Schválená varianta 3A znamená explicitní měnu current-price projekce a žádnou automatickou FX konverzi; tento checkpoint zatím pouze přesně dokládá data před cutoverem.

## Ověření

- D9E canonical report a CLI policy: **5/5 PASS**;
- isolated PostgreSQL 16 audit po migracích **105/105**, latest `0105_smooth_nitro`: **2/2 PASS**;
- DB test porovnal exact mutable snapshot před/po CLI, ověřil nulovou mutaci, canonical report, omezený výstup a pre-inventory cap abort;
- test odhalil a opravil deprecated souběžné `client.query()` volání na jediném `pg.Client`; inventurní dotazy jsou nyní explicitně sekvenční v témže fixed snapshotu;
- scoped Prettier, ESLint a API typecheck: **PASS**;
- jednorázový Docker PostgreSQL byl omezen na 0,75 CPU / 768 MiB RAM / 512 MiB tmpfs a po testu odstraněn.

## Nezměněné hranice

- audit nebyl spuštěn proti staging ani produkční DB;
- nevznikl backfill, projection update, caller write ani S3/provider zápis;
- nebyla přidána číslovaná migrace a `0100` zůstává vyloučena;
- report není povolení k automatické opravě `REVIEW`/`BLOCK` položek;
- D8 price-history guard zůstává aktivní do samostatně ověřeného caller + currency projection + backfill cutoveru.

## Další bezpečný řez

Implementovat nečíslovaný, default-dark kontrakt explicitní current-price projekce s měnou. Cizí měna se uloží jako cizí měna; bez samostatně schváleného canonical FX artefaktu se nesmí převést ani sčítat s jinou měnou. Až poté lze parity audit rozšířit o důkaz, že current projection odkazuje na přesnou efektivní observation.
