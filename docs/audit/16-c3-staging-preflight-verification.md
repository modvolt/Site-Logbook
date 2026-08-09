# R16-C3 – verifikace staging preflightu

Datum: 2026-08-05

## Rozhodnutí

Repozitářová část je připravena, ale živý staging rollout má stav **NO-GO**.
Produkce, Coolify konfigurace, GitHub environment, secrets, DB, S3, GHCR a DNS
nebyly změněny. Migrace `0105` nebyla spuštěna a feature flag nebyl zapnut.

## Read-only mapa aktuálního control plane

### Coolify

- Server `localhost` spravuje pouze environment `production`; samostatný staging
  resource ani spravovaná DB v seznamu není.
- Produkční aplikace `Modvolt` je Docker Compose resource, zdroj
  `modvolt/Site-Logbook`, branch `main`, doména `https://modvoltapp.cz`.
- UI ukazuje běžící commit `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`, stav
  health `unknown` a jednu neaplikovanou změnu Docker Compose vyžadující rebuild.
- Název `EXTERNAL_ACCOUNTS_ENABLED` v produkčním env seznamu přítomen není.
- Pro resource nejsou v Coolify nakonfigurované žádné scheduled tasks.
- Bylo provedeno pouze redigované čtení; žádné Save, rebuild, deploy, restart,
  stop, terminal command ani čtení secret hodnot.

### GitHub

- Environment `staging` existuje, ale povoluje pouze starou branch
  `agent/phase13-staging-gate`; má pětiminutový wait timer a žádného reviewera.
- Přítomné jsou jen `STAGING_ENVIRONMENT_ID` a nevyhovující
  `STAGING_MAIL_SANDBOX_CONFIRMED`; chybí obě URL a všechny tři staging secrets
  požadované smoke workflow.
- Neexistuje skutečný staging deployment ani staging artifact. Šest historických
  staging-smoke záznamů mělo failure a nula jobů.
- Privátní `modvolt/site-logbook-registry` existuje, ale jeho default branch
  obsahuje jen README. Wrapper je pouze v draft PR a nikdy nepublikoval image.
- Aktuální PR #14 je stacked, nikoli přímo proti `main`; dosavadní publisher jej
  proto nemůže přijmout.

## Implementovaná architektura

- Boundary preflight vyžaduje explicitní `flag=false`, exact SHA/manifest,
  migration confirmation a bounded backup evidence vstupy.
- Nový DB pre/postflight načte přesný migration bundle, odmítne `0100`, připne
  `0104`/`0105` hashe a snapshot chain a porovná exact DB migration set včetně
  hashů, extra řádků a duplicit.
- Pre/postflight běží v read-only repeatable-read transakci pod stejným advisory
  lockem jako standardní migrátor.
- Nejnovější backup řádek je svázán přes ID a musí mít success, nonempty object,
  size, SHA-256, `mve1`, key id, `restore_status=ok` a čerstvý restore timestamp.
  Log summary obsahuje pouze ID a stáří, ne path/hash/key/secret.
- One-shot schema gate je jediný writer a API je na jeho úspěchu závislé. API
  při každém startu opakuje read-only postflight a nespouští migrátor.
- Staging E2E a secret-free bootstrap artifact požadují přesně
  `0105_smooth_nitro`, 105/105, žádné missing tags, runtime false a nulový
  inventář externích účtů.
- GHCR publisher guard byl připraven pro candidate branch
  `agent/phase16c3-staging-preflight`; žádná publikace nebyla spuštěna.

## Provedené kontroly

- external schema preflight unit/contract: 11/11 PASS;
- staging guard + runtime contract: 24/24 PASS před rozšířením a 17/17 finální
  runtime slice PASS;
- staging runtime static gate: PASS;
- library TypeScript a staging E2E TypeScript: PASS;
- API TypeScript: PASS;
- API esbuild včetně `dist/external-schema-preflight.mjs`: PASS;
- wrapper bez env končí fail-closed kódem `ENV_MISSING`: PASS;
- ESLint full repository: PASS;
- Prettier pro podporované změněné soubory: PASS;
- YAML unique-key parse pro Compose a tři workflow: PASS;
- `git diff --check`: PASS;
- širší `test:staging-contract`: 44/53 PASS; zbývajících devět scénářů nebylo
  spuštěno, protože lokálně chybí offline Docker harness image. Jde o explicitní
  prerequisite, ne assertion failure; těžká část je ponechána exact-SHA CI.

