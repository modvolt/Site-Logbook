# R16-C2 – přihlášené externí účty a resource scopes

Datum: 2026-08-05

## Rozsah

R16-C2 připravuje samostatný typ přihlášeného externího účtu. Externí identita
není interní role `guest`: má vlastní `account_type = external`, nulový globální
permission set, právě jednoho aktivního interního custodiana, konečnou expiraci a
explicitní read-only scope na konkrétní zakázku, nabídku nebo rozvaděč.

Implementace je dark rollout. `EXTERNAL_ACCOUNTS_ENABLED` je ve všech příkladech
a compose kontraktech výchozí `false`. Nebyl proveden deployment, změna Coolify,
DNS, secrets, stagingu, produkce, databáze ani objektového úložiště. Expand-only
migrace `0105_smooth_nitro.sql` byla pouze připravena; nebyla aplikována. Migrace
`0100` není součástí této fáze.

## Bezpečnostní architektura

### Identita a přihlášení

- externí účet musí mít roli `guest`, nesmí mít `person_id` ani permission
  overrides a jeho efektivní globální oprávnění jsou vždy prázdná;
- session vznikne jen při přesném zapnutí feature flagu, aktivním profilu,
  budoucí expiraci a nezrušeném účtu;
- před finálním vydáním session se pod advisory lockem znovu ověří aktivita,
  `session_generation`, account type, profil, expirace a flag;
- změna scopes, expirace, custodiana, aktivace nebo revokace zvýší
  `session_generation` a odstraní indexované i legacy sessions;
- `/auth/me` označí externí identitu jako `network-only`; nevydá jí offline scope.

### Autorizační hranice

- centrální route policy je pro externí identity deny-by-default;
- existující permission routy jsou interní-only a `requirePermission` odmítne
  externí identitu i při podvrženém nebo zastaralém permission claimu;
- sdílené zůstávají pouze vlastní sessions a vlastní WebAuthn credentials;
- externí allowlist obsahuje jen `GET`/`HEAD` pro
  `/api/portal/resources` a `/api/portal/resources/:scopeId`;
- portal query aplikuje account, profil, stav, expiraci, scope, revokaci, čas a
  volitelný `scopeId` přímo v SQL `WHERE`; cizí detail vrací `404`;
- response model obsahuje pouze omezené základní údaje zakázky, nabídky nebo
  rozvaděče. Neobsahuje poznámky, ceny, storage cesty, exporty ani bearer tokeny.

### Browser a PWA

- externí identita je v `App.tsx` odkloněna do samostatného portálu před interním
  `Layout`;
- portál nespouští SSE, offline queue, identity cache ani interní navigaci;
- authenticated identity fetch podporuje bezpečný `network-only` režim bez
  offline scope, zatímco interní offline režim si původní scope zachovává;
- správa externích účtů je samostatná admin obrazovka chráněná oprávněním
  `users.manage`, Vault step-upem a idempotency key pro všechny mutace;
- runtime banner výslovně ukazuje vypnutý dark rollout a při vypnutém flagu
  neumožní aktivaci účtu.

## Datový model a databázové invarianty

Migrace `0105` přidává profily, typed scopes a immutable event ledger. Databázové
constrainty a triggery vynucují:

- externí profil odkazuje na externího uživatele a aktivního interního custodiana
  s efektivním `users.manage`;
- aktivní profil má konečnou budoucí expiraci a alespoň jeden právě platný scope;
- scope je read-only, má právě jeden target typu job/quote/switchboard a nesmí
  přežít expiraci účtu;
- scope identity je neměnná; změna expiry vytvoří náhradu a původní scope
  append-only zruší;
- event ledger nelze aktualizovat ani mazat; účty a scopes nelze fyzicky smazat;
- permission overrides externích účtů jsou odmítnuty;
- interní custodian nemůže být deaktivován, dokud má aktivní externí závislosti;
- guarded rollback se zastaví, pokud existuje externí identita nebo jakákoli
  data profilu, scope či eventu, a journal odstraňuje pouze přesný záznam `0105`.

