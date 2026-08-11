# R13-D9QV – izolovaná zkouška exact 0105→0106 core gate

Datum: 2026-08-11

Stav: **CORE GATE REHEARSAL READY / NENÍ ROLLOUT READY / aktivní produkční kód, Git index, remote ani produkce nezměněny**

## Rozsah

Tento checkpoint navazuje na R13-D9QU a v disposable worktree ověřuje samostatnou databázovou a API bránu pro druhý release krok `0105_smooth_nitro -> 0106_graceful_frog_thor`. Existující gate `0104 -> 0105` nebyla rozšířena na dvě migrace a zůstává fail-closed na přesném počtu 105.

Schválený business kontrakt zůstává:

- `early_discard` má omezenou retenci a `reviewed_rejection` immutable evidenci;
- lidsky čitelný důvod patří pouze do omezeného immutable archivu;
- měna je explicitní ISO kód bez implicitního FX přepočtu.

## Implementovaný disposable core

Nový DB kontrakt `accounting-schema-preflight.ts`:

- připíná přesných 106 journal položek, hash migrace 0106 a řetěz snapshotů 0105→0106;
- klasifikuje pouze přesný stav 105 jako `READY_0105` a přesný stav 106 jako `ALREADY_0106`;
- před migrací vyžaduje úplnou absenci devíti účetních evidence tabulek a jejich objektů;
- po migraci vyžaduje přesně 9 tabulek, 5 funkcí, 13 aktivních triggerů, 31 indexů a 116 validovaných constraints;
- transition post-check vyžaduje všech devět účetních tabulek prázdných, steady-state gate pozdější legitimní řádky dovoluje;
- ve stejném repeatable-read snapshotu znovu ověřuje exact-0105 external-account schema, dark feature flag, nulový external state, databázovou identitu a aktuální restore-tested encrypted backup;
- sdílí stejný PostgreSQL advisory migration lock jako normální migrátor.

API image dostala dva samostatné build entrypointy:

- `accounting-schema-gate.mjs` pro explicitně potvrzený transition krok;
- `accounting-schema-steady-state.mjs` pro read-only ověření po aktivaci.

## Nálezy z reálného PostgreSQL 16

První DB integrace odhalila, že PostgreSQL zkracuje identifikátory na 63 bajtů. To se týkalo jak nových 0106 objektů, tak dvou již existujících external-account FK. Očekávaný objektový inventář proto používá přesnou PostgreSQL normalizaci a má regresní test pro oba dlouhé FK názvy. Nejde o změnu migrace ani databázových objektů, ale o opravu ověřovače skutečně vytvořeného schématu.

První pokus s limitem 1 GiB ukončil spojení během aplikace celého journalu. Kontejner byl odstraněn a nebyl použit jako důkaz. Jediný opakovaný sekvenční běh s limitem 1 CPU, 1,5 GiB RAM/swap a 256 PID prošel; kontejner byl po testu odstraněn.

## Vykonané důkazy

- DB unit kontrakty: 31/31 PASS;
- API gate contract: 4/4 PASS;
- disposable PostgreSQL 16: 106/106 migrací aplikováno;
- integrační sekvence: exact post-0106 → guarded empty rollback → exact pre-0105 → inventory `READY_0105` → právě jedna migrace → exact post-0106 → steady-state PASS;
- DB a API TypeScript typecheck PASS;
- API build PASS včetně obou nových entrypointů a pino runtime workerů;
- Prettier a ESLint nad D9QV scope PASS;
- unstaged `git diff --check` PASS.

`git diff --cached --check` nad neměněným D9QT baseline nadále hlásí záměrné Markdown hard-break dvojmezery v dříve staged auditních dokumentech. Nejde o D9QV regresi a kvůli zachování přesného D9QT indexu nebyly přepisovány.

## Přesná identita

Původní D9QT combined tree zůstal základem:

- D9QT tree: `9a8581bf1e65b230a5f31493c5241de61fdc5487`;
- hlavní disposable index SHA-256 před i po fingerprintu: `7e8d3bab20c219e944f522e3f0c795da0d4bd92fa9a094e8c1e33a36289d21ad`.

Jednorázový alternativní index vytvořil pro D9QT+0106 core gate:

- tree: `5f73408ec2b02828364dfa4afa54527eb5e5240b`;
- stable patch ID vůči D9QT tree: `e312077adf2e2ce8ce751732bbe90711da05b882`;
- 32 cest, 22 090 vložených a 156 odstraněných řádků;
- 15 přímo gate/migration souvisejících cest.

Hash evidence:

- migrace 0106: `697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd`;
- rollback 0106: `281853c600cd0a92dd6713bdc4e64cfa143f767c501770b8e8bc6503cda2fab3`;
- snapshot 0106: `32e6cca10d51d73ebd7262a896e55390e823c286e71853e4aa13c8842ae4ab24`;
- journal po přidání 0106: `d59722d0bc23fb0f3fd13f960f83f585a1b32c6e9c1c4efb6468e1de5d535100`;
- DB core gate: `9bb6d9b67a43fa5a7db5753d8f2bdf221ce9e55ee3a13cb53d6cb7eb8fb6fbfa`;
- API transition gate: `e9d4690206b520bd0fb142ee8b998a65f506c3c16f5617269eb51ae972072a36`;
- API steady-state gate: `7312fe08a9b4fd845eff7aadc8b19921afd852d8c5ba8b4bcd1a47a4c4f04715`.

Alternativní index byl odstraněn. Nevznikl commit ani ref.

## Zbývající hranice

Core gate ještě není provozní rollout cesta. Před druhým releasem 0106 chybí samostatně ověřit a implementovat:

1. resolved Compose target a live Postgres identity binding pro 0106 one-shot service;
2. host runner s pre/post/finally kontrolami stejného kontejneru;
3. canonical input, execution a release-evidence artefakty včetně checksumů;
4. aktivní runbook a exact source/image/provisioning vazby;
5. nový exact-head CI a samostatné schválení druhého release kroku.

## Bezpečnostní checkpoint

- Do aktivního worktree byl přidán pouze tento auditní dokument.
- Nebyl proveden commit, push, private repin/merge, workflow dispatch, GHCR/S3 zápis, deploy ani produkční migrace.
- `0100` zůstává vyloučena.
- Exact D9QT přenos bez 0106 a pozdější zařazení 0106 zůstávají dvě oddělené approval boundary.
- Nejbližší aktivní změna produkčního stromu nadále vyžaduje výslovné schválení uživatele.
