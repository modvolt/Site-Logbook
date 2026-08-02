# FÁZE 13.4 – verifikace úzkých release oprav

- **Datum:** 2026-08-02.
- **Lokální větev:** `agent/phase13-4-remediation`.
- **Opravený lokální commit:** `250d0f343439ee617d86086f58965e998e955172`.
- **Výchozí publikovaný PR head:** `12d57c512550a1a273947cbc742f577faddc5f72`.
- **Rozsah:** nálezy F13.3-01 až F13.3-04 z
  [nezávislého review fáze 13.3](13-3-security-migration-review.md).
- **Remote a produkce:** bez pushnutí, změny PR, workflow dispatch, staging deploye,
  merge, produkčního přístupu nebo aplikace migrací.
- **Migrace 0100:** v remediation worktree není přítomna a nebyla změněna.

## Výsledek oprav

### F13.3-01 – upload autorizační hranice

`POST /storage/uploads` už není pouze authenticated route. Centrální route policy
vyžaduje alespoň jedno efektivní claim oprávnění `jobs.work`, `activities.manage`
nebo `customers.manage`. Toto řešení zachovává legitimní per-user override pro
terénního uživatele a současně odmítá read-only guest i nesouvisející write
oprávnění. Kontrola proběhne v globálním middleware před načtením upload body a
před storage/ledger side effecty.

Kontrakt ověřuje:

- read-only kombinaci `jobs.view`, `activities.view`, `customers.view` → `403`;
- každé ze tří explicitních claim oprávnění → pokračování middlewarem;
- nesouvisející `billing.manage` → `403`;
- přesný výstup route policy včetně `anyOf`.

### F13.3-02 – cílový PostgreSQL major

GitHub quality workflow používá `postgres:16-alpine` místo PostgreSQL 18. Statický
kontrakt změnu uzamyká. Lokální hermetický gate databázi nepoužívá; skutečný běh
migračních a DB testů na PostgreSQL 16 proto musí proběhnout až na publikovaném
přesném SHA nebo na samostatně autorizované izolované DB.

### F13.3-03 – legacy PPE token cutover

Přibyl read-only příkaz `public-tokens:preflight`, který jedním agregovaným `SELECT`
změří aktivní legacy PPE signature/confirmation tokeny a jejich stáří. Nevypisuje
tokeny ani prefixy a nemění data. Fail-closed podmínky vyžadují:

- `NODE_ENV` jiné než `production`;
- `PUBLIC_TOKEN_PREFLIGHT_CONFIRM_ISOLATED=true`;
- přesnou shodu argumentu `--database` s názvem z `DATABASE_URL`;
- název DB obsahující staging/test/QA/sandbox/preview segment, ale ne
  prod/production/live segment;
- host mimo `modvoltapp.cz`;
- explicitní `--max-age-days` v rozsahu 1–3650.

Výsledek `BLOCK` používá exit code 2. Mezní stáří musí ještě schválit service owner;
skript ho záměrně neurčuje za něj. Runtime smoke test s fiktivní lokální URL a DB
`test-prod` skončil očekávaným odmítnutím před DB dotazem (exit code 1).

### F13.3-04 – redakce neočekávaných chyb

Veřejné quote routy už při neznámé chybě neposílají `err.message`; vracejí stabilní
fallback a kód `unexpected_error`. Upload endpoint neposílá provider code/message
klientovi a do ledgeru neukládá surový provider message. Log zachovává pouze
omezená diagnostická metadata (název/kód chyby, endpoint, region, HTTP status a
request ID), nikoli celý exception, message, access-key identifikátor nebo host ID.

## Provedené kontroly

| Kontrola | Výsledek |
| --- | --- |
| Cílené auth/token/redaction kontrakty | PASS; 4 soubory, 26/26 testů |
| Celý API unit/contract balík | PASS; 45 souborů, 306/306 testů |
| TypeScript knihovny + API | PASS |
| Route manifest | PASS; 402 unikátních rout, blob shodný s HEAD |
| ESLint celý checkout | PASS; 0 warnings |
| Fail-closed PPE preflight smoke | PASS; `test-prod` odmítnuto před query |
| Hermetický release gate | PASS |
| Hermetické guard/staging kontrakty | PASS; 16/16 |
| Frontend testy | PASS; 127/127 |
| Live-events testy | PASS; 15/15 |
| API build + frontend PWA build | PASS |
| PostgreSQL 16 DB/migration gate | NOT RUN; vyžaduje publikovaný CI head nebo autorizovanou izolovanou DB |
| Browser E2E | NOT RUN; změny jsou backend/workflow a E2E nebyl součástí schváleného rozsahu |
| Remote quality gate nového SHA | NOT RUN; lokální větev nebyla publikována |

Hermetický gate odfiltroval citlivé provider/DB proměnné a nastavil `NODE_ENV=test`.
Neproběhlo síťové publikování ani přístup k produkčním secretům. První manifest
check zachytil pouze CRLF/LF rozdíl pracovního souboru; po regeneraci byl pracovní
blob `400acbf80ee26e402e3153bc68a0efb324305b17` přesně shodný s HEAD a do commitu se
manifest nezařadil.

## Přesný diff lokální opravy

Commit mění 11 souborů:

- `.github/workflows/quality-gate.yml`;
- `artifacts/api-server/package.json`;
- `artifacts/api-server/src/lib/api-route-access-policy.ts`;
- `artifacts/api-server/src/routes/quotes.ts`;
- `artifacts/api-server/src/routes/storage.ts`;
- `artifacts/api-server/src/scripts/preflight-public-token-cutover.ts`;
- `artifacts/api-server/test/api-route-access-policy.contract.test.ts`;
- `artifacts/api-server/test/api-permission-middleware.contract.test.ts`;
- `artifacts/api-server/test/public-access-token.contract.test.ts`;
- `artifacts/api-server/test/release-security-remediation.contract.test.ts`;
- `docs/audit/08-public-token-runbook.md`.

Nezměnil se route manifest, DB schema, journal, forward migrace ani rollback.

## Zbývající release podmínky

Lokální oprava odstraňuje code-level blockery, ale sama neautorizuje staging:

1. commit musí projít nezávislým security re-review;
2. po samostatné autorizaci lze větev publikovat na draft PR;
3. přesný publikovaný SHA musí projít remote quality gate s PostgreSQL 16;
4. service owner musí stanovit maximální přípustné stáří legacy PPE tokenu;
5. stále chybí doložený staging owner, izolované handly a dual-control release
   evidence popsané ve [staging authorization gate](13-3-staging-authorization-gate.md).

Do splnění těchto bodů zůstává staging authorization **BLOCKED**. Produkce a
migrace 0100 zůstávají mimo rozsah.
