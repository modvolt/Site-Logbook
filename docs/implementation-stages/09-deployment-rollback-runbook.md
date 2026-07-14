# Etapa 9: Prednasazovaci audit a rollbackovy runbook

## Ucel

Tento dokument spojuje migrace 0086-0090 do jednoho overitelneho postupu.
Neprovadi migraci ani rollback automaticky. Produkcni data se pri priprave
tohoto runbooku nemenila.

## Overeny migracni retezec

| Migrace | Zmena | Zapis do existujicich radku |
| --- | --- | --- |
| 0086 | archivace zakazek | ne |
| 0087 | audit spotreby materialu | ano, jednorazovy legacy backfill |
| 0088 | casy vyjezdu | ne |
| 0089 | vazba nabidky na akci | ne |
| 0090 | historie fakturace nabidky | ne |

0087 zamerne nastavi vsechny drive existujici materialy jako spotrebovane a
doplni consumed_at z created_at. Stary program je povazoval za spotrebovane uz
pri vlozeni. Bez tohoto backfillu by se stare radky po nasazeni tvarily jako
novy plan a zmizely by ze skladu, statistik nebo fakturacnich podkladu.

## Pred nasazenim

1. Zastavit soubezne deploye a zapsat commit, image tag a cas zahajeni.
2. Vytvorit konzistentni databazovou zalohu a overit, ze ji lze nacist do
   izolovane PostgreSQL.
3. Zazalohovat objektove uloziste oddelene; migrace jej nemeni.
4. V obnovene izolovane databazi spustit migrace 0086, 0087, 0088, 0089 a 0090
   v tomto poradi.
   Pro prazdnou docasnou databazi lze pouzit automatickou branu:
   `pnpm --filter @workspace/db run test:workflow-rollback`. Povinne bezpecnostni
   promenne a omezeni jsou v
   `docs/implementation-stages/11-isolated-migration-rollback-gate.md`.
5. Overit pet odpovidajicich zaznamu v drizzle.__drizzle_migrations.
6. Spustit databazove testy pro archivaci, atomicke zalozeni, dokonceni,
   material, vyjezdy, prevod nabidky a fakturu z akce.
7. Teprve potom nasadit API a frontend ze stejne revize.

Migrace a aplikace nesmi byt rozdeleny mezi dve nesouvisejici revize.

## Smoke test po nasazeni

Pouzit pouze nove testovaci zaznamy:

1. zalozit testovaciho zakaznika, nabidku a zakazku,
2. pridat planovany material a overit, ze nevytvoril skladovy pohyb,
3. oznacit material jako spotrebovany a overit prave jeden pohyb,
4. pridat druhy vyjezd a overit rozsah data akce,
5. dokoncit vsechny testovaci zakazky,
6. vytvorit koncept faktury z nabidky bez viceprace,
7. koncept smazat a overit uvolnenou rezervaci,
8. vytvorit koncept znovu s explicitni vicepraci,
9. overit, ze druhe soubezne vytvoreni vrati 409,
10. po testu odstranit jen nove testovaci zaznamy standardnimi API operacemi.

## Aplikacni rollback

Aplikacni rollback je vychozi a nejbezpecnejsi varianta. Vraci se API a
frontend spolecne na bezprostredne predchozi etapu a aditivni schema se
ponechava. Platna provozni data ani auditni historie se nemazou.

- Etapa 8 -> 7: ponechat 0090. Predchozi aplikace tabulku ignoruje.
- Etapa 7 -> 6: ponechat 0089. converted_to_job_id zachova prvni zakazku.
- Etapa 6 -> 5: bez databazove zmeny.
- Etapa 5 -> 4: ponechat 0088; predchozi aplikace ignoruje casy vyjezdu.
- Etapa 4 -> 3: bez databazove zmeny.
- Etapa 3 -> 2: neprovadet pouze vymenou aplikace, pokud existuje jediny
  material s done = false. Stary workflow by jej povazoval za spotrebovany.
