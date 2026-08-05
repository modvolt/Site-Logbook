# FÁZE R16-A – checkpoint

- **Datum:** 2026-08-05
- **Stav:** REPO-LEVEL R16-A DOKONČENA; EXACT-SHA QUALITY GATE PROŠEL
- **Větev:** `agent/phase16a-offboarding-cutoff`
- **Základ:** `2671e5376f7471ed3f6104bdbdfd50f7bc9eab87`
- **Draft PR:** [#11](https://github.com/modvolt/Site-Logbook/pull/11), stacked na
  `agent/phase15e-staging-workflow-validation`
- **Implementační commit:** `9637623507083e16b6cc89b08d2d6a1fc0a3e06a`
- **CI opravný commit:** `1d8ccd09f119d6db76d2b4726bd8ed91d6035a6d`
- **GitHub CI:** [Quality gate 30967957139](https://github.com/modvolt/Site-Logbook/actions/runs/30967957139),
  PASS na přesném SHA `1d8ccd09f119d6db76d2b4726bd8ed91d6035a6d`
- **Staging/produkce:** beze změny; nic nebylo sloučeno ani nasazeno
- **Migrace:** žádná nová migrace ani aplikace migrace; `0103` zůstává nenasazena
  a `0100` nezařazena

## Uložené výstupy a architektura

- [centrální verifikační registr](16-a-offboarding-cutoff-verification.md);
- nový backendový offboarding preview a potvrzovací kontrakt s oprávněním
  `users.manage`, čerstvým step-up ověřením, povinným `Idempotency-Key` a CAS
  kontrolou username/session generation;
- atomický cutoff v jedné PostgreSQL transakci: účet se deaktivuje, heslo se
  zneplatní, session generation se zvýší a sessions, WebAuthn credentialy,
  permission overrides a legacy security questions se zruší spolu s jediným
  redigovaným auditem;
- login a cutoff sdílejí per-user advisory lock; alternativní správcovské cesty
  znovu ověřují efektivní oprávnění aktéra uvnitř transakce;
- historická osoba, provozní záznamy a přiřazení zůstávají zachovány; preview
  vrací pouze počty závazků k předání;
- resource-bound zákaznické `public_access_tokens` se záměrně neruší podle
  autora. Vlastník, přesný resource scope, read-only výchozí režim, expirace a
  revokace těchto externích grantů patří do R16-B.

## Kontroly

- cílené offboarding/account-lifecycle/route-access/auth-session kontrakty:
  28/28 PASS;
- TypeScript, cílený ESLint, codegen, route manifest a `git diff --check`: PASS;
- exact-SHA GitHub Quality gate: PASS za 9 min 59 s;
- všech 156 izolovaných API databázových souborů: PASS;
- šifrovaný backup restore, streaming object recovery a R14 full-stack/fault
  gate: PASS;
- původní neúspěšný běh odhalil jediný zastaralý forenzní test, který očekával
  `400`; úzká oprava nyní ověřuje záměrný `409` a kód
  `self_permission_lockout_forbidden`;
- jediná CI anotace je obecné upozornění na Node 20 u GitHub Actions; nejde o
  selhání aplikace ani R16-A kontraktu.

## Jednoznačný checkpoint

R16-A je dokončena na úrovni repozitáře a draft PR. Bezpečnostní cutoff byl
ověřen hermetickým quality gate, ale nebyl sloučen ani nasazen. Tento checkpoint
neautorizuje merge, `workflow_dispatch`, GHCR publikaci, staging/produkční deploy,
Coolify, DNS/TLS/secrets, práci s produkční databází ani migraci. R15-E2 zůstává
externě NO-GO. Práce se zde zastavuje a R16-B nezačíná automaticky.

## Nejasnosti a zbytková rizika

- generovaný React klient předává povinný `Idempotency-Key` přes
  `RequestInit.headers`, nikoli jako samostatný typovaný argument; stabilní klíč
  pro jeden UI pokus patří do R16-C;
- sdílený login/offboarding lock je ověřen kontraktem, DB scénářem a stale-session
  odmítnutím, ale deterministická PostgreSQL bariéra pro přesné pořadí
  login-versus-cutoff zůstává P2 test-hardening bodem;
- R16-B musí určit datový a migrační model externích grantů bez přerušení již
  probíhajících zákaznických podpisů, OOPP potvrzení a nabídek;
- není rozhodnuto, zda se existující granty při migraci doplní bezpečným pevným
  TTL, individuální expirací, nebo explicitní legacy výjimkou; rozhodnutí musí
  vycházet z inventáře skutečných typů a spotřebitelů tokenů;
- posledního správce nelze bezpečně odpojit bez zachování alespoň jednoho dalšího
  efektivního `users.manage`; invariant je v cutoff službě, ale administrátorský
  handover průvodce vznikne až v R16-C.

## Doporučení pro další spuštění

- **další fáze:** R16-B – vlastněné, resource-scoped a expirovatelné externí
  granty;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** fáze mění autorizační a tokenový datový model,
  vyžaduje migrační kompatibilitu se živými zákaznickými workflow a pečlivé
  řešení revokace, expirace, souběhu a auditních hranic;
- **očekávané činnosti:** inventarizovat všechny producenty a spotřebitele
  externích tokenů, navrhnout vlastníka a přesný resource scope, zavést read-only
  výchozí režim, expiraci a revokaci, připravit zpětně kompatibilní migraci a
  rollback, doplnit OpenAPI/DB/HTTP/security testy a na začátku přidat
  deterministický login-versus-cutoff barrier test;
- **soubory, které budou pravděpodobně změněny:** `lib/db/src/schema/public-access-tokens.ts`,
  navazující soubor v `lib/db/migrations/`, API routes/services pro podpisy, OOPP
  a nabídky, OpenAPI kontrakt a generované klienty, izolované DB/HTTP testy a
  auditní dokumentace;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** ano; může
  přidat novou databázovou migraci a mění bezpečnostní model bearer grantů.
  Migrace se smí nejprve pouze připravit a hermeticky ověřit; staging ani produkce
  nejsou bez nového výslovného schválení autorizovány.