## Nejasnosti a zbytková rizika

- Neexistuje izolovaný staging resource, doména, DB volume, storage, mail sandbox
  ani alert receiver; živý test proto nelze bezpečně spustit.
- Není read-only ověřen aktuální produkční DB journal. Obnovená produkční kopie
  proto může být za `0104`; před `0105` pak vyžaduje oddělený immutable baseline
  rollout na auditovaném predecessor SHA `c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3`,
  novou staging-only zálohu exact stavu `0104` a restore-test stejného ID.
- GitHub environment, publisher wrapper a draft PR stack musí být přepnuty na
  jeden auditovatelný candidate přímo proti `main`.
- Merge do `main` může ovlivnit produkční source branch a bez výslovného souhlasu
  je zakázán.
- SQL trigger custodiana kontroluje aktivního interního uživatele, ale nikoli
  efektivní `users.manage`; service/auth vrstva zůstává fail-closed. Jde o
  follow-up před pilotem, nikoli blokátor zero-row schema rollout.
- Trigger identity guardu je `BEFORE UPDATE`, nikoli `INSERT`; insert invarianty
  dnes zajišťuje schema shape + service vrstva. Před pilotem má být rozhodnuto,
  zda invariant rozšířit v nové migraci; `0105` se nyní nepřepisuje.
- Guarded rollback je bezpečný jen před prvním externím datovým záznamem.

Podrobný operační postup je v
[16-c3-staging-schema-gate-runbook.md](16-c3-staging-schema-gate-runbook.md).

## R16-C3B1 – provisioning a restart gate

Následná kontrola odhalila, že původní Compose vyžadoval confirmation `0105`
ještě před PostgreSQL. Nebylo proto možné splnit krok runbooku „obnovit a pouze
přečíst journal“. Původní gate navíc po úspěšné `0105` při redeployi znovu
vyžadoval pre-state `0104` a startup API zůstal svázaný s ID a stářím přechodové
zálohy.

Repo kontrakt nyní odděluje:

- `inspect` – izolovaný PostgreSQL a read-only klasifikace exact migration
  prefixu jako `BASELINE_0104_REQUIRED`, `READY_0104` nebo `ALREADY_0105`;
- `apply-0105` – jediný režim s confirmation, backup bindem a standardním
  migrátorem;
- `steady-0105` – idempotentní redeploy a API restart s exact 105/105,
  kompletním schema stavem, `flag=false` a nulou externích dat, ale bez závislosti
  na historické backup freshness.

Inventory odmítá mezery, unknown/extra řádky, duplicate `created_at`, hash drift,
`0100` i journal za `0105`. Gate při exact `0105` provede bezpečný no-op; stav za
`0104` nikdy automaticky nedobaselinovává.

Aktuální ověření R16-C3B1:

- DB-free schema testy: 13/13 PASS;
- staging runtime kontrakty: 17/17 PASS;
- library a API TypeScript: PASS;
- API esbuild s `external-schema-inventory`, `external-schema-gate` a
  `external-schema-steady-state`: PASS;
- cílený external-account API kontrakt: 5/5 PASS;
- Docker harness: lokálně záměrně nespouštěn; Docker daemon neodpovídá,
  `com.docker.service` je zastavená a bylo zjištěno 39 visících `docker.exe`
  procesů. Tři čistě statické harness scénáře prošly 3/3.

GitHub connector potvrzuje, že remote branch
`agent/phase16c3-staging-preflight`, commity `09e9f08`/`b651b40` ani odpovídající
PR dosud neexistují. Lokální `gh` účet je označen jako aktivní, ale token je
neplatný; nízkoúrovňová rekonstrukce Git objectů přes connector nebyla použita,
protože by nezachovala exact lokální commity.

## R16-C3C3C-A – read-only GHCR inventura

Aktualizace 2026-08-09 nahradila dřívější neověřený stav GHCR živým,
vyčerpávajícím čtením přes účet `modvolt`. OAuth token dostal pouze dříve
výslovně schválený scope `read:packages`; jeho hodnota nebyla načtena ani
uložena.

