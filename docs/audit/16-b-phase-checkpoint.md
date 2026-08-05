# Checkpoint R16-B – vlastněné externí granty

Datum: 2026-08-05

## Stav checkpointu

**R16-B je dokončena na úrovni repozitáře a exact-SHA CI.** Implementace je v
draft PR [#12](https://github.com/modvolt/Site-Logbook/pull/12), stacked proti
R16-A. Ověřený implementační head je
`ea94a6f78bdae546283f3bd5a3a3393418ea3025`; GitHub
[Quality gate 30974066898](https://github.com/modvolt/Site-Logbook/actions/runs/30974066898)
skončil úspěšně.

Tento checkpoint není schválení merge, deploye ani migrace. Produkce, staging,
Coolify, DNS, secrets, objektové úložiště i databáze zůstaly beze změny. Migrace
`0103` a `0104` nebyly aplikovány. Migrace `0100` není součástí R16-B.

## Uložené výstupy

- centrální registr architektury, invariantů a release gate:
  `docs/audit/16-b-external-grants-verification.md`;
- expand migrace `lib/db/migrations/0104_thin_sheva_callister.sql`, snapshot,
  journal a rollback guard;
- read-only consume-action preflight a dry-run ownership backfill nástroje;
- OpenAPI kontrakt, generované Zod/React klienty a manifest 411 rout;
- administrátorský inventář a revoke/deactivate API;
- DB, contract, migration, concurrency a redaction testy.

## Shrnutí architektury

- Veřejné workflow granty jsou hash-only, explicitně vlastněné organizací a
  oddělují vlastníka od provenance vydavatele.
- Issue, revoke a consume používají společnou grant-family serializaci,
  revalidaci aktivního vydavatele a deterministické pořadí zámků.
- OOPP potvrzení a podpis jsou dvě konfliktní varianty jedné rodiny a používají
  immutable snapshot, artifact binding a append-only důkazní událost.
- Podpis zakázky je vázán na document version; archivace grant atomicky ruší.
- Nabídka je vázána na quote version a bearer nikdy nepřežije její `validUntil`.
- QR rozvaděče jsou resource-owned, finite-lived a mají samostatnou per-board
  serializaci; legacy NULL owner/expiry je pouze dočasná expand výjimka.
- Admin API nevrací token hash ani ciphertext. Logovací vrstvy redigují bearer
  cesty, secrets, podpisová data a raw User-Agent.

## Ověření

- lokální workspace/API TypeScript, codegen, Drizzle check a build: PASS;
- lokální release gate: 35 script contracts, 130 frontend, 15 live-events a
  463 API unit/contract testů: PASS;
- lokální quality gate, secret scan, `diff --check` a `0100` guard: PASS;
- GitHub: 168/168 izolovaných API DB souborů, backup/restore concurrency,
  streaming recovery a R14 full-stack fault gate: PASS na `ea94a6f`.

Lokální Docker nebyl spuštěn; databázové a recovery důkazy vznikly na izolovaném
GitHub runneru, aby se zachovala stabilita pracovního počítače.

## Nejasnosti a zbytková rizika

- Browser history a vnější Coolify/Traefik access/error logy zatím nejsou
  prokazatelně bez raw legacy tokenových URL.
- Přihlášené externí účty zatím nemají samostatný deny-by-default account type,
  resource scopes, custodiana, expiraci a transfer při offboardingu.
- Legacy fyzické QR s NULL owner/expiry musí před contract release projít
  inventurou, backfillem a případně řízeným přetiskem.
- Public podpisové a rozhodovací POST routy potřebují centrální rate limiter
  před body parserem.
- Single-organization model neobsahuje `organization_id`; nejde o tenant
  isolation.
- GitHub upozorňuje na Node 20 deprecation v použitých Actions v4. Běh byl
  úspěšný na vynuceném Node 24, ale workflow dependencies bude vhodné později
  aktualizovat samostatně.

## Doporučení pro další spuštění

* další fáze: R16-C – dvourelease fragment/header transport veřejných bearerů a deny-by-default externí účty;
* doporučený model: GPT-5.6 Sol;
* doporučený reasoning: xhigh;
* důvod použití této úrovně: změna zasahuje autentizační hranici, browser/PWA a service-worker kompatibilitu, resource scopes, custody/transfer i souběh s offboardingem;
* očekávané činnosti: Release A compatibility expand pro canonical token-free routy, fragment bootstrap a `Authorization` API, no-store/service-worker pravidla, centrální rate limit, resource-scoped externí účty a staging/log E2E; změna producentů odkazů až v samostatném Release B po inventuře;
* soubory, které budou pravděpodobně změněny: veřejné API routy a auth parser/policy, frontend veřejných stránek, identity fetch a service worker, OpenAPI a generované klienty, testy a auditní dokumentace; DB schema a nová migrace jen pokud budou zavedeny externí účty a scopes;
* zda další fáze může obsahovat migrace nebo jiné rizikové změny: ano – může obsahovat auth a databázovou migraci; žádný deploy ani aplikace migrace bez samostatného schválení.

## Stop

R16-B zde končí. R16-C se v tomto spuštění automaticky nezahajuje.
