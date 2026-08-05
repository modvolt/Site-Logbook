# R16-A – ověření atomického odpojení uživatelského přístupu

## Rozsah

R16-A zavádí backendový bezpečnostní základ pro jedinou potvrzenou akci, která
odpojí interní účet. Nezavádí administrátorský průvodce, transfer přiřazení,
dočasné externí grants, resource scope ani expiraci; ty patří do R16-B/R16-C.
Nevznikla databázová migrace a nebyla změněna produkce, staging, Coolify, DNS,
secrets ani objektové úložiště.

## Nový kontrakt

- `GET /api/users/{id}/offboarding-preview` vrací aktuální generaci session,
  přístupové artefakty určené k odvolání a počty provozních závazků k předání;
- `POST /api/users/{id}/offboard` vyžaduje `users.manage`, čerstvý password nebo
  WebAuthn step-up, `Idempotency-Key`, přesné tělo bez dalších klíčů, očekávané
  username a očekávanou generaci session;
- důvod je uzavřený enum, ne volný text; potvrzení musí být přesně
  `offboard_user`;
- stale preview, opakovaný request s jiným stavem, vlastní offboarding a již
  neaktivní účet končí konfliktem bez částečného zápisu.

## Atomický cutoff

V jedné databázové transakci se po globálním advisory locku a novém ověření
oprávnění aktéra:

1. zamkne cílový účet `FOR UPDATE`;
2. ověří username, aktivní stav a session generation;
3. nastaví `is_active=false`;
4. nahradí password hash hashem náhodné, nikde neuložené hodnoty;
5. zvýší session generation právě o jedna;
6. smaže normalizované i legacy JSON sessions;
7. smaže WebAuthn credentials, permission overrides a vysloužilé security
   questions;
8. vloží jediný redigovaný audit `user.access.offboarded` ve stejné transakci.

Obecný audit middleware tento exact route vynechává, takže nevznikne druhá
best-effort událost mimo transakci.

## Uzavřené souběhy a alternativní cesty

- nahrazení permission overrides zamyká cílový účet, odmítá neaktivní target a
  znovu v transakci ověřuje efektivní `users.manage` aktéra;
- dokončení WebAuthn registrace po kryptografickém ověření znovu zamyká účet a
  kontroluje `is_active` i session generation před insertem credentialu;
- password i WebAuthn login sdílejí s offboardingem per-user advisory lock;
  session-store zápis proto buď skončí před cutoffem a je následně smazán, nebo
  po commitu znovu ověří neaktivní/generačně změněný účet a login odmítne;
- vytvoření uživatele, bulk session revoke a cross-user správa WebAuthn
  credentialů znovu v transakci ověřují efektivní `users.manage` aktéra;
- běžný `PATCH /users/{id}` již neumí deaktivovat ani reaktivovat účet; heslový
  reset zůstává atomický se session generation a session deletion;
- hard delete uživatelského účtu je vyřazen a vrací
  `user_deletion_retired`, aby nezničil auditní a historické vazby;
- hromadné ukončení sessions zamyká účet a po offboardingu již nezvyšuje jeho
  generaci podruhé;
- self-offboarding, self role lockout a self permission lockout zůstávají
  fail-closed. Sdílený management lock brání vzájemnému souběžnému odpojení
  posledních správců.

Již autorizovaný request, který začal před commitem, může svou doménovou
transakci dokončit. Invariant R16-A je: po commitu se žádný nový chráněný request
cílového účtu neautentizuje. Otevřený SSE stream nese pouze invalidation témata,
nikoli doménová data; nepovažuje se za přístupový credential.

## Co se záměrně zachovává

- řádek `users`, vazba na `people` a historická atribuce;
- zakázky, dodatečná přiřazení, návštěvy, stroje, vydané OOPP, rozvaděče,
  odpovědné závady a work sessions;
- `user_preferences` a idempotency ledger;
- zákaznické `public_access_tokens` pro podpis, potvrzení OOPP a nabídky.

Poslední položka je resource-bound zákaznický grant vytvořený uživatelem, ne
osobní bearer přístup zaměstnance. Automatické zrušení podle
`created_by_user_id` by rozbilo probíhající zákaznické workflow. Vlastník,
resource scope a expirace externích grants jsou samostatný migrační úkol R16-B.

## Handover inventář

Preview a audit vracejí pouze počty, ne citlivý obsah:

- aktivní primární a dodatečné zakázky;
- plánované job/activity visits;
- přiřazené stroje a vydané OOPP;
- přiřazení k nearchivovaným rozvaděčům a neuzavřené odpovědné závady;
- aktivní work sessions.

R16-A nic z toho automaticky nepřevádí. Administrátor dostává přesný seznam
závazků; výběr nástupce a atomický transfer patří do další části.

## Ověření

Lokální, bez Dockeru a bez připojení k produkční databázi:

- API/OpenAPI codegen a route manifest: PASS;
- API server TypeScript a cílený ESLint: PASS;
- offboarding, account lifecycle, route-access a auth-session kontrakty: 28/28
  PASS;
- `git diff --check`: PASS.

Izolovaný PostgreSQL test je zařazen do auth DB suite pro GitHub CI. Dokazuje
normalizovanou i legacy session, credentialy, overrides, otázky, změnu hesla,
generation +1, jednoho vítěze souběhu, jediný audit, zachování customer tokenu a
devíti kategorií historie/handover. Obnovená stale session musí být odmítnuta a
staré heslo nesmí fungovat. Lokální Docker se kvůli stabilitě počítače
nespouštěl.

## Zbývající hranice R16

- R16-B: datový model vlastněných externích grants, resource scope, read-only
  default, expirace a revokace; tato část může vyžadovat migraci;
- R16-C: administrátorský preview/confirm/transfer průvodce se stabilním
  `Idempotency-Key` pro jeden pokus a bezpečný reactivation flow s novým heslem;
- browser identity header dnes znamená, že mutace se scoped hlavičkou vyžaduje
  explicitní idempotency key; generovaný React client jej přijímá přes
  `RequestInit.headers`, nikoli samostatný argument;
- společný login/offboarding lock je ověřen statickým kontraktem a výsledným
  stale-session scénářem, ale deterministická PostgreSQL bariéra pro přesné
  pořadí login-versus-cutoff zůstává P2 test-hardening bodem;
- R15-E2 staging aktivace zůstává externě NO-GO a není tímto checkpointem
  nahrazena ani autorizována.

## Exact-SHA GitHub quality gate

- první běh na implementačním SHA `9637623507083e16b6cc89b08d2d6a1fc0a3e06a`
  odhalil jediný zastaralý před-R16-A regresní test: self permission lockout už
  správně vracel konfliktní `409`, zatímco test očekával původní `400`;
- opravný commit `1d8ccd09f119d6db76d2b4726bd8ed91d6035a6d` nemění produkční
  logiku a zpřesňuje test také na kód `self_permission_lockout_forbidden`;
- [Quality gate 30967957139](https://github.com/modvolt/Site-Logbook/actions/runs/30967957139)
  na přesném opravném SHA prošel: quality/release gate, všech 156 izolovaných API
  DB souborů, encrypted restore/recovery a R14 full-stack/fault gate jsou PASS;
- obecná GitHub Actions anotace o přechodu actions z Node 20 na Node 24 není
  aplikační selhání ani otevřený R16-A bezpečnostní nález.
