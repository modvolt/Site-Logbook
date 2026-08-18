# FÁZE 13.6 – post-publish review a staging readiness

- **Datum:** 2026-08-02.
- **Rozsah:** read-only kontrola GitHub PR/CI/governance a lokální audit staging
  kontraktu, migrací a PPE cutoveru.
- **Publikovaný kandidát:** `55d7fc7adab648f60fee260bd5dadae47b84b364`.
- **Draft PR:** [modvolt/Site-Logbook#1](https://github.com/modvolt/Site-Logbook/pull/1).
- **Remote Quality gate:** [run 30762394256](https://github.com/modvolt/Site-Logbook/actions/runs/30762394256),
  `completed/success` na přesném publikovaném SHA.
- **Celkový verdikt:** **NO-GO / STAGING DISPATCH BLOCKED**.
- **Vzdálené změny:** žádné; nebyl proveden push, změna PR, workflow dispatch,
  vytvoření Environment, staging, merge ani deploy.
- **Migrace 0100:** nepřítomná a nedotčená.

## Centrální registr zjištění

| ID | Stav | Zjištění | Dopad / uzavření |
| --- | --- | --- | --- |
| F13.6-01 | PASS | Draft PR zůstal otevřený, nemergeovaný a na přesném SHA `55d7fc7`; remote quality gate je zelený. | Kandidát je technicky publikovaný a CI-stabilní, nikoli schválený pro staging. |
| F13.6-02 | BLOCK | PR má 0 reviews, 0 review threads, 0 komentářů a 0 requested reviewers. `main` nemá classic branch protection, repozitář nemá ruleset a jediný přímý collaborator je autor/owner `modvolt`. | Nelze doložit nezávislé lidské review ani dual control. Je nutné přidat nebo určit druhého člověka s přístupem a získat jeho approval bez blocking vláken. |
| F13.6-03 | BLOCK | Autorizované GitHub API vrátilo 0 Environments; `staging` neexistuje. Neexistují ani repository-level Actions secret/variable names. | Nelze chránit ani bezpečně spustit job s `environment: staging`. Environment a jeho protection reviewer musí vzniknout až po samostatné autorizaci. |
| F13.6-04 | PASS | Workflow a guard přesně vyžadují tři variables, dva dedikované secrets, dva ruční boolean vstupy, externí HTTPS origin a plný SHA. 11/11 kontraktních testů a staging E2E typecheck prošly. | Statický kontrakt je připravený. Neprokazuje existenci ani izolaci skutečného targetu. |
| F13.6-05 | BLOCK | Nejsou doloženi service owner, staging owner, operator, nezávislý reviewer ani rollback approver. Nejsou doloženy izolované DB/storage/mail identity, anonymizovaný recovery point, RPO/RTO nebo cleanup. | Povinné části B–D autorizačního gate zůstávají nesplněné. |
| F13.6-06 | PASS / LIMITED | Journal má 102 položek a končí `0096`, `0097`, `0098`, `0099`, `0101`, `0102`; `0100` není v journalu ani tracked files. Remote PostgreSQL 16 gate pro tento commit prošel. | Pořadí zdrojů je konzistentní, ale není tím nahrazen preflight nad anonymizovanou obnovenou staging kopií ani měření locků/backfillu. |
| F13.6-07 | BLOCK | PPE preflight vyžaduje explicitní `--max-age-days` v rozsahu 1–3650 a nemá default. Service-owner politika ani agregovaný výsledek z izolované kopie neexistují. | Nesmí se odhadnout limit ani provést token cleanup. Owner musí rozhodnout limit; `BLOCK` vyžaduje revokaci nebo bezpečné znovuvydání a opakování preflightu. |
| F13.6-08 | RISK | Migrace 0096 přidá `session_generation = 1`; staré session hodnotu nemají a nový middleware je fail-closed zruší při dalším požadavku. | Budoucí deploy celé větve pravděpodobně jednorázově odhlásí stávající uživatele včetně admina. Login a heslo nemění. |
| F13.6-09 | BLOCK | V repozitáři jsou jen `quality-gate.yml` a ruční `staging-smoke.yml`. Smoke workflow nic nenasazuje a vyžaduje již nasazený build s `/api/healthz.version` rovným exact SHA. | Chybí doložený externí staging target i autorizovaný způsob nasazení přesného SHA. Smoke nelze spustit jako náhradu deploye nebo izolace. |

## Živý GitHub stav

Ověření bylo provedeno autentizovaně pod repository ownerem; hodnoty tokenů ani
secretů nebyly čteny nebo vypsány.

- PR je `open`, `draft=true`, `merged=false`, `mergeable=true`;
- head větev je `agent/phase13-staging-gate`, head SHA `55d7fc7`;
- base je `main` na `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`;
- PR obsahuje 52 commitů a GitHub vykazuje 287 změněných souborů;
- reviews, review threads, comments, requested users i requested teams jsou prázdné;
- `GET branches/main/protection` vrátil `404 Branch not protected`;
- repository rulesets jsou prázdné;
- jediný přímý collaborator je `modvolt` s admin oprávněním;
- environments endpoint vrátil `total_count=0`; dotazy na `staging`, jeho secrets a
  variables vrátily 404;
- repository Actions secret names i variable names jsou prázdné.

Repozitář tedy momentálně nemá technickou ani personální hranici, která by splnila
nezávislé review a staging dual control. Codex ani autor změn nemohou nahradit druhého
lidského reviewera.

## Přesný staging kontrakt

GitHub Environment musí nést pouze názvy a hodnoty určené pro oddělený staging:

| Typ | Název | Povinná podmínka |
| --- | --- | --- |
| variable | `STAGING_BASE_URL` | čistý externí HTTPS origin; ne produkce, subdoména `modvoltapp.cz`, localhost, URL credentials, path, query ani fragment |
| variable | `STAGING_ENVIRONMENT_ID` | obsahuje samostatný segment `stage`, `staging`, `test`, `qa`, `sandbox` nebo `preview` |
| variable | `STAGING_MAIL_SANDBOX_CONFIRMED` | přesně `true` až po doložení skutečně uzavřeného mail sandboxu |
| secret | `STAGING_ADMIN_USERNAME` | dedikovaná staging identita s `diagnostics.view`; nesdílet s produkcí |
| secret | `STAGING_ADMIN_PASSWORD` | unikátní staging heslo nejméně 16 znaků; nesdílet s produkcí |

Dispatch dále vyžaduje ručně potvrdit `confirm_isolated_target=true` a
`confirm_deep_storage_probe=true`. `STAGING_EXPECTED_BUILD_SHA` bere workflow z
`github.sha`; nasazené `/api/healthz.version` mu musí přesně odpovídat. Samotná dvě
potvrzení jsou pouze lidské deklarace a nenahrazují důkaz izolace DB, storage a mailu.

## Migrace, PPE a rollback hranice

Ověřené journal pořadí je:

`0096 → 0097 → 0098 → 0099 → 0101 → 0102`

`0100_user_ui_preferences` zůstává záměrně vynechaná. Před jakýmkoli staging
nasazením je stále nutné na nové izolované PostgreSQL 16 DB:

1. inventarizovat řádky, velikosti a odhad locku pro 0096–0102;
2. spustit PPE age preflight pouze read-only nad anonymizovanou obnovenou kopií s
   ownerem schváleným `--max-age-days`;
3. změřit 0102 backfill a lock proti schválenému maintenance budgetu;
4. ověřit forward, parity, cílené DB testy a jen povolené guardované rollback cykly;
5. zachovat roll-forward návrat, jakmile 0096 generation pokročila, 0099 obsahuje
   encrypted-only data, 0101 obsahuje nový/revokovaný/spotřebovaný token nebo 0102
   obsahuje immutable evidence/bound token.

Žádný rollback guard se nesmí obcházet ručním mazáním migrační evidence. Produkční
DB, env secrets ani veřejné tokeny nebyly v této fázi čteny nebo měněny.

## Provedené kontroly

- živé ověření PR, exact head SHA a remote quality runu;
- živé ověření reviews, threads, comments a requested reviewers;
- živé ověření classic branch protection, rulesets a direct collaborators;
- živé ověření Environments a pouze názvů Actions secrets/variables;
- parse `lib/db/migrations/meta/_journal.json`: 102 položek, očekávaný tail,
  `HAS_0100=False`;
- `git ls-files` kontrola: 0 tracked cest s migrací 0100;
- `node --test scripts/test/staging-release-guard.test.mjs scripts/test/staging-release-evidence.test.mjs`:
  11/11 PASS;
- `tsc -p e2e/tsconfig.staging.json`: PASS.

Přímé `pnpm test:staging-contract` nebylo použito jako výsledný důkaz, protože lokální
pnpm wrapper se bez TTY pokusil obnovit `node_modules` a failnul s
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. Stejné skripty proto byly spuštěny
přímo existujícím bundlovaným Node runtime bez reinstalace závislostí.

## Nevyřešené otázky

1. Kdo bude nezávislý lidský reviewer odlišný od autora/operatora a jak získá přístup?
2. Kdo jsou service owner, staging owner, operator a rollback approver?
3. Jaký přesný limit `--max-age-days` service owner schvaluje pro aktivní legacy PPE
   odkazy a jaký je agregační výsledek na anonymizované kopii?
4. Kde bude fyzicky izolovaný staging target, PostgreSQL 16 DB, object storage a
   mail sandbox; jak je doložena nemožnost zápisu do produkce?
5. Jaký explicitně autorizovaný mechanismus nasadí `55d7fc7` do stagingu a nastaví
   `BUILD_SHA` i `VITE_BUILD_SHA` na plný SHA?
6. Jaké jsou schválené RPO/RTO, maintenance budget, retention, cleanup a cost owner?

Dokud není každá otázka uzavřena evidencí a není udělen samostatný souhlas s přesným
staging krokem, platí **NO-GO**.