## Lifecycle a custody

Admin API podporuje vytvoření neaktivního draftu, atomickou náhradu scopes,
kontrolu/prodloužení expirace, aktivaci, převod custodiana a terminální revokaci.
Aktivace vyžaduje zapnutý flag, platný scope a budoucí expiraci. Obecný `/users`
editor externí účty nezobrazuje ani nemění; používá se výhradně vyhrazený workflow.

Offboarding interního uživatele vypíše `custodiedExternalAccounts` a skončí `409`,
dokud nejsou externí účty převedeny nebo zrušeny. Generický offboarding externího
účtu je odmítnut, protože jeho bezpečnou terminální operací je dedicated revoke.

## Ověření

Lokální kontrola bez Dockeru a databáze:

- API unit/contract testy: 78 souborů, 574/574 testů – PASS;
- frontend testy: 13 souborů, 160/160 testů – PASS;
- root TypeScript (`typecheck:libs`, API, stavba, scripts) – PASS;
- root ESLint s nulovou tolerancí warnings – PASS;
- API produkční build – PASS;
- Vite/PWA produkční build s `BASE_PATH=/` – PASS;
- OpenAPI Orval codegen a library typecheck – PASS;
- route manifest: 430 rout – PASS;
- Impeccable statická kontrola nových UI souborů: 0 nálezů;
- `git diff --check` – PASS.

Izolovaný DB integrační test lokálně nebyl spuštěn, protože nebyla k dispozici
disposable testovací DB; žádná existující DB nebyla použita.

### GitHub exact-SHA

Draft PR [#14](https://github.com/modvolt/Site-Logbook/pull/14) míří z
`agent/phase16c2-external-accounts` do R16-C1 větve
`agent/phase16c-public-bearer-expand`.

První [Quality gate 30985236122](https://github.com/modvolt/Site-Logbook/actions/runs/30985236122)
na `4614642` našel starý interní permission fixture bez `accountType`; test-only
commit `32ea1c9` doplnil explicitní `internal` bez změny runtime ochrany. Druhý
[běh 30985869899](https://github.com/modvolt/Site-Logbook/actions/runs/30985869899)
prokázal všech 179 DB souborů i recovery kroky, ale R14 browser smoke odhalil, že
auth-aware PWA prompt zůstal mimo `AuthProvider` a React root se nevykreslil.
Commit `36524d0` přesunul prompt dovnitř provideru a přidal regresní kontrakt.

Na přesném implementačním SHA
`36524d076d592e9e91d0708f9a359f9ccea8af4a` prošel
[Quality gate 30986769934](https://github.com/modvolt/Site-Logbook/actions/runs/30986769934):

- quality/release a staging runtime/workflow kontrakty – PASS;
- migrace 105/105 včetně `0105` a všech 179 izolovaných API DB souborů – PASS;
- šifrovaný backup/restore a concurrency gate – PASS;
- encrypted streaming object recovery drill – PASS;
- všech pět R14 full-stack/fault scénářů včetně admin PWA/service workeru – PASS.

## Zbytkové hranice

- feature flag zůstává vypnutý a nebyl vytvořen žádný externí účet;
- exact-SHA CI prokázalo migrace, databázové invarianty, concurrency,
  backup/restore i full-stack gate; staging je nadále samostatně neschválený;
- staging musí nejprve aplikovat schema s flagem `false`, ověřit interní regresi a
  teprve samostatně zapnout flag pro jeden časově omezený pilotní účet;
- aktivní rollout potřebuje konkrétního interního custodiana, přesné resource ID,
  expiraci, monitorované auth/deny události a otestovaný revoke;
- tato fáze nepřidává tenant isolation ani obecný externí přístup k interním API;
- repo-level zelená brána není souhlas s merge, deployem ani aplikací migrace.
