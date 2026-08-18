# R11-D – fail-closed same-source warehouse reconciliation

Datum: 2026-08-11

Base: `4dd2dddb5641859fcc5c85ef6500fd4bf5dc1d3f`

Větev: `agent/r11-same-source-reconcile`

Stav: **lokálně implementováno a ověřeno; R11 jako celek zůstává NOT READY**

## Uzavřený řez

První načtení source ledgeru určí množinu warehouse item řádků, které lze bezpečně zamknout v numericky vzestupném pořadí. Po získání těchto locků se append-only source ledger načte znovu.

Pokud během čekání jiná transakce commitnula příspěvek stejného `(sourceType, sourceId)` na nový target mimo předem zamknutou množinu, aktuální transakce jej nezačne zamykat mimo pořadí a nepokračuje se starým snapshotem. Místo toho skončí HTTP konfliktem 409. Opakování v nové transakci objeví celý target set, zamkne jej ve správném pořadí, zruší předchozí target a ponechá právě jeden výsledný příspěvek.

Tento postup nepřidává globální advisory lock. Takový lock uvnitř primitive by mohl vytvořit nový cyklus s řádky source, které volající drží už před vstupem do reconciliace.

## Důkaz souběhu

Nový DB test drží první same-source přesun `A → B` před commitem. Druhá transakce načte ještě starý source snapshot pro `A → C` a prokazatelně čeká na item lock podle `pg_stat_activity`. Po commitu první transakce musí druhá:

1. uvidět nový nezamknutý target B;
2. rollbacknout s `statusCode = 409`;
3. po explicitním retry konvergovat na jediný source net `-30` na C;
4. obnovit A i B na 100 a ponechat C na 70;
5. zachovat cached quantity rovnou append-only ledger sum na všech třech kartách.

## Ověření

- přesně 106/106 migrací aplikováno pouze do disposable PostgreSQL 16;
- `warehouse-ledger.test.ts`: 12/12 PASS;
- PostgreSQL image byl digest-pinned, omezen na 1 CPU, 1 GiB RAM a 256 PID a po testu odstraněn;
- API TypeScript `--noEmit`: PASS;
- ESLint obou změněných TypeScript souborů: PASS;
- `git diff --check`: PASS; LF/CRLF hlášení jsou pouze Windows checkout warningy.

## Neuzavřené hranice

- Konflikt se záměrně neopakuje uvnitř již otevřené transakce; caller nebo uživatel musí zahájit nový pokus z čerstvého stavu.
- Vyšší transakce, která volá více různých source reconciliací a ponechává si item locky mezi voláními, stále nemá předem vypočtený globální source+item plán.
- R11 stále postrádá obecné row version/ETag, DB live billing claim, nonnegative-stock invariant s řízenou výjimkou a bounded migration/backfill plane.
- Nebyla přidána ani spuštěna migrace, nic nebylo pushnuto a produkce zůstala nedotčena.

## Checkpoint

R11-D uzavírá silent same-source/different-target stale-read cestu uvnitř jednoho reconcile primitive. Neprohlašuje celý warehouse concurrency model ani R11 za dokončený.
