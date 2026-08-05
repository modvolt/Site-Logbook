# Checkpoint R16-C2 – přihlášené externí účty

Datum: 2026-08-05

## Stav checkpointu

**R16-C2 je dokončena na úrovni lokálního repozitáře.** Exact-SHA GitHub CI a
odkaz na draft PR budou doplněny po bezpečném zveřejnění větve.

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

- API unit/contract: 573/573 – PASS;
- frontend: 160/160 – PASS;
- TypeScript, ESLint, API build, Vite/PWA build, OpenAPI codegen, route manifest a
  `diff --check` – PASS;
- statická UX/přístupnost kontrola nových obrazovek – 0 nálezů;
- lokální DB migrace úmyslně nebyla spuštěna bez disposable DB;
- exact-SHA CI: čeká na zveřejnění větve.

## Nejasnosti a zbytková rizika

- izolovaný CI musí ještě prokázat všech 105 migrací a nový DB integrační test;
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
