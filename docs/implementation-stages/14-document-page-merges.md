# Etapa 14: Vicestrankove doklady a rozpoznani typu

## Rozsah

Migrace `0091_document_page_merges` je aditivni. Pridava vazbu zakazkove
prilohy na prijaty doklad a poradi strany, puvod typu dokladu a auditovatelne
tabulky vratneho slouceni. Puvodni soubory, radky priloh ani stare sloupce
nemaze.

Technik muze v prirazene aktivni zakazce nahrat jeden doklad po stranach,
opravit jejich poradi a sloucit drive nahrane samostatne strany. Zakazkovy API
vraci pouze nahledy, poradi, typ a stav. Castky, polozky a schvaleni zustavaji
za opravnenim Fakturace.

Administrator muze ve Fakturaci sloucit 2 az 50 dokladu, zmenit poradi a pred
schvalenim slouceni rozdelit. Slouceni je odmitnuto pri schvalenem nebo
fakturovanem radku, potvrzenem parovani, propsanem materialu, skladovem pohybu,
finalnim stavu nebo prave bezici AI analyze.

## AI a typ dokladu

Vychozi volba uploadu je Automaticky. AI uklada vlastni navrh typu a jeho
jistotu oddelene od navrhu uzivatele. Pri rozporu je konecny typ `unknown`,
schvaleni je zablokovane a administrator musi potvrdit jednu z variant.
Automaticke spojeni rozpoznanych nekompletnich stran pouziva stejnou vratnou
sluzbu jako rucni slouceni.

## Nasazeni

1. Zalohovat databazi a overit dostupnost objektoveho uloziste.
2. Nasadit migraci `0091` a backend.
3. Overit paritu migraci a health endpoint.
4. Nasadit frontend.
5. Na testovaci zakazce nahrat tri nove strany, zmenit poradi, zkontrolovat AI
   a slouceni rozdelit zpet.
6. Teprve potom povolit bezne pouziti technikum.

## Rollback

Vychozi rollback je nasadit predchozi API a frontend spolecne a migraci `0091`
ponechat. Starsi verze aditivni tabulky a sloupce ignoruje. Originalni soubory
zustanou beze zmeny.

Plny databazovy rollback je v
`lib/db/rollbacks/0091_document_page_merges.down.sql`. Je urcen pouze pro
dosud nepouzitou funkci a sam se zablokuje, pokud existuje historie slouceni,
vazba prilohy na logicky doklad nebo nova historie typu. Produkcni data se
nesmi mazat ani nulovat jen proto, aby DOWN skript prosel.

Pred aplikacnim rollbackem zastavit nove uploady, zkontrolovat aktivni AI ulohy
a nasadit backend i frontend ze stejne predchozi revize. Aktivni slouceni je
vhodne nejprve rozdelit pres aplikaci, ale aditivni tabulky se i pote ponechaji
kvuli auditu.

## Overeni

- migracni retezec 92/92 na cerstve lokalni PostgreSQL databazi,
- cilenych backendovych testu 39/39 vcetne idempotentniho retry, soubehu,
  blokace ruznych zakazek, fakturovane polozky a skladoveho pohybu,
- typova kontrola celeho workspace,
- produkcni build API a PWA,
- desktopovy a mobilni E2E upload tri stran vcetne zmeny poradi,
- zadny test nebyl spusten proti produkcni databazi ani produkcnimu ulozisti.
