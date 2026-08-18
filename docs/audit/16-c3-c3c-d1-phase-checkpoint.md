# Checkpoint R16-C3C3C-D1 – owner-qualified package REST namespace

Datum: 2026-08-10

## Výsledek

**Package REST namespace blokátor je opraven a lokálně ověřen ve veřejných
publisher workflows. Nebyl proveden žádný nový dispatch ani GHCR zápis.**

Implementation commit:
`a74d8e9fc05a43c01afe76e4da70033a431f2141`.

Oprava nahrazuje pouze package API root:

```text
/user/packages
→ /users/modvolt/packages
```

Změna je konzistentní ve:

- fixed predecessor publisheru;
- candidate five-image publisheru;
- inventory a package metadata čtení;
- active i deleted version inventuře;
- pre-push TOCTOU rechecku;
- post-push digest/version refetchi;
- mock execution harnessu;
- fail-closed runtime a mutation kontraktu.

## Důvod opravy

Run `31337538887` prokázal, že repository Actions `GITHUB_TOKEN` odmítá
authenticated-user `/user/packages` inventory HTTP 400 ještě před checkoutem,
buildem a GHCR loginem. GitHub REST dokumentace uvádí explicitní
`/users/{username}/packages` endpoint pro packages v uživatelském namespace, ke
kterým má requester přístup, a deklaruje podporu GitHub App installation tokenů.

Pevný owner `modvolt` je současně svázán s již existující kontrolou caller repo,
repository ownera, actorů, private visibility a caller-linked package metadata.
Oprava proto nerozšiřuje důvěryhodnou hranici.

## Fail-closed kontrakt

Runtime kontrola vyžaduje:

- přesně 8 owner-qualified package API odkazů v candidate workflow;
- přesně 13 owner-qualified package API odkazů v predecessor workflow;
- žádný výskyt `/user/packages` v publisher workflows;
- pevný `/users/modvolt/packages` inventory, metadata a version root.

Mutation testy odmítají:

- návrat inventory na `/user/packages`;
- změnu jediného owner-qualified endpointu na jiného vlastníka;
- částečnou nebo chybějící endpoint migraci.

## Pin důkaz

Public private-wrapper template nyní připíná reusable workflow na:

`a74d8e9fc05a43c01afe76e4da70033a431f2141`.

- Git blob: `2541a08dc41511c5b8f9c8f47a423fbec0f34347`;
- bytes: `1498`;
- SHA-256:
  `233ca267b59e3856575584a0f4949dd1bcf218e20a070ba42b2969f0604ad84d`.

Historické dokumenty o předchozím reusable pinu zůstaly nezměněné.

## Provedené kontroly

- public branch/PR a předchozí exact-head Quality run před změnou: PASS;
- explicitní owner endpoint přes OAuth user token: HTTP 200 a prázdná inventura;
- Prettier změněných workflow/scripts/tests: PASS;
- runtime/mutation testy: 22/22 PASS;
- izolovaný offline Docker workflow execution harness: PASS;
- kompletní staging-contract balík: PASS;
- `pnpm.cmd run gate:staging-runtime`: PASS;
- `pnpm.cmd run gate:quality`: PASS;
- ESLint: bez warnings/errors;
- peer dependency check: bez problémů;
- dependency audit na moderate+: bez známých zranitelností;
- `git diff --check`: PASS.

## Bezpečnostní hranice

- žádný workflow dispatch ani rerun;
- žádný GHCR zápis;
- žádný private commit, PR nebo merge;
- žádný deploy, Coolify, DB, S3, DNS ani secrets zásah;
- žádná migrace; `0100` zůstává nezařazena a `0105` nebyla spuštěna;
- produkce nebyla dotčena.

## Nejasnosti a zbývající kroky

1. Exact kompatibilita `/users/modvolt/packages` s repository `GITHUB_TOKEN` je
   podložena oficiálním installation-token kontraktem a lokálním OAuth API
   testem, ale definitivně ji potvrdí až nový samostatně schválený Actions run.
2. Private `main` stále připíná předchozí reusable commit; bez one-file pin
   update by další dispatch znovu spustil starou implementaci.
3. Nový dispatch ani private merge nejsou součástí této fáze.

## Doporučení pro další spuštění

- další fáze: R16-C3C3C-D2 – po zeleném exact-head public Quality gate vytvořit
  one-file private pin větev, commit, non-force push a draft PR;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: high;
- důvod použití této úrovně: private wrapper musí být bajtově shodný s veřejnou
  template a připnout přesně auditovaný implementation commit bez spuštění
  workflow;
- očekávané činnosti: ověřit public implementation commit jako předka finálního
  headu a zelený exact-head CI; ověřit private main/run ledger/GHCR; změnit pouze
  reusable SHA v private wrapperu; ověřit blob/hash; commitnout, non-force
  pushnout a otevřít draft PR;
- soubory, které budou pravděpodobně změněny: v private repozitáři pouze
  `.github/workflows/publish-staging-predecessor.yml`; veřejně pouze následný
  auditní checkpoint;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: žádné migrace,
  deploy, dispatch, GHCR write ani private merge. Rizikem je pouze změna
  default-branch workflow připravovaná v draft PR.

## Stop

Checkpoint R16-C3C3C-D1 je vytvořen. Další fáze nebyla zahájena.

## Aktualizace po non-force pushnutí

Implementation commit `a74d8e9fc05a43c01afe76e4da70033a431f2141` a původní
pin/checkpoint commit `d323849c0a160807d21caceaa71c58e75ee6a179` byly úspěšně
non-force pushnuty na `origin/agent/phase16c3-staging-preflight`.

Mezi předpushovým ověřením a vyhodnocením exact-head CI se public `main` posunul
z `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f` na
`d18ddc93f87fa22d1d363b1b5a899ce8071a826b` merge commitem billing PR #16.
Public PR #15 proto zůstal open, draft a unmerged, ale GitHub jej vyhodnotil jako
`CONFLICTING` / `DIRTY` a pro nový head nevytvořil žádný Quality gate run.

Lokální read-only `merge-tree` proti čerstvě staženému `origin/main` prokázal
právě jeden konfliktní soubor:

`artifacts/api-server/test/review-queue-actions.test.ts`.

Jde o dva markery v jednom fixture bloku: nový `main` používá lokálně vytvořený
`assignedJobId`, zatímco auditní větev používá globální `testJobId`. Všechny
ostatní soubory z nového `main` Git vyhodnotil jako automaticky slučitelné.
Publisher workflows ani D1 package REST kontrakt nejsou v konfliktu.

Nebyl proveden merge, rebase ani ruční řešení konfliktu. Nebyl spuštěn dispatch,
nevznikl GHCR zápis, private merge, deploy ani migrace.

Tato aktualizace nahrazuje výše uvedené doporučení D2: nejbližší další podfází
musí být R16-C3C3C-D1B – po samostatném výslovném schválení non-force sloučit
aktuální public `main`, vyřešit pouze uvedený testovací fixture konflikt, spustit
relevantní billing test i úplné gate, pushnout a vyžádat exact-head Quality gate.