- Úplná stránkovaná inventura `/user/packages?package_type=container` vrátila
  jednu dokončenou stránku a nula kontejnerových packages. Stejný výsledek má
  inventura s `visibility=private` i veřejný uživatelský endpoint.
- Target `site-logbook-staging-api` má tedy nula aktivních package řádků a nula
  aktivních exact-SHA tagů pro predecessor
  `c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3`. Přímé metadata a version endpointy
  targetu vracejí `404 Package not found`.
- GitHub API neumí u zcela odstraněného package prokázat historickou
  neexistenci. Viditelné deleted versions proto nelze číst, dokud package
  neexistuje; tato hranice zůstává explicitní. Doplňkový externí ledger je
  nulový počet běhů fixed predecessor workflow, nikoli absolutní důkaz, že
  někdo v minulosti nikdy nepoužil jiného registry klienta.
- Privátní `main` je `9dbc048e4597eaf9ac9d4dd5d799406e1d9ddafc`. Wrapper má Git blob
  `46437dcc7ad0b432bcf4d479b6ea08764a952717`, SHA-256
  `61aa49bdb033e5bc3a100d28e3a1251c8f4619591efc33e9362e8bdb16f24830` a je
  bajtově shodný s veřejnou auditovanou šablonou na final PR head.
- Wrapper připíná veřejný reusable workflow na commit
  `e7222e759b4ecf523defa0329d2dfd3fadd2c5eb`. Tento commit existuje a je předkem
  aktuálního veřejného head `daff5f9fb38545ed16c1577713def690cb85a5c6`.
- Fixed publisher je na GitHubu registrován jako aktivní workflow ID
  `330628153`; jeho počet běhů je přesně nula. Nebyl proveden dispatch ani GHCR
  zápis.
- Veřejný PR #15 zůstává otevřený, draft a nesloučený na přesném head
  `daff5f9fb38545ed16c1577713def690cb85a5c6`. Quality run `31333804818` pro
  tento head je `completed/success` a vznikl událostí `pull_request`.

Rozhodnutí této read-only podfáze je **PREPARED, WRITE NOT AUTHORIZED**. Žádný
workflow dispatch, GHCR write, deploy, migrace, Coolify, DB, S3, DNS ani produkce
nebyly změněny. Další krok může vytvořit první immutable predecessor package
verzi pouze po novém samostatném výslovném souhlasu.

## R16-C3C3C-B – první fixed predecessor dispatch skončil fail-closed

