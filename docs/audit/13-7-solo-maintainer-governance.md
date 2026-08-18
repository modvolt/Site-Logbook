# FÁZE 13.7 – solo-maintainer governance a typovaná PPE policy

- **Datum:** 2026-08-02.
- **Publikovaný SHA:** `88cbc461a0838c9c90de818a4c9ac2a1ed90b80f`.
- **Draft PR:** [modvolt/Site-Logbook#1](https://github.com/modvolt/Site-Logbook/pull/1).
- **Remote Quality gate:** [run 30764192158](https://github.com/modvolt/Site-Logbook/actions/runs/30764192158),
  `completed/success` na přesném publikovaném SHA.
- **Verdikt:** **GOVERNANCE BOOTSTRAP PASS / STAGING DEPLOY BLOCKED**.
- **Main/produkce:** `main` zůstal na `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`;
  žádný merge, staging deploy, produkční deploy, DB přístup nebo aplikace migrací.
- **Migrace 0100:** nepřítomná a nedotčená.

## Rozhodnutí vlastníka

Uživatel v návaznosti na FÁZI 13.6 rozhodl:

1. projekt nemá druhého programujícího PR reviewera a technické posouzení deleguje
   na Codex;
2. staging má být rozvinut autonomně, ale odděleně od produkce;
3. PPE maximální stáří musí být nastavitelné podle typu odkazu;
4. jednorázové odhlášení existujících techniků a admina při budoucím přechodu na
   `session_generation` je přijatelné; login ani heslo se nemění.

Codex není evidován jako nezávislý lidský reviewer. Místo nepravdivého dual-control
PASS je zaveden explicitní `solo_maintainer` režim s owner waiverem a automatickými
kompenzačními kontrolami.

## Typovaná PPE preflight policy

Read-only public-token preflight nyní vyžaduje oba typy právě jednou:

```text
--max-age-days=ppe_signature:<1..3650>
--max-age-days=ppe_confirmation:<1..3650>
```

Parser odmítne:

- původní netypovaný tvar `--max-age-days=<číslo>`;
- chybějící typ;
- duplicitní typ a pořadím závislé přepsání;
- neznámý typ;
- desetinnou, nulovou, zápornou nebo vyšší než 3650 hodnotu.

SQL používá limit každého typu jen pro jeho agregovanou age podmínku. Preflight dál
obsahuje jediný parametrizovaný read-only `SELECT`, nevypisuje token ani prefix a při
překročení kteréhokoli limitu vrátí `decision: BLOCK` a exit code 2. Konkrétní dvě
hodnoty nejsou v kódu ani dokumentaci předvolené; musí je service owner zvolit před
preflightem nad anonymizovanou izolovanou kopií.

## Staging evidence schema v2

Evidence gate podporuje dva explicitní režimy:

- `dual_control`: operator a reviewer musí být dva různí lidé;
- `solo_maintainer`: `reviewer` musí být `null`, owner výslovně přijme riziko a
  všechny tyto hodnoty musí být `true`:
  - `mainBranchProtected`;
  - `exactShaQualityGateRequired`;
  - `environmentBranchRestricted`.

AI identita v poli reviewer je fail-closed odmítnuta. Šablona používá schemaVersion 2
a má owner waiver i kompenzační controls výchozí `false`; nelze ji tedy přijmout bez
pozdějšího vědomého vyplnění skutečné staging evidence.

## GitHub `main` protection

Autorizovaná živá konfigurace repozitáře:

- změny `main` musí projít pull requestem;
- required status check je přesně `hermetic-release-gate`, strict/up-to-date,
  GitHub Actions app ID `15368`;
- ochrana se vynucuje i pro admina;
- required approving review count je záměrně 0, protože druhý člověk neexistuje;
- required linear history a required conversation resolution jsou zapnuté;
- force push a delete větve jsou zakázané;
- code-owner review, stale-review dismissal a last-push approval nejsou vydávány
  za dostupné kontroly.

První API payload obsahoval organization-only user/team restriction objekty a GitHub
jej odmítl HTTP 422 bez změny stavu. Opakovaný osobní-repository payload tato pole
vynechal a finální read-back potvrdil přesnou konfiguraci výše.

## GitHub Environment `staging`

Environment byl vytvořen jako fail-closed governance obal, nikoli jako deploy:

- wait timer: 5 minut;
- custom deployment branch policy: pouze `agent/phase13-staging-gate`;
- `STAGING_ENVIRONMENT_ID=site-logbook-staging`;
- `STAGING_MAIL_SANDBOX_CONFIRMED=false`;
- `STAGING_BASE_URL`: nenastaveno;
- `STAGING_ADMIN_USERNAME`: secret neexistuje;
- `STAGING_ADMIN_PASSWORD`: secret neexistuje;
- celkový počet Environment secrets: 0;
- `can_admins_bypass=true` zůstává viditelný reziduální limit solo-owner GitHub
  Environment; ochrana `main` se naproti tomu vynucuje i pro admina.

První create payload obsahoval `prevent_self_review=false`, ale GitHub toto pole bez
alespoň jednoho required reviewera odmítl HTTP 422 bez vzniku Environment. Finální
payload reviewer pravidlo zcela vynechal a read-back potvrdil wait timer i branch
policy. Žádný workflow nebyl dispatchnut.

## Coolify staging hranice

Repo používá root `docker-compose.yml` a dokumentovaný Coolify Docker Compose deploy.
FÁZE 13.7 nevytvořila nový Coolify resource, protože není k dispozici doložený
staging origin, samostatné resource/volume handly ani Coolify session/API oprávnění.

Budoucí staging musí být nový oddělený Coolify resource se samostatnými:

- PostgreSQL 16 DB a volume;
- MinIO datovým volume, bucketem a credentials;
- `SESSION_SECRET`, secret-encryption a backup-encryption keyringem;
- mail sandboxem bez trasy ke skutečným zákazníkům;
- staging admin identitou a heslem;
- neprodukčním HTTPS originem mimo `modvoltapp.cz` a jeho subdomény;
- `BUILD_SHA` a `VITE_BUILD_SHA` rovným přesnému nasazenému commitu.

Produkční env secrets se nesmějí kopírovat. Dokud výše uvedené zdroje neexistují,
GitHub Environment zůstává úmyslně nespustitelný.

## Publikace a ověření

Jediný fast-forward push posunul existující draft PR větev z `55d7fc7` na `88cbc46`.
Použil HTTPS Git transport přes přihlášený GitHub CLI credential helper; hodnoty
tokenu nebyly čteny nebo uloženy. `main` zůstal beze změny. PR body bylo poté jednou
aktualizováno přes GitHub connector a PR zůstal draft/open/unmerged.

Lokální kontroly:

- cílené PPE/public-token kontrakty: 15/15 PASS;
- staging guard/evidence kontrakty: 13/13 PASS;
- celý hermetický API unit gate: 316/316 PASS;
- frontend unit: 127/127 PASS;
- live-events: 15/15 PASS;
- API, libraries a staging E2E TypeScript typecheck: PASS;
- cílený i full-repository ESLint: PASS, 0 warnings;
- peer dependency gate: PASS;
- dependency audit: 0 moderate/high/critical, 1 existující low;
- API build a produkční frontend/PWA build: PASS;
- úplný lokální hermetický release gate: PASS;
- `git diff --check`, secret scan a 0100 scan: PASS.

Remote run `30764192158` prošel na exact SHA včetně PostgreSQL 16 izolovaných DB
suites a šifrovaného MinIO recovery drillu. Jde o CI evidence, ne o externí staging
E2E nebo produkční důkaz.

## Zbývající blokátory staging deploye

1. Hardened staging Compose/Coolify runtime definice s interním mail sandboxem.
2. Samostatný Coolify resource a neprodukční HTTPS origin.
3. Oddělené staging-only secrets, volumes a admin účet.
4. Service-owner hodnoty pro oba PPE typy a read-only preflight na anonymizované
   obnovené kopii.
5. Samostatná uživatelská autorizace exact-SHA staging deploye a následného smoke.

Staging deploy, workflow dispatch, merge a produkce proto zůstávají **BLOCKED**.
