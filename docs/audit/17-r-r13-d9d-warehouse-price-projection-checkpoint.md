# R13-D9D – warehouse-price projection checkpoint

Datum: 2026-08-11  
Stav: **lokálně READY jako čistý projection/parity kontrakt; bez DB projection writeru, caller aktivace, migrace a produkčních změn; R13 jako celek NOT READY**

## Nalezená a opravená mezera

D9A původně požadoval, aby první observation každého warehouse item streamu byla vždy `observed`. To neumělo reprezentovat legitimní correction, která:

- nově přidá materiál na dosud nepoužitou skladovou kartu; nebo
- přesune opravený materiál z původní skladové karty na jinou.

Taková cena je svázána s `correction` version a `correction_linked` eventem, proto nemůže předstírat původní `approved`/`observed` událost. Kontrakt i SQL trigger nyní dovolí sequence `0` pro `observed` nebo `corrected`, ale dál odmítají první `withdrawn`. Disposable PostgreSQL test prokázal, že correction-backed first append projde exact source triggerem a vytvoří i outbox intent.

## Projection pravidlo

Nový čistý verifier přehrává úplný, vzestupně seřazený item-local stream:

1. vyžaduje sequence `0..N` bez mezer, exact previous hash, unique observation ID a jediný warehouse item;
2. pozdější `observed` musí supersedovat bezprostřední předchozí item head;
3. `withdrawn` invaliduje právě jednu dřívější price-bearing observation stejného source document/version/line a stejnou observation nelze withdrawnout dvakrát;
4. `corrected` navazuje na withdrawal stejného document aggregate, ale u prázdného cílového item streamu může být prvním krokem;
5. efektivní current price je nejnovější price-bearing observation, kterou žádný withdrawal neinvalidoval;
6. stream head a efektivní price observation jsou vedeny odděleně. Withdrawal novějšího dokladu proto může být stream head, zatímco cena bezpečně fallbackne na starší stále platný doklad.

Toto zachovává dnešní business význam „po odebrání novější ceny obnovit poslední zbývající platnou cenu“, ale bez mazání historie.

## Parity hranice

Parity verifier porovnává odvozenou cenu numericky (`10` odpovídá DB reprezentaci `10.00`) a současně vyžaduje explicitní shodnou měnu. Prázdný platný stream vyžaduje `null` cenu i měnu.

Současná tabulka `warehouse_items` má pouze `purchase_price numeric(10,2)` a žádný currency sloupec. Proto zatím nelze bezpečně aktivovat obecnou multi-currency projekci. D9D záměrně nepředstírá implicitní CZK a nepřidává bez schválení FX konverzi. Bezpečný další model musí zvolit jednu z variant:

- doporučeno: uložit k projekci explicitní měnu a cizí měnu nekonvertovat bez samostatného canonical FX kontraktu;
- užší alternativa: projection writer povolit pouze pro CZK a ostatní observation ponechat jen jako immutable evidence do pozdějšího currency-aware řešení.

## Ověření

- projection/fallback/correction-first/parity mutation kontrakt: **5/5 PASS**;
- observation + archive regresní slice po změně first-step invarianty: **2 soubory, 19/19 PASS**;
- celý API unit/contract balík: **100 souborů, 770/770 PASS**;
- isolated PostgreSQL 16 price persistence po migracích **105/105**, latest `0105_smooth_nitro`: **3/3 PASS**;
- API typecheck, scoped ESLint, API production build, Prettier a `git diff --check`: **PASS**;
- nevznikla číslovaná migrace; `0100` zůstává vyloučena;
- testovací Docker kontejner byl omezen na 0,75 CPU / 1 GiB RAM / 768 MiB tmpfs a byl odstraněn.

## Nezměněné hranice

- projection verifier není připojen k `warehouse_items.purchase_price` ani legacy `warehouse_price_history`;
- `approveDocument`, reopen a reapprove nevytvářejí price observation;
- D8 guard zůstává aktivní;
- chybí DB parity report, legacy backfill, caller fault/concurrency testy, provider aktivace, číslovaná migrace, staging a production cutover;
- `ignored`/discard a čitelný reason note stále čekají na dvě business rozhodnutí v D9 designu.
