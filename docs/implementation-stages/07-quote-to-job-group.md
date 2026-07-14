# Etapa 7: Nabidka jako zdroj akce zakazek

## Rozsah

Prijata cenova nabidka se uz neprevadi pouze na jednu osamocenou zakazku s dnesnim datem. Administrator pri zahajeni realizace zvoli prvni planovany termin a system v jedne transakci vytvori:

1. akci zakazek,
2. prvni zakazku v teto akci,
3. vazbu nabidky na akci i prvni zakazku,
4. auditni zaznam prevodu.

Stavajici `converted_to_job_id` zustava zachovan jako kompatibilni odkaz na prvni zakazku. Migrace 0089 pridava nullable `converted_to_job_group_id`, cizi klic s `ON DELETE SET NULL` a unikatni index. Migrace neprovadi `UPDATE`, `DELETE` ani backfill existujicich nabidek.

## Pravidla workflow

- Stejna prace pokracujici dalsi den se prida jako dalsi vyjezd puvodni zakazky.
- Samostatny dalsi ukol nebo cast realizace se prida jako nova zakazka v teze akci.
- Detail akce nabizi prime zalozeni dalsi zakazky s predvyplnenym `groupId`, zakaznikem a terminem.
- Backend overuje existenci akce a shodu zakaznika pri atomickem zalozeni zakazky.
- Existujici zakazku nelze pres API potichu presunout z jine akce.
- Do akce se zadanym zakaznikem nelze vlozit zakazku jineho zakaznika.
- Prvni zakazku vytvorenou z nabidky nelze z akce odebrat ani archivovat.
- Akci vytvorenou z nabidky nelze smazat bez ztraty dohledatelnosti obchodniho puvodu.
- Rozsah data akce se pri cteni pocita z hlavnich terminu zakazek a vsech nezrusenych vyjezdu. Prodlouzeni vyjezdem se proto projevi v `dateTo`.

## Atomicke chovani

`convertQuoteToJob` zamkne radek nabidky pomoci `SELECT FOR UPDATE`. Skupina, prvni zakazka, oba odkazy a audit vznikaji uvnitr jedine databazove transakce. Dve soubezna volani nemohou vytvorit dve akce: prvni transakce uspesne dokonci prevod a druha po ziskani zamku vrati HTTP 409.

Razeni zakazek pro zvoleny den pouziva stejny PostgreSQL advisory lock jako bezne atomicke zalozeni zakazky. Nova zakazka proto nedostane kolidujici `sortOrder` ani pri soubehu.

## Co tato etapa zamerne nedela

Etapa nevytvari fakturu a neoznacuje nabidku jako vyfakturovanou. Fakturace cele akce z polozek prijate nabidky, skutecnych vicepraci a vazba `converted_to_invoice_id` patri do nasledujici samostatne etapy. Toto rozdeleni umoznuje nasadit a overit planovani realizace bez zasahu do financnich zaznamu.

## Overeni pred nasazenim

1. Aplikovat migraci 0089 v testovacim prostredi.
2. Overit, ze vsechny existujici nabidky maji `converted_to_job_group_id = NULL` a ostatni sloupce jsou beze zmeny.
3. Vytvorit testovaci nabidku, prijmout ji a zvolit prvni termin.
4. Overit jednu novou akci, jednu zakazku, oba odkazy na nabidce a auditni udalost.
5. Zopakovat prevod stejne nabidky; API musi vratit 409 a pocty se nesmi zmenit.
6. Pridat druhy vyjezd na pozdejsi datum a overit nove `dateTo` akce.
7. Z detailu akce pridat druhou testovaci zakazku a overit predvyplnenou akci i zakaznika.
8. Zkusit pridat zakazku jineho zakaznika; API musi vratit 409.
9. Zkusit odebrat nebo archivovat prvni zakazku; API musi vratit 409.
10. Zkusit smazat zdrojovou akci; API musi vratit 409.
11. Overit, ze starsi prevedena nabidka bez noveho odkazu se stale otevre pres `convertedToJobId`.

Pouzivat pouze nove testovaci zaznamy. Neupravovat existujici produkcni nabidky, zakazky ani faktury.

## Rollback aplikace

Nejbezpecnejsi rollback je nasadit predchozi API a frontend spolecne a aditivni sloupec ponechat. Starsi aplikace jej ignoruje a `converted_to_job_id` stale ukazuje na prvni zakazku. Vytvorena akce i vsechny zakazky zustanou zachovane jako provozni data.

Pred rollbackem:

1. zastavit nove prevody nabidek,
2. zaznamenat ID nabidek prevedenych novou verzi,
3. nasadit predchozi API a frontend,
4. overit otevreni prvni zakazky z kazde dotcene nabidky,
5. ponechat migraci 0089 v databazi.

## Plny databazovy rollback

`lib/db/rollbacks/0089_thin_robin_chapel.down.sql` je urcen jen pro stav, kdy jeste nebyla prevedena zadna nabidka. Skript se zablokuje, pokud existuje jediny nenulovy `converted_to_job_group_id`.

Pred spustenim plneho rollbacku je nutne zastavit API, exportovat tabulky `quotes`, `job_groups` a `jobs`, overit nulovy pocet pouzitych odkazu a teprve potom spustit skript. Rollback odstrani index, cizi klic, sloupec a zaznam migrace v jedne transakci.

Pokud uz odkazy existuji, sloupec neodstranovat. Aplikacni rollback je bezpecny a nezpusobi ztratu dat.

## Lokalni overeni

- Cilene kontraktni testy etap 2, 5 a 7: 15/15 uspesne.
- Frontendove testy: 78/78 uspesne.
- Cela API sada bez databazoveho pripojeni: 385 testu uspesne, 4 preskocene; databazove testovaci soubory se bez `DATABASE_URL` nenacetly a 4 testy zamku selhaly pouze na nedostupnem lokalnim PostgreSQL.
- TypeScript typecheck celeho workspace: uspesny.
- Produkcni build API: uspesny.
- Produkcni build frontendu a service workeru: uspesny; zustavaji pouze existujici upozorneni na velikost bundlu a sourcemapy UI komponent.

Databazovy test soubezneho prevodu je pripraven v `artifacts/api-server/test/quote-convert-concurrent.test.ts`, ale nesmi se spoustet proti produkcni databazi. Pred nasazenim se musi spustit nad izolovanou PostgreSQL databazi s migracemi 0086-0089.
