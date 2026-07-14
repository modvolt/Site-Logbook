# Etapa 13: Izolovana databazova workflow sada

## Ucel

Etapa poskytuje jedinny fail-closed prikaz pro databazove testy zakazkoveho
workflow. `DATABASE_URL` urcuje pouze izolovany PostgreSQL server a prihlaseni.
Runner vytvori novou databazi `test_workflow_suite_*`, aplikuje do ni vsechny
migrace, spusti testy a databazi v `finally` odstrani.

Nazev databaze uvedeny v `DATABASE_URL` se nikdy nemigruje a child procesu
Vitest se nepreda.

## Pokryte testy

1. `job-create-atomic-db.test.ts`
   - atomicke zalozeni zakazky, prirazeni a ukolu,
   - planovany material bez skladoveho pohybu,
   - spotreba a navrat materialu,
   - rollback cele transakce pri chybe pozdejsiho materialu.
2. `job-status-db.test.ts`
   - blokery a varovani pred dokoncenim,
   - audit dokonceni a znovuotevreni,
   - atomicky rollback hromadneho prechodu.
3. `quote-job-group-invoice-db.test.ts`
   - soubezne vytvoreni prave jednoho konceptu,
   - snapshot nabidky a vazby vsech zakazek akce,
   - uvolneni rezervace po smazani konceptu se zachovanim historie.

Testy bezi seriove s jednim workerem, ale jejich vnitrni soubezne scenare se
zachovavaji.

## Bezpecnostni pojistky

- Vyzaduje `WORKFLOW_DB_SUITE_ENABLED=true`.
- Odmita `NODE_ENV=production`.
- Vzdaleny server vyzaduje `ALLOW_REMOTE_ISOLATED_DB_TEST=true`.
- Do Vitest procesu vstupuje pouze vygenerovana `testDbUrl`.
- Express test dostava pevny test-only `SESSION_SECRET`, nikoli produkcni secret.
- Runner kontroluje uplnou migracni paritu pred testy.
- Cleanup ukoncuje pouze spojeni s vygenerovanym nazvem databaze.
- Vnejsi `finally` zacina pred vytvorenim databaze, takze se cleanup zkusi i
  pri chybe zavirani vytvareciho spojeni.
- Testy nevolaji produkcni web ani objektove uloziste.

## Spusteni lokalne

```powershell
$env:NODE_ENV = "test"
$env:WORKFLOW_DB_SUITE_ENABLED = "true"
$env:DATABASE_URL = "postgresql://uzivatel:heslo@localhost:5432/test_admin"
pnpm --filter @workspace/db run test:workflow-db
```

## Spusteni na vzdalenem izolovanem PostgreSQL

```powershell
$env:NODE_ENV = "test"
$env:WORKFLOW_DB_SUITE_ENABLED = "true"
$env:ALLOW_REMOTE_ISOLATED_DB_TEST = "true"
$env:DATABASE_URL = "postgresql://uzivatel:heslo@staging-db:5432/test_admin"
pnpm --filter @workspace/db run test:workflow-db
```

Ucet potrebuje `CREATE DATABASE` a `DROP DATABASE`. Produkcni cluster ani
produkcni prihlasovaci udaje se nesmi pouzit.

## Ocekavany vysledek

Uspech vyzaduje:

- plnou migracni paritu,
- nulovy exit code vsech tri testovacich souboru,
- radek `All isolated workflow DB tests passed`,
- radek potvrzujici odstraneni docasne databaze.

Pri chybe testu runner stale vstoupi do cleanupu. Pokud cleanup selze, DB s
prefixem `test_workflow_suite_` se musi odstranit rucne az po overeni jejiho
presneho nazvu v logu.

## Rollback etapy 13

Etapa nema databazovou migraci. Testovaci infrastrukturu lze vratit odstranenim
`test-workflow-db-suite.ts`, package scriptu, kontraktniho testu a tohoto
dokumentu; schema ani data se tim nemeni.

Samostatna runtime oprava v `warehouse-service.ts` zachovava `jobId` a
`billingDocumentId` na nove zapisovanem storno pohybu. Jeji rollback vrati pouze
tuto zmenu kodu. Jiz zapsane pohyby se pri rollbacku neupravuji ani nemazou;
vraceni opravy by pouze znovu zpusobilo, ze budouci storna nebudou videt v
historii filtrovane podle zakazky nebo dokladu.

## Stav overeni

- Dne 14. 7. 2026 probehl skutecny beh na lokalnim PostgreSQL 18.4.
- Runner vytvoril databazi `test_workflow_suite_*`, aplikoval 91/91 migraci a
  vsechny tri testovaci soubory prosly: 3/3 soubory, 6/6 scenaru.
- Overeno bylo atomicke zalozeni a rollback zakazky, zivotni cyklus spotreby
  materialu, prechody stavu zakazky a soubezna rezervace faktury z akce.
- Test odhalil, ze storno skladoveho pohybu ztracelo `jobId` a
  `billingDocumentId`. Reverzni pohyb nyni zachovava puvodni vazby a regresni
  scenar kontroluje oba pohyby v historii zakazky.
- Kombinovane kontrakty obou izolovanych runneru: 11/11 testu proslo.
- Typecheck celeho workspace po oprave prosel.
- Beh bez `WORKFLOW_DB_SUITE_ENABLED` skoncil ocekavane kodem 1.
- Beh s `NODE_ENV=production` skoncil ocekavane kodem 1 pred pripojenim.
- Vzdalena URL bez `ALLOW_REMOTE_ISOLATED_DB_TEST` skoncila ocekavane kodem 1
  pred DNS nebo databazovym pripojenim.
- Docasna databaze byla smazana i po neuspesnem mezibehu; zaverecna kontrola
  nenasla zadnou databazi s prefixem `test_workflow_`.

Lokalni DB brana je splnena na ciste databazi. Za staging overeni se nepovazuje:
neprobehl test s realnym staging API ani nad obnovenou anonymizovanou kopii
produkcnich dat.
