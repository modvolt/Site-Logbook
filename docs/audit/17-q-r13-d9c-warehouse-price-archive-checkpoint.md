# R13-D9C – warehouse-price archive binding checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako neaktivovaná exportní expand vrstva; bez číslované migrace, caller wiring, provider zápisu a produkčních změn; R13 jako celek NOT READY**

## Výsledek

D9C uzavírá dříve otevřenou cestu mezi immutable warehouse-price observation a obecným účetním archivem:

- export intent má nový exact operation a entry kind `warehouse-price-observation`; obsahuje právě jednu observation, její ID/digest a jediný dotčený `incoming-cost-document` aggregate;
- `appendAccountingWarehousePriceObservationInTransaction` po observation insertu vloží odpovídající intent ve stejné caller-owned transakci. Funkce vlastní transakci neotevírá;
- exact replay je no-op jen tehdy, pokud existují shodné canonical observation i intent bytes. Chybějící intent, orphan intent nebo odlišný intent jsou fail-closed;
- DB adapter načítá outbox intent přes strict canonical verifier a additive Drizzle/SQL operation check dovoluje nový operation;
- archive DB repository načte exact canonical observation podle entry identity;
- archive bundle a manifest ověřují canonical observation bytes, observation ID, entry digest a navíc vážou `affectedAggregates` k `observation.source.aggregateId`;
- bounded worker používá stejný create-only/versioned object a read-back/CAS protokol jako ostatní účetní evidence; žádný nový worker ani paralelní storage protokol nevznikl;
- existující offline CLI ověřuje i cenový bundle/checksum/manifest bez důvěry v databázi nebo mutable object key.

## Atomická hranice a fault model

Observation i export intent vznikají přes adapter již otevřené doménové transakce. Injektovaný PostgreSQL `BEFORE INSERT` fault na cenovém outbox operation prokázal, že při selhání intent insertu nezůstane observation ani outbox řádek. Replay zároveň odmítne starší nekonzistentní stav, kde by existovala pouze jedna polovina dvojice.

To není aktivace exportu. Archive worker není připojen k runtime scheduleru, storage provider se nevolal a nevznikl žádný S3/GHCR/GitHub artifact.

## Ověření

- cílený canonical/persistence/archive/static slice: **3 soubory, 23/23 PASS**;
- celý API unit/contract balík: **99 souborů, 765/765 PASS**;
- isolated PostgreSQL 16 price persistence + outbox rollback po migracích **105/105**, latest `0105_smooth_nitro`: **2/2 PASS**;
- širší účetní DB regrese v osmi disposable databázích: **8/8 souborů, 34/34 PASS**;
- API typecheck, scoped ESLint, schema declaration build, API production build, Prettier a `git diff --check`: **PASS**;
- Docker běžel s limitem 0,75 CPU / 1 GiB RAM / 768 MiB tmpfs a testovací kontejner byl odstraněn.

## Nezměněné hranice

- žádná číslovaná migrace ani journal změna; journal zůstává **105/105** na `0105_smooth_nitro` a `0100` zůstává vyloučena;
- žádné napojení `approveDocument`, correction reopen/reapprove ani zápisu `warehouse_items.purchase_price`;
- žádný provider/S3 zápis, runtime worker, deploy, backfill, produkční secret nebo produkční DB změna;
- D8 guard proti reopen dokladu s legacy `warehouse_price_history` zůstává aktivní.

## Zbývající P1 hranice

- parity checker a explicitní `historicalCompleteness=unknown` legacy backfill;
- DB adapter/cutover pro current-price projection; čisté projection pravidlo a mutation testy následně doplnil R13-D9D;
- caller dual-write za exact default-dark flagy a controlled cutover;
- provider capability preflight, immutable-versioned Hetzner S3 adapter a runtime aktivace archive workeru;
- odstranění legacy cleanup/D8 guardu až po doložené paritě;
- číslovaná forward-only migrace až po vyřešení live `0096` lineage; `0100` se nezařazuje.

`ignored`/discard retention a ukládání čitelného reason note zůstávají dvěma samostatnými business rozhodnutími v `17-n-r13-d9-ignored-reason-price-provenance-design.md`.
