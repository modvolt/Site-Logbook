# FÁZE 13.5A – re-review lokální remediation větve

- **Datum:** 2026-08-02.
- **Reviewovaný commit:** `250d0f343439ee617d86086f58965e998e955172`.
- **Lokální dokumentační head před tímto checkpointem:**
  `e79bda6fa2bb3d0352328d34bfe537be33b908b0`.
- **Výchozí vzdálený PR head:**
  `12d57c512550a1a273947cbc742f577faddc5f72`.
- **Rozsah:** čerstvý druhý průchod nálezů F13.3-01 až F13.3-04, GitHub metadata,
  publikovatelnost a cílené lokální kontrakty.
- **Verdikt:** **REQUESTED CHANGES; publikace a staging BLOCKED**.
- **Remote/produkce:** bez pushnutí, změny PR, workflow dispatch, deploye, merge,
  produkčního přístupu nebo aplikace migrací.
- **Migrace 0100:** v remediation tree není přítomna a nebyla změněna.

## Aktuální GitHub důkaz

GitHub connector 2026-08-02 potvrdil:

- draft PR [modvolt/Site-Logbook#1](https://github.com/modvolt/Site-Logbook/pull/1)
  je otevřený, nemergeovaný a mergeable;
- head je stále `agent/phase13-staging-gate` na `12d57c5`;
- poslední PR workflow run `30754695026` je `completed/success`;
- submitted reviews: 0;
- review threads: 0;
- PR komentáře: 0;
- vzdálená větev `agent/phase13-4-remediation` neexistuje.

Read-only `gh api` vrátil `main` na `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`
a PR větev na `12d57c512550a1a273947cbc742f577faddc5f72`. Současně však
`gh auth status` označil výchozí token účtu `modvolt` za neplatný a samostatný
read-only SSH probe skončil `Permission denied (publickey)`. Publikace proto není
autorizovaná ani technicky připravená; žádný push nebyl proveden.

## Centrální registr re-review

| ID | Závažnost | Stav | Výsledek a důkaz | Podmínka uzavření |
| --- | --- | --- | --- | --- |
| F13.5-01 | Low | **REQUESTED CHANGES** | F13.3-04 je uzavřeno jen částečně. `quotes.ts:73` a `storage.ts:217-220` vracejí generickou chybu, ale bez aplikačního `requestId`. Neznámá quote chyba se v route handleru ani nezaloguje; finish ring buffer uchová jen status/route, nikoli redigovaný detail. Globální error handler již na `app.ts:204-260` správný korelační vzor má, ale zpracované route chyby se k němu nedostanou. Statický test kontroluje generický text a absenci provider message, nikoli korelaci a interní redigovaný log. | Přidat aplikační `requestId` do obou neočekávaných odpovědí a redigovaný interní log s týmž ID; u quote chyby zalogovat jen bezpečnou třídu/kód nebo ji bezpečně delegovat globálnímu handleru. Rozšířit kontrakt o korelaci a zákaz raw message/credential polí. |
| F13.3-01 | Medium | **CODE PASS** | Přímí konzumenti `/storage/uploads` jsou pouze job, activity a customer-site attachment workflow. `anyOf` přesně odpovídá `jobs.work`, `activities.manage`, `customers.manage`. Billing a switchboard nahrávají přes vlastní permission-routy. Downstream claim je owner-bound a další module/parent policy zůstává fail-closed. | Po opravě F13.5-01 znovu zachovat negativní guest kontrakt; remote/staging role smoke je stále povinný. |
| F13.3-02 | Medium | **LOCAL CODE PASS / REMOTE PENDING** | Workflow používá `postgres:16-alpine`, shodně s `scripts/migrate-test-isolated.sh` a PostgreSQL 16 API image. | Nový přesný publikovaný SHA musí projít celý remote DB/migration/rollback gate na PostgreSQL 16. |
| F13.3-03 | Medium | **CODE PASS / OWNER PENDING** | Preflight má jediný parametrizovaný agregovaný `SELECT`, žádný mutační SQL, nevypisuje tokeny/prefixy a fail-closed vyžaduje izolovaný název, exact DB argument, neprodukční režim a explicitní potvrzení. | Service owner stanoví `--max-age-days` a preflight proběhne na anonymizované obnovené kopii; nevyhovující tokeny se před rolloutem revokují nebo znovu vydají. |
| F13.3-04 | Low | **PARTIAL** | Raw `Error.message`, provider message a `AWSAccessKeyId` byly z klientské odpovědi/upload logu odstraněny. Chybí korelační ID a quote interní log dle původní podmínky uzavření. | Uzavře F13.5-01. |
| F13.3-07 | Medium | **BLOCKED** | PR stále nemá nezávislý review ani doložené staging Environment handly/ownery. | Nezávislé schválení a úplný staging authorization gate. |

Nebyl nalezen nový High nebo Critical problém v remediation diffu. F13.5-01
neobnovuje informační únik, ale brání označit původní redaction finding za úplně
uzavřený a zhoršuje spolehlivé dohledání incidentu bez zveřejnění interního detailu.

## Kontroly této podfáze

| Kontrola | Výsledek |
| --- | --- |
| GitHub PR metadata, reviews, threads a komentáře | PASS; aktuálně načteno read-only |
| Remote referenční SHA přes read-only API | PASS; `main=a25c312`, PR head `12d57c5` |
| SSH/CLI publish readiness | FAIL; invalid `gh` token a `Permission denied (publickey)` |
| Cílené security kontrakty | PASS; 4 soubory, 26/26 testů |
| TypeScript libraries + API | PASS mimo sandbox; sandbox nemohl číst pnpm junction package metadata |
| Route manifest | PASS; 402 unikátních registrací aktuálních |
| `git diff --check` a čistota review větve před dokumentací | PASS |
| PostgreSQL 16 remote DB gate nového SHA | NOT RUN; commit není publikovaný |
| Browser E2E / staging smoke | NOT RUN; bez staging autorizace |

Celý hermetický gate nebyl v této podfázi opakován; prošel na stejném code commitu
v checkpointu 13.4. Tato podfáze zopakovala cílené bezpečnostní kontrakty, typy a
manifest. Žádný výsledek není vydáván za staging nebo produkční důkaz.

## Rozhodnutí

Lokální commit `250d0f3` se zatím nesmí publikovat. Nejprve je nutná úzká schválená
oprava F13.5-01 a její verifikace. Poté musí být obnoven funkční GitHub write
transport a uživatel musí samostatně povolit push přesného přezkoumaného SHA.
