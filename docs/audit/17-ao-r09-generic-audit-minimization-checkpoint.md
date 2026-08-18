# R09-C – minimalizace generic audit telemetry

Datum: 2026-08-11

Base: `0cf40ffbdfd72d758c45b7beb67e84573f6b5675`

Větev: `agent/r09-generic-audit-minimization`

Stav: **lokálně implementováno a cíleně ověřeno; R09 jako celek zůstává NOT READY**

## Uzavřený řez

`auditMutations` už neserializuje request body do `audit_log.summary`. Generic best-effort řádek obsahuje pouze HTTP metodu a bearer-redigovanou cestu.

Tím se odstraňuje otevřený denylistový únik: neznámý název pole, jiná velikost písmen, vnořený objekt ani budoucí doménové pole se přes tento middleware do summary nedostane. Cesty, které zapisují vlastní bohatší transakční audit, zůstávají ze generic middleware vynechané a jejich kontrakt se tímto řezem nemění.

## Ověření

- cílený Vitest kontrakt: `24/24 PASS`;
- API TypeScript `--noEmit`: PASS po sestavení deklarací sdílených knihoven;
- ESLint změněných TypeScript souborů: PASS;
- Prettier změněných souborů: PASS;
- `git diff --check`: PASS; Windows LF/CRLF hlášení jsou checkout warningy.

Instalace závislostí proběhla pouze offline z místní pnpm cache. Nebyl použit Docker, síťová služba, databáze ani produkční secret.

## Neuzavřené hranice

- Generic `audit_log` se stále zapisuje až po `res.finish` jako best-effort a není atomický s doménovou změnou.
- `audit_log` zůstává mutable legacy telemetry bez canonical envelope, pořadí, hash chainu a důkazního exportu.
- Tento řez nevytváří autoritativní before/after, reason, AI/import provenance ani server-owned vault disclosure event.
- R09-A/B kontrakty stále čekají na expand-only DB schema, transakční adapter, dual-write, export worker a offline verifier.
- Nebyla přidána ani spuštěna migrace; `0100` zůstává vyloučena.

## Checkpoint

R09-C uzavírá pouze minimalizaci generic request telemetry. Nesmí být interpretována jako dokončení durable auditu nebo jako důkaz úplnosti historického `audit_log`. Další bezpečný R09 celek je transakční DB wiring canonical eventu, chain headu a export outboxu v samostatné expand-only migrační hranici.
