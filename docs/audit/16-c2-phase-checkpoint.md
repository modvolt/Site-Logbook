# Checkpoint R16-C2 – přihlášené externí účty

Datum: 2026-08-05

## Stav checkpointu

**R16-C2 je dokončena na úrovni repozitáře a exact-SHA GitHub CI.** Implementace
je v draft PR [#14](https://github.com/modvolt/Site-Logbook/pull/14), stacked
proti R16-C1. Ověřený implementační head je
`36524d076d592e9e91d0708f9a359f9ccea8af4a`; GitHub
[Quality gate 30986769934](https://github.com/modvolt/Site-Logbook/actions/runs/30986769934)
skončil úspěšně.

Tento checkpoint není schválení merge, deploye ani migrace. Produkce, staging,
Coolify, DNS, secrets, S3 a databáze zůstaly beze změny. Expand-only migrace
`0105` nebyla aplikována a `0100` není součástí R16-C2. Feature flag zůstává
výchozí `false`.

## Uložené výstupy

- centrální registr architektury a ověření:
  [16-c2-external-accounts-verification.md](16-c2-external-accounts-verification.md);
- rollout a rollback postup:
  [16-c2-external-accounts-runbook.md](16-c2-external-accounts-runbook.md);
- expand-only schema `0105`, guarded rollback a izolovaný DB test;
- deny-by-default auth/session/route policy a permission ceiling;
- dedicated custody lifecycle, admin API a offboarding blokátor;
- oddělený network-only externí portál a dark admin UI;
- OpenAPI, generované klienty, route manifest a regresní testy.

## Shrnutí architektury

- `external` je samostatný account type, nikoli interní role nebo permission
  override; globální permission set je vždy prázdný.
- Každý externí účet má aktivního interního custodiana, konečnou expiraci a
  explicitní read-only job/quote/switchboard scope.
- Platnost profilu, expiry, scope a revokace se ověřuje při loginu, session
  issuance i resource query. Entitlement změny invalidují všechny sessions.
- Externí routy jsou deny-by-default; allowlist tvoří pouze dvě read-only portal
  routy a několik vlastních security operací.
- Externí frontend je oddělen před interním Layoutem a je network-only bez SSE,
  offline queue a interní navigace.
- Lifecycle mutace vyžadují `users.manage`, Vault step-up a idempotency key.
- Offboarding custodiana se zastaví, dokud nejsou závislé účty převedeny nebo
  revokovány; DB trigger stejné pravidlo vynucuje fail-safe.

## Kontroly

- API unit/contract: 574/574 – PASS;
- frontend: 160/160 – PASS;
- TypeScript, ESLint, API build, Vite/PWA build, OpenAPI codegen, route manifest a
  `diff --check` – PASS;
- statická UX/přístupnost kontrola nových obrazovek – 0 nálezů;
- lokální DB migrace úmyslně nebyla spuštěna bez disposable DB;
- exact-SHA CI: migrace 105/105, 179 izolovaných API DB souborů, šifrovaný
  backup/restore, concurrency, streaming recovery a R14 full-stack/fault gate –
  PASS na `36524d0`;
- první CI běh odhalil starý test fixture bez interního `accountType`; druhý běh
  odhalil auth-aware PWA prompt mimo `AuthProvider`. Obě závady byly úzce
  opraveny a třetí celý běh je zelený.

## Nejasnosti a zbytková rizika

- exact-SHA CI prokázalo všech 105 migrací a nový DB integrační test; živý
  staging rollout zatím proveden nebyl;
- staging dark rollout vyžaduje samostatné schválení migrace `0105`, deploye a
  případné změny feature flagu;
- před pilotem chybí konkrétní custodian, resource ID, expirace a akceptovaný
  redigovaný allow/deny/revoke důkaz;
- guarded rollback je možný jen před vznikem prvních externích dat; později je
  bezpečným návratem vypnutí flagu a append-only revokace;
- žádný merge, deployment ani aplikace migrace není tímto checkpointem
  autorizována.

## Doporučení pro další spuštění

* další fáze: R16-C3 – exact-SHA izolovaná DB brána a samostatně schválený staging dark rollout s feature flagem stále `false`; zapnutí jednoho pilotního účtu až jako oddělený krok po přijetí důkazů;
* doporučený model: GPT-5.6 Sol;
* doporučený reasoning: xhigh;
* důvod použití této úrovně: fáze může aplikovat migraci `0105`, mění runtime auth hranici a musí bezpečně rozlišit schema rollout, code rollout, flag activation, session invalidaci a rollback po prvním externím záznamu;
* očekávané činnosti: ověřit exact-SHA CI včetně DB/restore/concurrency gate, zkontrolovat staging journal a zálohu, nasadit schema a kód s flagem `false`, provést interní regresi a dark admin smoke, připravit redigovaný pilotní allow/deny/revoke důkaz; produkci ani flag nezapínat bez nového výslovného schválení;
* soubory, které budou pravděpodobně změněny: pouze staging evidence/checkpoint dokumentace a případné úzké CI/test opravy; runtime kód jen pokud izolovaná brána odhalí konkrétní závadu;
* zda další fáze může obsahovat migrace nebo jiné rizikové změny: ano – může obsahovat aplikaci připravené `0105` na staging a restart služby; jde o rizikovou auth/databázovou změnu vyžadující zálohu, přesný journal, samostatné schválení a stop podmínky. `0100` zůstává vyloučená a produkce mimo rozsah.

## Stop

R16-C2 zde končí. R16-C3 se v tomto spuštění automaticky nezahajuje.