Aktualizace 2026-08-09 provedla právě jeden uživatelem výslovně schválený
dispatch privátního fixed predecessor publisheru. Run
[`31335035618`](https://github.com/modvolt/site-logbook-registry/actions/runs/31335035618)
vznikl z private `main` `9dbc048e4597eaf9ac9d4dd5d799406e1d9ddafc`, actor i
triggering actor byly `modvolt` a přesná confirmation prošla.

Run skončil `failure` ještě před prvním called-workflow jobem:

- `validate-manual-owner` job `93299393091` skončil `success`;
- run metadata správně rozpoznala reusable workflow na commitu
  `e7222e759b4ecf523defa0329d2dfd3fadd2c5eb`;
- úplný seznam obsahuje pouze owner gate, žádný build ani package job;
- počet artifacts je nula;
- bezprostřední post-failure GHCR inventura stále obsahuje nula container
  packages a nula target packages;
- nebyl proveden druhý dispatch, rerun, deploy ani migrace.

GitHub neposkytl run-level anotaci ani log pro chybějící called job. Nejlépe
podloženou příčinou je proto označená inference, nikoli přímo vypsaná chyba:
private wrapper i called reusable mají stejný workflow-level concurrency group
`site-logbook-images-publication`. Caller drží group ještě před zavoláním
reusable, které požaduje stejnou lease. Historický candidate wrapper používal
pro caller odlišný `site-logbook-registry-publication`, zatímco called workflow
drželo `site-logbook-images-publication`.

Oficiální [GitHub concurrency dokumentace](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
potvrzuje, že v jednom group může běžet nejvýše jeden workflow/job; dokumentace
reusable workflows navíc výslovně varuje před shodným caller/called group při
rušení rozběhnutých běhů. Pozorovaný stav odpovídá kolizi reusable-workflow
lease před vytvořením prvního called jobu.

Navržená úzká oprava je ponechat called reusable na
`site-logbook-images-publication`, ale vrátit private caller wrapper na
`site-logbook-registry-publication`. Stejný caller group musí sdílet oba
privátní publishery, aby se vzájemně serializovaly, zatímco caller nesmí
kolabovat se svou vlastní reusable lease. Oprava zatím nebyla implementována;
vyžaduje nové výslovné schválení podle CI-fix workflow.

## R16-C3C3C-B1 – oddělení caller/reusable concurrency kontraktu

Po výslovném schválení byla veřejná auditovaná template opravena tak, aby
private caller držel `site-logbook-registry-publication`, zatímco called reusable
nadále drží `site-logbook-images-publication`. `cancel-in-progress` zůstává na
obou vrstvách `false`.

Fail-closed runtime kontrakt nyní vyžaduje právě jeden registry caller group a
právě jeden `cancel-in-progress: false` a výslovně odmítá přítomnost reusable
group ve wrapperu kódem
`STAGING_PREDECESSOR_WRAPPER_CONCURRENCY_COLLISION`. Mutation test prokazuje
odmítnutí jak původního shodného group, tak změny `cancel-in-progress` na
`true`.

Lokální ověření:

- cílený runtime kontrakt: 22/22 PASS;
- predecessor evidence + runtime kontrakty: 28/28 PASS;
- `pnpm.cmd gate:staging-runtime`: PASS;
- `pnpm.cmd gate:quality`: PASS;
- strict YAML unique-key parse wrapperu a reusable workflow: 2/2 PASS.

Tato podfáze mění pouze veřejnou template a její kontrakt/test. Private `main`
stále obsahuje původní group; nebyl vytvořen ani mergován private PR a nebyl
proveden nový dispatch, GHCR zápis, deploy ani migrace.

## R16-C3C3C-B2 – one-file private wrapper draft PR

Po výslovném schválení vznikla nová private větev
`agent/phase16c3-predecessor-concurrency-fix` z přesného private `main`
`9dbc048e4597eaf9ac9d4dd5d799406e1d9ddafc`.

Commit `10246b4656f6e6b5cf86b537948a36aaead82a54` mění pouze
`.github/workflows/publish-staging-predecessor.yml`: jeden řádek group z
`site-logbook-images-publication` na `site-logbook-registry-publication`.

Draft [private PR #3](https://github.com/modvolt/site-logbook-registry/pull/3)
je `open`, `draft`, `unmerged`, `mergeable=true`, `mergeable_state=clean`, míří
přímo do `main` a obsahuje přesně jeden commit, jeden soubor, jednu inserci a
jednu deleci.

PR head wrapper má Git blob
`6e0ff648028b0e7dfbe41e83ed456471969b93a7`, 1498 bytes a SHA-256
`d16ea4e40ed8bfab9b102e19647d1a95b0f28554ee503681f6fa424232ed0a76`. Je
bajtově shodný s veřejnou auditovanou template na zeleném public head
`532b45799a076e4f56185366ae3e9e055ccd6723`.

Private `main` zůstal nezměněný, nový PR head nemá žádný Actions run, fixed
publisher má stále jen původní selhaný run `31335035618` a GHCR inventura stále
obsahuje nula container i target packages. PR nebyl označen ready ani mergován;
nebyl proveden dispatch, deploy ani migrace.

## R16-C3C3C-B3 – exact-head merge opraveného private wrapperu

Po samostatném výslovném schválení byl private PR
[#3](https://github.com/modvolt/site-logbook-registry/pull/3) nejprve znovu
ověřen jako `open`, `draft`, `mergeable`, `clean` s přesným head
`10246b4656f6e6b5cf86b537948a36aaead82a54` a base
`9dbc048e4597eaf9ac9d4dd5d799406e1d9ddafc`. Rozsah zůstal přesně jeden commit,
jediný workflow soubor a změna 1+/1−.

PR byl označen ready a sloučen standardním merge commitem s match-head ochranou,
bez admin override a bez smazání zdrojové větve. Private `main` nyní ukazuje na
merge commit `064adcfd43920d624670acad1a442375f37deee5`, jehož rodiče jsou v pořadí
původní base `9dbc048e4597eaf9ac9d4dd5d799406e1d9ddafc` a schválený head
`10246b4656f6e6b5cf86b537948a36aaead82a54`.

Wrapper na private `main` má Git blob
`6e0ff648028b0e7dfbe41e83ed456471969b93a7`, 1498 bytes a SHA-256
`d16ea4e40ed8bfab9b102e19647d1a95b0f28554ee503681f6fa424232ed0a76`; je
stále bajtově shodný s veřejnou auditovanou template. GitHub workflow ID
`330628153` je registrováno jako `active`.

Post-merge kontrola potvrzuje právě jeden historický publisher run
`31335035618` z původního main a žádný nový run. GHCR inventura má stále nula
container packages a nula target packages `site-logbook-staging-api`. Veřejný
PR #15 zůstává draft, open a unmerged na head
`532b45799a076e4f56185366ae3e9e055ccd6723`; exact-head Quality run
`31335963994` zůstává `completed/success`.

Nebyl proveden workflow dispatch, rerun, GHCR zápis, deploy, Coolify, DB, S3,
DNS, secrets ani migrace. `0100` zůstává nezařazena a `0105` nebyla spuštěna.

## R16-C3C3C-C – druhý fixed predecessor dispatch skončil fail-closed

Po samostatném výslovném schválení proběhl právě jeden nový dispatch fixed
predecessor publisheru. Run
[`31337538887`](https://github.com/modvolt/site-logbook-registry/actions/runs/31337538887)
je run number 2, attempt 1, event `workflow_dispatch`, head branch `main` a exact
head `064adcfd43920d624670acad1a442375f37deee5`. Další dispatch ani rerun nebyl
proveden.

Před dispatch prošel fail-closed preflight identity `modvolt`, private
main/wrapper blob a SHA-256, aktivní workflow ID `330628153`, public PR #15 a
exact-head Quality run `31335963994`, predecessor source/tree, nulový aktivní
publisher i nulový GHCR container/target stav.

Run prokázal, že oprava concurrency funguje: `validate-manual-owner` job
`93305749236` i called `validate-fixed-public-source` job `93305761011` skončily
`success` a reusable publish job byl skutečně vytvořen. `publish-fixed-predecessor-api`
job `93305771437` potom skončil `failure` ve svém prvním kroku
`Require approved private manual caller and exact tag state`.

Log potvrzuje exact caller repository, owner, actor, triggering actor, workflow
ref, confirmation, source SHA/tree i `packages: write`. Následné volání
`gh api --paginate '/user/packages?package_type=container&per_page=100'` s
workflow `GITHUB_TOKEN` vrátilo HTTP 400 `Invalid argument`; fail-closed wrapper
jej správně převedl na `the authenticated private package inventory could not be
read`.

Checkout, migration bundle check, Buildx, GHCR login, lokální build, recheck,
push, digest/provenance/SBOM ověření i artifact upload byly přeskočeny. Artifact
count je 0. Post-run inventura přes uživatelský OAuth token stále vrací 0
private container packages a 0 target packages `site-logbook-staging-api`.

Oficiální GitHub REST dokumentace popisuje `/user/packages` jako namespace
autentizovaného uživatele a `/users/{username}/packages` jako explicitní
uživatelský namespace; oba endpointy deklarují podporu GitHub App installation
tokenů. Pozorovaný Actions runtime ale první variantu s repository
`GITHUB_TOKEN` odmítl. Nejmenší kandidátní oprava je proto namespace-qualified
package API kontrakt, musí však být samostatně implementován, mutation-testován
a znovu projít public exact-head Quality gate. Stejný `/user/packages` vzor je
přítomen i v candidate `staging-images.yml`, takže před jeho prvním spuštěním
vyžaduje stejný audit.

Nebyl proveden GHCR zápis, deploy, Coolify, DB, S3, DNS, secrets ani migrace.
`0100` zůstává nezařazena a `0105` nebyla spuštěna.

## R16-C3C3C-D1 – owner-qualified package REST namespace

Po výslovném schválení byla implementována úzká oprava blokátoru z runu
[`31337538887`](https://github.com/modvolt/site-logbook-registry/actions/runs/31337538887).
Všechna package REST čtení v predecessor i candidate publisheru nyní používají
pevný namespace `/users/modvolt/packages`; stavový automat, permissions,
registry názvy, exact tagy a build/push logika se nezměnily.

Implementation commit je `a74d8e9fc05a43c01afe76e4da70033a431f2141`.
Runtime kontrakt vyžaduje přesně všech 8 candidate a 13 predecessor package API
odkazů v owner-qualified namespace, odmítá návrat na `/user/packages` i změnu
ownera a chrání inventory, metadata, active/deleted versions i refetch cesty.
Mock execution harness používá stejné explicitní endpointy.

Veřejná private-wrapper template připíná reusable workflow na implementation
commit `a74d8e9fc05a43c01afe76e4da70033a431f2141`. Template má Git blob
`2541a08dc41511c5b8f9c8f47a423fbec0f34347`, 1498 bytes a SHA-256
`233ca267b59e3856575584a0f4949dd1bcf218e20a070ba42b2969f0604ad84d`.
Historické auditní důkazy původního pinu zůstaly beze změny.

Lokální ověření:

- explicitní `/users/modvolt/packages` endpoint přes OAuth user token: HTTP 200,
  nulová inventura shodná s dřívějším `/user/packages` čtením;
- runtime/mutation testy: 22/22 PASS;
- sériový offline Docker execution harness: PASS;
- kompletní `test:staging-contract`: PASS;
- `gate:staging-runtime`: PASS;
- `gate:quality`: PASS, bez ESLint chyb, peer problémů a známých moderate+
  dependency zranitelností;
- Prettier a `git diff --check`: PASS.

Oprava zatím není aktivní v private wrapperu na `main`; ten stále připíná starý
reusable commit. Nebyl proveden private commit/PR/merge, workflow dispatch,
rerun, GHCR zápis, deploy ani migrace. Další krok smí pouze po novém souhlasu
vytvořit one-file private pin update a draft PR.

### Post-push blokátor D1

Implementation commit `a74d8e9fc05a43c01afe76e4da70033a431f2141` a
pin/checkpoint commit `d323849c0a160807d21caceaa71c58e75ee6a179` byly úspěšně
non-force pushnuty. Public `main` se poté posunul z `a25c3128...` na
`d18ddc93...` merge commitem billing PR #16. PR #15 je nadále draft/open/unmerged,
ale je `CONFLICTING` / `DIRTY` a nemá exact-head Quality run.

Read-only `merge-tree` proti aktuálnímu `origin/main` našel jediný konfliktní
soubor `artifacts/api-server/test/review-queue-actions.test.ts`, konkrétně dvě
varianty job-ID fixture v jednom bloku. Publisher workflows ani D1 kontrakt se
nekříží. Bez nového oprávnění nebyl proveden merge, rebase ani řešení konfliktu.
Nejbližší další krok je R16-C3C3C-D1B, nikoli D2.

## R16-C3C3C-D1B – public main reconciliation

Public `main` `d18ddc93f87fa22d1d363b1b5a899ce8071a826b` byl bez rebase
a bez force operace sloučen merge commitem
`3875fdb6663e22f21caf15e74d8d79aa2ac36cab`. Jediný konflikt byl v
`artifacts/api-server/test/review-queue-actions.test.ts`; výsledná varianta
zachovává globální izolovanou `testJobId` fixture, její správné pořadí teardownu
a odstraňuje automaticky zdvojený import. Publisher workflows a D1 REST kontrakt
nebyly konfliktem změněny.

Cílené billing ověření prošlo 132/132 testů. Root typecheck, API build,
Stavba/Vite/PWA build, staging runtime contract, staging-contract 89/89, ESLint,
peer dependency check, moderate+ audit a `git diff --check` prošly. Izolovaný
PostgreSQL byl omezen na 0,5 CPU a 384 MiB a nesdílel data ani port se Service
Book Keeperem. Nebyl proveden private zásah, dispatch, GHCR zápis, deploy ani
staging/produkční migrace.