- Etapa 2 -> 1: bez databazove zmeny.
- Etapa 1 -> puvodni verze: nejprve obnovit vsechny archivovane zakazky
  standardni auditovatelnou operaci, jinak se ve stare aplikaci znovu zobrazi.

Pri problemu v pozdejsi etape se nevraci automaticky vsechny predchozi etapy.

## Plny databazovy rollback

Plny rollback schematu je krajni varianta pro nepouzite nebo izolovane
testovaci nasazeni. API musi byt zastavene a skripty se spousteji vyhradne
v opacnem poradi:

0090 -> 0089 -> 0088 -> 0087 -> 0086

Pred spustenim nacist
lib/db/rollbacks/preflight_0086_0090.sql. Kazdy blocker_count musi byt nula.
Nenulovy vysledek znamena, ze prislusny DOWN skript nesmi bezet.

Jednotlive DOWN skripty maji vlastni transakcni guard. To je posledni ochrana,
nikoli nahrada zalohy a preflightu.

0087 ma dva nezavisle blockery: planovany material a nezrekonstruovatelnou
historii skutecne spotreby. Legacy backfill s `consumed_at` shodnym s
`created_at` lze z puvodnich dat odvodit, ale skutecny cas nebo uzivatele
spotreby nelze. 0086 kontroluje vsechny tri archivni sloupce: `archived_at`,
`archived_by_user_id` a `status_before_archive`.

## Co se nesmi delat

- Nikdy automaticky neopravovat blocker pomoci DELETE nebo hromadneho UPDATE.
- Nikdy nemazat planovany material jen proto, aby rollback prosel.
- Nikdy nulovat vazby nabidky, akce nebo faktury bez exportu a vecne kontroly.
- Nikdy spoustet DOWN skripty v doprednem poradi.
- Nikdy spoustet databazove integracni testy nad produkcni databazi.
- Nikdy obnovovat jen databazi bez odpovidajici verze API a frontendu.

## Obnova ze zalohy

Pokud se migrace nebo aplikacni rollback nepodari:

1. ponechat API zastavene,
2. uchovat chybovy log a aktualni databazi pro forenzni porovnani,
3. obnovit posledni overenou zalohu do nove databazove instance,
4. spustit integritni a migracni testy nad obnovenou instanci,
5. prepnout aplikaci az po potvrzeni poctu zakazek, materialu, pohybu,
   navstev, nabidek, faktur a auditnich zaznamu.

Puvodni databazi neprepisovat, dokud neni obnova potvrzena.

## Povinne staging brany

- izolovane PostgreSQL se stejnou hlavni verzi jako produkce,
- obnova cerstve anonymizovane zalohy,
- dopredne migrace 0086-0090 bez chyby,
- vsechny databazove testy bez chyby,
- read-only preflight s ocekavanymi pocty,
- zkouska aplikacniho rollbacku o jednu etapu,
- zkouska plneho DOWN retezce jen na kopii bez blockeru,
- opetovne dopredne migrace po DOWN retezci,
- API a frontend build ze stejne revize.

Automaticky test `test:workflow-rollback` pokryva prazdnou docasnou databazi.
Neodstranuje povinnost samostatneho testu nad obnovenou anonymizovanou zalohou,
protoze jen ta obsahuje skutecne historicke kombinace a rollback blockery.

Dokud tyto brany neprojdou, zmena neni schvalena pro produkcni migraci.

## Lokalni overeni etapy

- Kontraktni sada migraci a rollbacku: 6 souboru, 33 testu, vse proslo.
- Typecheck celeho workspace: knihovny, API, frontend, mockup a skripty prosly.
- `git diff --check`: bez chyb; pouze informativni Windows upozorneni na konce
  radku v existujicim pracovnim stromu.
- Read-only preflight nebyl spusten nad produkci.
- Plny DOWN retezec nebyl spusten bez izolovane PostgreSQL obnovene ze zalohy.
