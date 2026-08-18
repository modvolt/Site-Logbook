# Checkpoint R16-C3C3C-C – publisher package inventory fail-closed

Datum: 2026-08-09

## Výsledek

**Právě jeden schválený fixed predecessor dispatch byl proveden. Run skončil
fail-closed před checkoutem, buildem a registry zápisem; GHCR zůstává prázdné.**

- run: [31337538887](https://github.com/modvolt/site-logbook-registry/actions/runs/31337538887);
- workflow run number: `2`;
- attempt: `1`;
- event: `workflow_dispatch`;
- exact private main/head: `064adcfd43920d624670acad1a442375f37deee5`;
- stav: `completed/failure`;
- publisher ledger: právě dva runy, `31335035618` a `31337538887`;
- artifact count: `0`;
- private container packages: `0`;
- target `site-logbook-staging-api`: `0`.

## Preflight

Před jediným dispatch byly ověřeny:

- GitHub identity `modvolt`;
- exact private `main` a wrapper blob/hash;
- workflow ID `330628153` ve stavu `active`;
- právě jeden historický dokončený publisher run a žádný aktivní run;
- nulový private GHCR container i target stav;
- public PR #15 jako open/draft/unmerged na head
  `532b45799a076e4f56185366ae3e9e055ccd6723`;
- public Quality run `31335963994` jako `completed/success` pro exact head;
- fixed reusable commit `e7222e759b4ecf523defa0329d2dfd3fadd2c5eb`;
- predecessor source `c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3` a tree
  `cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c`.

## Průběh a přesná chyba

- `validate-manual-owner` job `93305749236`: success;
- called `validate-fixed-public-source` job `93305761011`: success;
- `publish-fixed-predecessor-api` job `93305771437`: failure;
- failing step: `Require approved private manual caller and exact tag state`.

Concurrency oprava je tím runtime potvrzena: called workflow se vytvořil a oba
úvodní gate joby prošly. Fail nastal až uvnitř package inventory preflightu.

Přesná relevantní sekvence logu:

```text
gh: Invalid argument. (HTTP 400)
Fixed predecessor package preflight failed: the authenticated private package inventory could not be read.
```

Selhalo volání:

```text
gh api --paginate '/user/packages?package_type=container&per_page=100'
```

Workflow token měl `Contents: read` a `Packages: write`; caller repository,
owner, actor, triggering actor, workflow ref, confirmation i fixed source
kontrakt byly před tím potvrzeny.

## Bezpečnostní dopad

Následující kroky byly přeskočeny:

- checkout fixed predecessor source;
- migration bundle check;
- Buildx a GHCR login;
- lokální no-push build;
- předpublikační recheck;
- build/push;
- digest, provenance a SBOM ověření;
- evidence artifact upload.

Nebyl proveden GHCR zápis, deploy, Coolify, DB, S3, DNS, secrets ani migrace.
Produkce nebyla dotčena. `0100` zůstává nezařazena a `0105` nebyla spuštěna.

## Diagnóza

Pozorovaný blokátor je package REST endpoint/token kompatibilita. Workflow
repository `GITHUB_TOKEN` odmítl `/user/packages` HTTP 400, přestože stejné
volání s lokálním OAuth user tokenem funguje a vrací prázdnou inventuru.

Oficiální dokumentace rozlišuje:

- `/user/packages` – packages vlastněné autentizovaným uživatelem;
- `/users/{username}/packages` – packages v explicitním uživatelském namespace,
  ke kterým má requester přístup.

Oba dokumentované endpointy uvádějí podporu GitHub App installation tokenů.
Runtime důkaz ale ukazuje, že repository `GITHUB_TOKEN` v tomto workflow není s
první variantou prakticky kompatibilní. Namespace-qualified varianta je proto
nejmenší kandidátní oprava, ne ještě potvrzené řešení.

Související endpointy pro metadata/verze a candidate workflow musí být upraveny
konzistentně nebo výslovně ponechány fail-closed. Budoucí skutečný Actions test
stále vyžaduje nový samostatný souhlas; tento run se nesmí rerunovat.

## Doporučení pro další spuštění

- další fáze: R16-C3C3C-D1 – úzká oprava package REST namespace kontraktu bez
  dispatchu;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: změna zasahuje fail-closed inventuru před i po
  nevratném registry zápisu a musí zachovat detekci duplicate/deleted verzí,
  caller linkage a exact-tag state machine;
- očekávané činnosti: ověřit všechny package API varianty proti oficiálnímu
  kontraktu; upravit predecessor a sdílený candidate publisher konzistentně;
  doplnit runtime/mutation testy; spustit cílené testy, staging runtime gate a
  Quality gate; vytvořit oddělený public implementation commit a následný
  pin/checkpoint commit, protože wrapper template nemůže bezpečně připnout commit,
  který ještě neexistuje;
- soubory, které budou pravděpodobně změněny:
  `.github/workflows/staging-predecessor-image.yml`,
  `.github/workflows/staging-images.yml`,
  `docs/audit/16-c3-private-predecessor-wrapper.template.yml`,
  `scripts/check-staging-runtime-contract.mjs`, související workflow/runtime
  testy a auditní dokumentace;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: žádné migrace,
  deploy ani GHCR write. Jde o public workflow kontrakt; nový dispatch musí mít
  později nový samostatný výslovný souhlas.

## Stop

Checkpoint R16-C3C3C-C je vytvořen. Nebyla implementována oprava a nebyl
proveden další dispatch ani rerun.
