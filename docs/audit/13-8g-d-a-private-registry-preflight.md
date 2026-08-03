# FÁZE 13.8G-D-A – private GHCR publication preflight

- **Datum dokončení:** 2026-08-04.
- **Verdikt:** **STOP – WORKFLOW NELZE DISPATCHNOUT A PRIVATE VISIBILITY NENÍ ZAJIŠTĚNA**.
- **Schválený source kandidát:** `01606ff564456f49ac9e3094c564917db023b977`.
- **Quality gate:** [run 30856976202](https://github.com/modvolt/Site-Logbook/actions/runs/30856976202), `completed/success`.
- **Registry zápis:** neproveden.
- **Deploy:** neproveden.
- **Migrace `0100`:** nepřítomná, nedotčená a nespouštěná.

## Ověřený stav

GitHub metadata a dvě nezávislé agentní kontroly potvrdily:

- repozitář `modvolt/Site-Logbook` je **public**, vlastníkem je osobní účet `modvolt`;
- PR #1 je otevřený, draft a nesloučený; head je přesně `01606ff…`, base `main` je
  `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`;
- lokální HEAD `7a49fc65e17597dbf933c0516db6716f93561abb` se od remote kandidáta liší pouze dvěma
  auditními dokumenty F13.8G-C a worktree byl před tímto checkpointem čistý;
- GitHub Actions jsou povolené, `allowed_actions=all`, defaultní `GITHUB_TOKEN` je read-only;
  publication workflow si explicitně žádá pouze `contents: read` a `packages: write`;
- aktuální `gh` přihlášení je platné, ale má scopes `gist`, `read:org`, `repo` a nemá
  `read:packages`; úplný privátní package inventory proto skončil očekávaným HTTP 403;
- v registrovaném Actions seznamu je pouze `Quality gate`; žádný image-publication run
  ani workflow zde není.

## STOP-1 – workflow není dispatchovatelný

Soubor `.github/workflows/staging-images.yml` existuje na kandidátu jako blob
`6c1ceb5ba995ef08831cfb892b0484440efaa4c8`, ale stejná cesta na defaultní větvi `main`
vrací z GitHub Contents API 404. GitHub vyžaduje, aby workflow s `workflow_dispatch`
existoval na defaultní větvi, teprve potom lze zvolit jinou branch přes `--ref`.

Zdroj: [GitHub – Manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

Pokus o dispatch současného souboru by proto nebyl funkční. Nebyl proveden ani zkušební
dispatch, rerun nebo alternativní event.

## STOP-2 – současný model by nezaručil private GHCR

Workflow se autentizuje `${{ secrets.GITHUB_TOKEN }}` z veřejného source repozitáře.
GitHub pro package vytvořenou workflow pomocí `GITHUB_TOKEN` uvádí, že standardně dědí
visibility a permission model repozitáře, ve kterém workflow běží. V tomto případě by
výchozí model byl public. Všechny čtyři Dockerfiles navíc obsahují
`org.opencontainers.image.source=https://github.com/modvolt/Site-Logbook`, takže package
je před prvním publikováním explicitně propojena s veřejným repozitářem.

Zdroje:

- [GitHub – package defaults for workflows](https://docs.github.com/en/enterprise-cloud@latest/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions#default-permissions-and-access-settings-for-packages-modified-through-workflows)
- [GitHub – package access and visibility](https://docs.github.com/en/enterprise-cloud@latest/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

Obecné pravidlo „první GHCR package je private“ platí pro běžný registry push, ale není
bezpečné jím přebít konkrétní workflow inheritance pravidlo. Navíc GitHub upozorňuje, že
jednou zveřejněnou package nelze změnit zpět na private. Nesmí proto vzniknout ani krátké
public okno s následnou opravou visibility.

## Zamýšlené registry objekty

Současný workflow by publikoval přesně tyto čtyři názvy, vždy jen pro `linux/amd64`:

```text
ghcr.io/modvolt/site-logbook-staging-preflight
ghcr.io/modvolt/site-logbook-staging-mailpit
ghcr.io/modvolt/site-logbook-staging-api
ghcr.io/modvolt/site-logbook-staging-web
```

Každý build používá SHA-pinned `docker/build-push-action`, `push: true`, BuildKit
`provenance: mode=max` a `sbom: true`. Výstupní `staging-images.json` má obsahovat source
SHA a čtyři `repository@sha256` reference a je uchován 30 dní jako Actions artifact.

Tyto kladné vlastnosti nezmírňují oba STOP blokátory. Manifest navíc nyní explicitně
neodmítá prázdný nebo neplatný digest, neověřuje GHCR namespace a není kryptograficky
ověřován před budoucím použitím.

## Další supply-chain mezery

- vstupní `expected_sha` se porovnává pouze s právě zvoleným `github.sha`; workflow
  neověřuje povolenou source větev, aktuální PR head ani úspěšný exact-SHA Quality gate;
- confirmation boolean není svázán s chráněným registry environmentem;
- BuildKit provenance a SBOM jsou OCI attestations, ale workflow nevytváří samostatnou
  GitHub-signed attestation ani ji před použitím neověřuje;
- stejný SHA tag lze znovu publikovat a některé build-time OS balíčky i runner zůstávají
  časově proměnlivé, takže source SHA sám negarantuje reprodukovatelný image digest;
- existující kontraktní testy ověřují hlavně počet výskytů a syntaktický tvar; nezachytí
  absenci workflow na default branch, public inheritance, vazbu na PR/Quality gate ani
  malformed digest output.

## Relevantní lokální kontroly

- `pnpm gate:staging-runtime`: **PASS**;
- `pnpm test:staging-contract`: **16/16 PASS**;
- runtime kontrakt potvrzuje čtyři immutable digest reference, `pull_policy: always`,
  celkový limit 2,25 CPU / 2304 MiB a zákaz host buildů;
- zelené syntaktické kontrakty nejsou důkazem reálné dispatchability nebo private
  visibility; právě tyto dvě mezery read-only live preflight odhalil.

## Doporučená oprava publikačního modelu

Doporučený model je oddělený soukromý publisher repozitář, například
`modvolt/site-logbook-registry`, nikoli vložení write tokenu do veřejného repozitáře:

1. vytvořit nový **private** repozitář s minimálním default-branch dispatch wrapperem;
2. source workflow převést na bezpečně volatelný, commit-pinned publication workflow nebo
   vložit ekvivalentní minimální workflow přímo do private publisheru;
3. buildovat pouze explicitní source SHA z `modvolt/Site-Logbook`, fail-closed ověřit PR
   head a úspěšný Quality gate;
4. pro GHCR publish použít krátkodobý `GITHUB_TOKEN` private publisher repozitáře s
   `packages: write`, nikoli dlouhodobý osobní write PAT;
5. přepsat OCI source label na private publisher repo a ponechat source commit jako
   revision/metadata, aby package nezdědila public visibility;
6. před publikací validovat čtyři image názvy, po buildu čtyři neprázdné SHA-256 digesty a
   secret-free manifest;
7. po prvním zápisu okamžitě read-only potvrdit `visibility=private`; při jakékoli odchylce
   zastavit další image a nikdy nepokračovat k deployi;
8. až později vytvořit pro Coolify samostatný PAT classic pouze s `read:packages` a uložit
   jej do Docker credential store správného OS uživatele na hostu, nikoli do Compose,
   source Git nebo auditní evidence.

Coolify dokumentuje registry login pod stejným OS uživatelem, který je nakonfigurován pro
server: [Coolify – Docker Registry](https://coolify.io/docs/knowledge-base/docker/registry).

## Negativní důkazy

- žádný workflow dispatch, rerun, image build, pull nebo push;
- žádný GHCR package write, delete, visibility change nebo token creation;
- žádný nový repozitář, větev, PR, commit na remote ani změna `main`;
- žádná změna GitHub Actions settings, environmentu, secrets nebo oprávnění;
- žádný kontakt s Coolify, Docker hostem, S3, DNS, stagingem ani produkcí;
- žádná DB, migrace, restore, backfill ani migrace `0100`.
