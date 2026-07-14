# Etapa 4: Bezpecne dokonceni zakazky

## Rozsah

- Jednotne stavove prechody pro jednu i vice zakazek.
- Kontrola zakaznika, bezicich casovacu, ukolu, materialu a odpracovaneho casu pred dokoncenim.
- Tvrde blokace nelze obejit; upozorneni musi uzivatel vyslovne potvrdit.
- Zakaz spusteni noveho casovace na dokoncene, zrusene nebo vyfakturovane zakazce.
- Audit kazde skutecne zmeny stavu.
- Atomicke vytvoreni dalsi opakovane servisni zakazky pri dokonceni.

Etapa nema databazovou migraci a nemeni existujici zaznamy pri nasazeni.

## Stavova pravidla

Dokonceni blokuje chybejici zakaznik nebo alespon jeden aktivni casovac. Nedokoncene ukoly, pouze planovany material a nulovy cas u hodinove zakazky jsou upozorneni. Hromadna operace je atomicka: pokud neprojde jedna zakazka, nezmeni se zadna.

Dokoncenou zakazku lze znovu otevrit, jen pokud neni navazana na nestornovanou fakturu. Stav `vyfakturovano` se nadale meni pouze fakturacnim workflow.

## Overeni pred nasazenim

1. Spustit jednotkove a kontraktni testy API.
2. Spustit typecheck a build API i frontendu.
3. Na testovaci zakazce overit blokaci aktivniho casovace.
4. Na testovaci zakazce overit potvrzeni upozorneni a audit `job_completed`.
5. V hromadnem vyberu spojit jednu platnou a jednu blokovanou zakazku; stav se nesmi zmenit ani jedne.
6. Overit, ze bezna editace v administraci meni stav pres stavovy endpoint.

## Rollback

Rollback je aplikacni: nasadit predchozi verzi API a frontendu spolecne. Neni treba vracet databazovou migraci ani mazat data. Stavove zmeny a auditni zaznamy vytvorene uzivateli za behu nove verze zustanou zachovane; automaticky se nevraceji, protoze mohou predstavovat platne provozni udalosti.

Pred rollbackem zastavit nove deploye a zaznamenat cas prepnuti verze. Po rollbacku overit nacteni detailu zakazky, spusteni a zastaveni casu a beznou zmenu stavu na testovaci zakazce. Pokud je potreba vratit konkretni chybne provedeny stav, provest to standardni stavovou operaci s auditni stopou, nikoli primym SQL zasahem.

## Izolovany databazovy test

Databazovy integracni test je povoleno spoustet pouze proti docasne nebo lokalni testovaci databazi a pouze s explicitnim prepinacem `JOB_STATUS_DB_TEST_ENABLED=true`. Produkcni `DATABASE_URL` se pro tento test nesmi pouzit.
