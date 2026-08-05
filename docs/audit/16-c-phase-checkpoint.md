# Checkpoint R16-C1 – veřejný fragment/Bearer transport

Datum: 2026-08-05

## Stav checkpointu

**R16-C1 je dokončena na úrovni repozitáře a exact-SHA GitHub CI.** Implementace
je v draft PR [#13](https://github.com/modvolt/Site-Logbook/pull/13), stacked
proti R16-B. Ověřený implementační head je
`c7151cb31dfee4aec329ac464e73febf37e18470`; GitHub
[Quality gate 30980066883](https://github.com/modvolt/Site-Logbook/actions/runs/30980066883)
skončil úspěšně.

Tento checkpoint není schválení merge, deploye ani migrace. Produkce, staging,
Coolify, DNS, secrets, S3 a databáze zůstaly beze změny. Migrace `0103` a `0104`
nebyly aplikovány a `0100` není součástí R16-C1.

## Uložené výstupy

- centrální registr architektury, ověření a rollout podmínek:
  [16-c-public-bearer-verification.md](16-c-public-bearer-verification.md);
- kanonické tokenless API s přísným Bearer parserem a legacy adaptéry;
- fragment bootstrap, module-memory credential a účelově omezený public fetch;
- service-worker/cache isolation a bezpečné blob načítání QR dokumentů;
- centrální pre-parser rate limiter a public route policy;
- fail-closed trusted-proxy a WebAuthn origin kontrakty;
- staging proxy preflight, OpenAPI, generované kontrakty, route manifest a testy.

## Shrnutí architektury

- Nové producer URL drží token pouze ve fragmentu; browser jej po zachycení
  okamžitě odstraní a API jej dostává pouze v Bearer hlavičce.
- Grant existuje jen v paměti, je vázán na přesný purpose/routu a při navigaci se
  zahodí. Druhý grant ve stejném tabu vynutí čistý reload.
- Veřejný fetch je same-origin, no-store, bez cookies a refereru; nepřijme query,
  redirect ani legacy API URL.
- Missing/malformed credential vrací `401` Bearer challenge, ambiguity `400`;
  token se neodráží do odpovědi ani běžných logů.
- Service worker veřejné grant API necachuje. Fyzické legacy QR a již odeslané
  odkazy zůstávají dočasně kompatibilní.
- Rate limit běží před body parserem a důvěryhodná klientská IP vzniká pouze přes
  explicitní proxy CIDR. WebAuthn produkční origin bere pouze z `PUBLIC_APP_URL`.

## Kontroly

- lokální release gate: 35 script kontraktů, 160 frontend, 15 live-events a 539
  API testů plus API/PWA build: PASS;
- lokální lint, TypeScript, E2E TypeScript, OpenAPI, manifest 420 rout,
  staging-proxy preflight a `diff --check`: PASS;
- exact-SHA GitHub CI: 174/174 izolovaných API DB souborů, šifrovaný
  backup/restore, concurrency, streaming recovery a R14 full-stack/fault gate:
  PASS na `c7151cb`;
- první CI běh odhalil pouze pět zastaralých očekávání `400`; test-only oprava je
  zpřesnila na správný `401` + Bearer challenge bez změny runtime logiky.

## Nejasnosti a zbytková rizika

- před stagingem chybí přesná živá CIDR proxy a důkaz sanitizace forwarded
  hlaviček, neexistence ingress bypassu a správné Secure cookie;
- outer Coolify/Traefik access/error logy zatím nemají real-browser důkaz, že v
  novém workflow neobsahují raw token nebo Authorization;
- legacy tokenové routy nelze odstranit bez inventury a případného přetisku
  fyzických QR;
- přihlášené externí účty stále nemají bezpečný account type, resource scopes,
  expiraci, custodiana a offboarding transfer;
- současná role `guest` nesmí být použita jako náhrada tohoto modelu;
- žádný merge, deployment ani aplikace migrace není tímto checkpointem
  autorizována.

## Doporučení pro další spuštění

* další fáze: R16-C2 – deny-by-default přihlášené externí účty a resource scopes za výchozím vypnutým feature flagem;
* doporučený model: GPT-5.6 Sol;
* doporučený reasoning: xhigh;
* důvod použití této úrovně: fáze mění autentizační a autorizační datový model, musí omezovat každý request i list query na konkrétní resource, řešit expiraci, custody, souběh s offboardingem a bezpečnou expand migraci;
* očekávané činnosti: navrhnout samostatný external account type, resource-scope tabulku a deny-by-default middleware, zavést expiraci a revokaci na každém requestu, interního custodiana a atomický transfer/disable při offboardingu, stabilní idempotency pro handover UI, admin inventář, negativní autorizační matici, DB/concurrency testy a dark rollout kontrakt; feature flag musí zůstat vypnutý;
* soubory, které budou pravděpodobně změněny: uživatelské/account schema, nová navazující migrace pravděpodobně `0105`, auth/session a route-access middleware, offboarding service, admin API a UI, OpenAPI a generované klienty, izolované DB/HTTP/security testy a auditní dokumentace;
* zda další fáze může obsahovat migrace nebo jiné rizikové změny: ano – pravděpodobná je expand-only migrace `0105` a změna auth hranice; migrace se smí pouze připravit a hermeticky ověřit, nesmí se aplikovat na staging ani produkci bez samostatného výslovného schválení; `0100` zůstává vyloučená.

## Stop

R16-C1 zde končí. R16-C2 se v tomto spuštění automaticky nezahajuje.
