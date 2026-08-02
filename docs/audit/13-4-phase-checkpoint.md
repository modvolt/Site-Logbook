# Checkpoint FÁZE 13.4 – úzké odstranění release blockerů

- **Datum:** 2026-08-02.
- **Stav práce fáze:** **COMPLETE** pro lokální implementaci a hermetickou verifikaci.
- **Release verdikt:** **code remediation PASS; staging authorization BLOCKED**.
- **Lokální commit opravy:** `250d0f343439ee617d86086f58965e998e955172`.
- **Větev:** `agent/phase13-4-remediation`, nepublikovaná.
- **Produkce/remote:** bez pushnutí, PR zápisu, workflow dispatch, stagingu, merge
  nebo produkčního přístupu.
- **Migrace 0100:** nebyla zařazena, změněna ani spuštěna.

## Uložené výstupy

- [verifikace oprav a přesný zbytkový gate](13-4-verification.md)
- [aktualizovaný public-token runbook](08-public-token-runbook.md)
- [výchozí nezávislé review](13-3-security-migration-review.md)
- [staging authorization gate](13-3-staging-authorization-gate.md)

## Shrnutí výsledku

Čtyři body z review fáze 13.3 byly lokálně opraveny:

1. upload vyžaduje jedno ze tří konkrétních efektivních write oprávnění a read-only
   guest končí `403` ještě před body/storage side effecty;
2. quality workflow cílí PostgreSQL 16;
3. legacy PPE tokeny mají secret-free read-only age preflight s fail-closed ochranou
   izolované DB;
4. neočekávané quote/storage chyby už nevracejí ani nelogují surové provider detaily.

Celý hermetický release gate prošel včetně 306 API, 127 frontend a 15 live-events
testů, všech typových kontrol a obou buildů. Cílené nové kontrakty prošly 26/26 a
celorepozitářový lint bez varování. Nebyl však spuštěn DB/migration gate na
PostgreSQL 16 ani remote workflow nového SHA, protože větev zůstala lokální a
nebyla udělena autorita k publikaci.

## Nejasnosti a nevyřešené otázky

- Jaké maximální stáří aktivního legacy PPE odkazu schválí service owner.
- Kdo provede nezávislý re-review commitu `250d0f3`.
- Zda a kdy má být lokální commit publikován do draft PR #1.
- Zda GitHub Environment `staging` existuje s požadovanou protection policy a kdo
  vlastní izolovanou DB/storage/mail infrastrukturu, RPO/RTO a rollback.
- Remote PostgreSQL 16 gate zatím nepotvrdil migrační sadu na přesném novém SHA.

## Jednoznačný checkpoint

FÁZE 13.4 zde končí. Lokální oprava a hermetická verifikace jsou dokončeny, ale
staging authorization zůstává **BLOCKED** do nezávislého re-review, publikace a
zeleného remote PostgreSQL 16 gate. Původní uživatelský dirty worktree nebyl
měněn; práce proběhla v samostatném remediation worktree.

Automaticky se nepokračuje. Další běh smí začít pouze po výslovném pokynu uživatele
„Pokračuj další fází“. Tento checkpoint nepovoluje push, změnu PR, workflow
dispatch, staging deploy, merge, produkční test ani aplikaci migrací.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.5 – nezávislé re-review lokální opravy a po samostatné
  autorizaci její selektivní publikace do draft PR, následovaná remote quality gate
  na PostgreSQL 16; bez staging deploye nebo merge;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** je nutné nezávisle ověřit společnou upload
  autorizační hranici, fail-closed preflight veřejných bearer tokenů a přesnou
  migrační kompatibilitu PostgreSQL 16, přičemž publikace nesmí přibrat cizí dirty
  změny ani vyloučenou migraci 0100;
- **očekávané činnosti:** porovnat commit `250d0f3` proti publikovanému headu
  `12d57c5`, provést nezávislé security review, získat výslovnou autorizaci k pushi,
  publikovat pouze remediation commit a checkpoint dokumentaci, sledovat remote
  quality workflow včetně DB/migration suites na PostgreSQL 16 a vrátit jednoznačný
  PASS/REQUESTED CHANGES verdikt; bez deploye;
- **soubory, které budou pravděpodobně změněny:** primárně `docs/audit/13-5-*` a
  GitHub PR/review metadata; produkční kód se změní jen při novém konkrétním review
  nálezu. Migrace 0100, journal a její rollback zůstávají mimo rozsah;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** nová migrace
  se nepředpokládá, ale remote CI spustí existující migrace 0096–0099 a 0101–0102
  na jednorázové PostgreSQL 16 službě a publikace změní vzdálenou PR větev. Jde o
  rizikový release krok vyžadující samostatnou autorizaci; staging/produkční
  migrace, merge a deploy zůstávají zakázané a migrace 0100 výslovně vyloučená.
