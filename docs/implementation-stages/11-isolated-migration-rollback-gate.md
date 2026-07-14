# Etapa 11: Izolovana migracni a rollback brana

## Ucel

Etapa doplnuje spustitelny integracni test pro migrace 0086-0090. Test nikdy
nemigruje databazi uvedenou v `DATABASE_URL`. Na stejnem izolovanem PostgreSQL
serveru vytvori novou databazi s prefixem `test_workflow_rollback_`, vsechny
operace provede uvnitr ni a v bloku `finally` ji odstrani.

## Co test prokazuje

1. Na prazdnou docasnou databazi lze aplikovat cely migracni retezec.
2. Sloupce a tabulka etap 1-9 po forward migraci skutecne existuji.
3. Read-only preflight na ciste databazi vraci nulove blockery.
4. DOWN skripty lze spustit pouze v poradi 0090, 0089, 0088, 0087, 0086.
5. Po DOWN retezci jsou nove sloupce, tabulka i pet zaznamu journalu pryc.
6. Opetovny forward aplikuje presne pet migraci a obnovi schema i journal.
7. Dalsi migracni beh je idempotentni a neaplikuje nic.

Test nenahrazuje zkousku nad obnovenou anonymizovanou zalohou. Prazdna databaze
neobsahuje provozni blockery ani vsechny kombinace historickych dat.

## Bezpecnostni pojistky

- Bez `WORKFLOW_ROLLBACK_TEST_ENABLED=true` se skript okamzite ukonci.
- Pri `NODE_ENV=production` se vzdy ukonci.
- Vzdaleny server vyzaduje navic `ALLOW_REMOTE_ISOLATED_DB_TEST=true`.
- Zdrojovy nazev databaze z `DATABASE_URL` se nepouzije pro migraci ani DOWN.
- Jmeno docasne databaze generuje skript a nelze je dodat zvenku.
- Cleanup ukoncuje pouze spojeni do teto vygenerovane databaze.
- Vnejsi `finally` obaluje uz vytvoreni databaze, takze pokus o cleanup probehne
  i pri chybe zavirani vytvareciho spojeni.
- Produkcni API ani objektove uloziste se nevola.

## Spusteni na lokalnim PostgreSQL

```powershell
$env:NODE_ENV = "test"
$env:WORKFLOW_ROLLBACK_TEST_ENABLED = "true"
$env:DATABASE_URL = "postgresql://uzivatel:heslo@localhost:5432/test_admin"
pnpm --filter @workspace/db run test:workflow-rollback
```

Ucet musi mit opravneni `CREATE DATABASE` a `DROP DATABASE`. Databaze
`test_admin` se nemeni; URL slouzi jen jako zdroj hostitele a prihlaseni.

## Spusteni na vzdalenem izolovanem serveru

Vzdaleny server musi byt urceny vyhradne pro test nebo staging. Nepouzivat
produkcni cluster ani produkcni prihlasovaci udaje.

```powershell
$env:NODE_ENV = "test"
$env:WORKFLOW_ROLLBACK_TEST_ENABLED = "true"
$env:ALLOW_REMOTE_ISOLATED_DB_TEST = "true"
$env:DATABASE_URL = "postgresql://uzivatel:heslo@staging-db:5432/test_admin"
pnpm --filter @workspace/db run test:workflow-rollback
```

## Ocekavany vystup

Uspech konci radkem `Forward/DOWN/forward cycle passed` a potvrzenim o smazani
docasne databaze. Jakakoli chyba vraci nenulovy exit code. Pred dalsim pokusem
je nutne overit, zda cleanup vytisteny v logu probehl.

## Rollback etapy 11

Etapa nema databazovou migraci a pri beznem behu aplikace nic nespousti.
Aplikacni rollback znamena odstranit skript `test-workflow-rollback.ts`, prikaz
`test:workflow-rollback` a odpovidajici kontraktni test. Produkcni schema ani
data se tim nemeni.

## Stav lokalniho overeni

- Dne 14. 7. 2026 probehl skutecny test na lokalnim PostgreSQL 18.4.
- Runner vytvoril pouze databazi `test_workflow_rollback_*`, aplikoval vsech
  91 migraci, provedl DOWN 0090-0086 a nasledny forward 0086-0090.
- Opakovany forward byl idempotentni a docasna databaze byla po testu smazana.
- Kontraktni test runneru a migracniho retezce: 7/7 testu proslo.
- Typecheck celeho workspace prosel.
- Beh bez `WORKFLOW_ROLLBACK_TEST_ENABLED` skoncil ocekavane kodem 1.
- Beh s `NODE_ENV=production` skoncil ocekavane kodem 1 pred pripojenim.
- Vzdalena URL bez `ALLOW_REMOTE_ISOLATED_DB_TEST` skoncila ocekavane kodem 1
  pred DNS nebo databazovym pripojenim.
- Kontrola po behu nenasla zadnou databazi s prefixem `test_workflow_`.

Brana je splnena pro prazdnou lokalni databazi. Stale nenahrazuje zkousku nad
obnovenou anonymizovanou zalohou, kde se mohou objevit blockery historickych
dat.
