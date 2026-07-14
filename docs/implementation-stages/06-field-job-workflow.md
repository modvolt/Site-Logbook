# Etapa 6: Pracovni rezim zakazky

## Rozsah

Etapa pridava samostatne opravneni `jobs.work` pro praci technika na stavbe. Nepridava databazovou tabulku, sloupec ani migraci. Stavajici role zustavaji zachovane:

- `guest` nema `jobs.work` automaticky,
- `master` ma `jobs.work` i `jobs.manage`, a proto zustava ve spravcovskem rezimu,
- `admin` ma vsechna opravneni,
- terennimu pracovnikovi se nastavi role `guest`, propojeni na zamestnance (`personId`) a individualni povoleni `jobs.work`.

Pracovni rezim je aktivni pouze pri kombinaci `jobs.work` bez `jobs.manage`. Odebrani `jobs.manage` z uctu `master` proto umozni stejny omezeny rezim i bez zmeny role.

## Pravidla pristupu

Backend nepouziva pouze skryti prvku ve frontendu. Pracovnik vidi seznam, kalendar, detail, ukoly, material, fotografie a cas jen u zakazek, kde je prirazen alespon jednim z techto zpusobu:

1. hlavni pracovnik zakazky,
2. dalsi pracovnik v `job_assignees`,
3. pracovnik na nezrusenem vyjezdu zakazky.

Uzavrenou nebo zrusenou zakazku muze pracovnik precist, ale nemuze ji menit. Spravce s `jobs.manage` neni omezen prirazenim.

Pracovnik muze:

- spustit a zastavit pouze vlastni casovac,
- videt pouze vlastni casove zaznamy a vlastni souhrn,
- pridat ukol a prepnout jeho stav hotovo,
- pridat material bez ceny a potvrdit jeho spotrebu,
- upravit mnozstvi a jednotku dosud nespotrebovaneho materialu,
- pridat fotografie.

Pracovnik nemuze:

- menit stav, termin, cenu ani zakladni udaje zakazky,
- ovladat casovac jineho cloveka nebo rucne opravovat historii casu,
- menit nazev existujiciho materialu, cenu nebo skladove propojeni,
- vratit spotrebovany material do planu,
- mazat ukoly, material ani fotografie,
- ziskat faktury a ostatni typy priloh pres API,
- ziskat nakupni nebo prodejni ceny materialu bez financniho opravneni.

## Uzivatelske rozhrani

Domovska stranka pracovnika zobrazuje pouze dnesni prirazene zakazky a provozni udaje potrebne na stavbe. Navigace obsahuje jen Dnes, Kalendar, Zakazky a Muj prehled. Detail zakazky uprednostnuje adresu, kontakt, pracovniky, poznamku, vlastni cas, ukoly, material a fotografie. Spravcovske a financni sekce se v pracovnim rezimu nemontuji.

## Overeni pred nasazenim

1. Vytvorit nebo pouzit pouze testovaciho zamestnance a testovaci uzivatelsky ucet.
2. Propojit ucet se zamestnancem a nastavit roli `guest`.
3. Individualne povolit `jobs.work`; nepovolovat `jobs.manage`.
4. Priradit zamestnance pouze k testovaci aktivni zakazce.
5. Overit, ze Dnes, Kalendar a Zakazky obsahuji jen prirazenou zakazku.
6. Zadat URL cizi zakazky; API musi vratit 403 a nesmi vratit jeji data.
7. Spustit a zastavit vlastni casovac; pokus o cizi `personId` musi vratit 403.
8. Pridat ukol, oznacit jej hotovy a overit, ze zmena nazvu nebo smazani vraci 403.
9. Pridat material bez ceny, upravit mnozstvi a oznacit jej spotrebovany.
10. Overit, ze cena, skladovy vyber a financni metadata nejsou v UI ani v odpovedi API.
11. Nahrat fotografii a overit, ze seznam priloh pracovnika neobsahuje fakturu ani dodaci list.
12. Dokoncit testovaci zakazku spravcem a overit, ze pracovnik ji uz nemuze menit.

## Rollback

Etapa nema databazovou migraci ani automatickou zmenu produkcnich dat. Doporuceny rollback:

1. odebrat dotcenym pracovnim uctum individualni povoleni `jobs.work`,
2. nasadit predchozi API a frontend jako jednu verzi,
3. overit prihlaseni administratora a standardni detail zakazky,
4. ponechat pripadne ulozene nezname permission override; starsi resolver je ignoruje,
5. po overeni lze nevyuzite override `jobs.work` odstranit ve sprave uzivatelu.

Zaznamy vytvorene pracovnikem pred rollbackem, zejmena cas, ukoly, material a fotografie, se nemaji mazat ani automaticky vracet. Jsou platnou provozni historii a pripadna oprava musi byt provedena spravcem pres existujici auditovatelne operace.

## Produkcni pojistka

Prvni nasazeni aktivovat pouze pro jeden testovaci ucet a jednu testovaci zakazku. Teprve po overeni pozitivnich i negativnich scenaru rozsirit `jobs.work` na dalsi uzivatele. Pri chybe nejdrive odebrat opravneni; neni nutne menit schema ani obnovovat databazi ze zalohy.

## Lokalni overeni implementace

- typecheck cele workspace: uspesny,
- cilene testy opravneni a pracovniho workflow: 14/14,
- frontendove testy: 78/78,
- kompletni API sada bez databazoveho pripojeni: 379 testu proslo, 4 byly preskoceny; databazove sady nebylo mozne nacist bez lokalni PostgreSQL,
- produkcni build API: uspesny,
- produkcni build frontendu s `BASE_PATH=/`: uspesny.

Pri lokalnim overeni byl `DATABASE_URL` zamerne odstranen. Nebyla pouzita produkcni databaze a nebyla zmenena zadna produkcni data.
