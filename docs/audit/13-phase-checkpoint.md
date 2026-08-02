# Checkpoint FÁZE 13 – staging aktivační balíček

- **Datum:** 2026-08-02.
- **Výchozí commit:** `667f202`.
- **Stav fáze:** lokální aktivační/evidence balíček dokončen; skutečná externí
  staging aktivace je **BLOCKED** kvůli chybějícím staging handlům a autorizaci.
- **Produkce:** nedotčena; bez přístupu k `modvoltapp.cz`, produkční DB, storage,
  mailu, secrets, deploye nebo migrací.
- **Remote:** nedotčen; žádný push, pull request ani workflow dispatch.
- **Produkční kód:** beze změny; změny jsou pouze testovací/provozní skripty,
  dedikované staging E2E, CI workflow reference, package scripts a dokumentace.
- **Migrace/data:** žádná nová migrace ani backfill; nebyla změněna žádná externí
  DB, session, bucket ani testovací fixture.

## Výstupy

- [centrální evidence a stavová matice](13-verification.md)
- [externí staging activation runbook](13-staging-activation-runbook.md)
- [fail-closed evidence template](13-staging-evidence.template.json)
- `scripts/staging-release-guard.cjs` – odmítá produkční/lokální/HTTP target,
  neúplná potvrzení, krátký SHA a slabou staging identitu; neloguje secret hodnoty
- `scripts/check-staging-release-evidence.mjs` – svazuje jeden commit s CI,
  deployem, migracemi, recovery, PWA/mail/alert výsledky, RPO/RTO a dual control
- `.github/workflows/staging-smoke.yml` – pouze ruční non-deploy smoke přes GitHub
  Environment `staging`
- `e2e/playwright.staging.config.ts` + `e2e/staging/*` – oddělená API, deep-health,
  PWA, desktop a mobile sada bez localhost fallbacku a bez `admin/admin`

## Bezpečnostní vlastnosti

- žádný implicitní target a žádný produkční hostname;
- plný health SHA musí být totožný s testovaným workflow SHA;
- storage write/delete sonda vyžaduje vlastní potvrzení;
- mail musí být potvrzen jako sandbox;
- auth state zůstává v ignorovaném `e2e/test-results/`, trace/video/screenshot jsou
  vypnuté a publikovaný bootstrap artifact neobsahuje username ani password;
- evidence odmítá sensitive keys, credential URL, stale run, neúplné objekty,
  migration drift, překročené RPO/RTO a self-approval;
- workflow samo nenasazuje a nemá produkční credentials ani write permission k
  repozitáři.

## Výsledek kontrol

- staging/evidence unit kontrakty: 11/11 PASS;
- spolu s existujícím safe-test-env guardem: 16/16 PASS;
- workspace i staging TypeScript: PASS;
- frontend 127/127 a live-events 15/15 PASS;
- API 295/296; jediný fail je zachovaný cizí field-navigation literal contract,
  relevantní zbytek 290/290 PASS;
- API a frontend/PWA build: PASS;
- celý workspace ESLint, phase Prettier, JSON/YAML parse a diff check: PASS;
- Playwright discovery: 5/5 nalezených scénářů ve 3 projektech, bez sítě;
- chybějící staging environment: očekávaný fail-closed exit 1;
- externí browser, mail, recovery a remote workflow: neprovedeny, BLOCKED.

## Jednoznačný checkpoint

FÁZE 13 v tomto spuštění končí lokálním, bezpečně ověřeným aktivačním balíčkem a
**BLOCKED externím checkpointem**. Není dovoleno interpretovat jej jako proběhlý
staging restore, zelený remote CI ani produkční release readiness. Automaticky se
nepokračuje. Pro pokračování musí uživatel nejprve dodat/odsouhlasit staging
handly a zvlášť autorizovat publikaci přesně zkontrolovaného commit rozsahu.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.1 – autorizovaný externí staging execution a uzavření
  všech `BLOCKED` řádků evidence matice;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** běh propojí vzdálené CI/deploy, provider IAM a
  immutable retention, anonymizovaný společný DB + object restore, browser/PWA,
  mail/alert delivery, měření RPO/RTO a dvoučlenné schválení s ostrými abort
  hranicemi;
- **očekávané činnosti:** schválit konkrétní staging URL/identity/DB/storage/mail,
  oddělit publikovatelný commit rozsah, autorizovaně jej publikovat, nasadit přesný
  SHA do stagingu, spustit manual workflow, recovery game day, business/mail/alert
  scénáře, vyplnit evidence JSON a dosáhnout `decision: PASS`;
- **soubory, které budou pravděpodobně změněny:** primárně žádný produkční kód;
  GitHub Environment values/secrets mimo repo, externí evidence JSON/run artefakty
  a případně úzké opravy `e2e/staging/*`, `.github/workflows/staging-smoke.yml` či
  runbooku podle skutečného provideru;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano, pouze v
  výslovně autorizovaném izolovaném stagingu může deploy aplikovat již existující
  migrace, vytvořit/mazat staging fixtures a buckety nebo zapnout nevratnou
  immutable retenci. Produkční migrace, backfill, secret rotace, deploy či zásah do
  `modvoltapp.cz` zůstávají zakázané bez nového samostatného souhlasu.
