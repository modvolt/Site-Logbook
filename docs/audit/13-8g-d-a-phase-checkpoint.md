# FÁZE 13.8G-D-A – checkpoint

- **Datum:** 2026-08-04.
- **Stav:** **DOKONČENO READ-ONLY – REGISTRY PUBLICATION STOP**.
- **Source kandidát:** `01606ff564456f49ac9e3094c564917db023b977`.
- **Quality gate:** `completed/success`.
- **GHCR:** beze změny, žádná image nebyla publikována.
- **`main`:** beze změny na `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`.
- **Migrace `0100`:** nepřítomná, nedotčená a nespouštěná.

## Uložené výstupy

- [private registry preflight](13-8g-d-a-private-registry-preflight.md)
- [předchozí exact-SHA publication verification](13-8g-c-publication-verification.md)
- [předchozí checkpoint](13-8g-c-phase-checkpoint.md)

## Shrnutí

Read-only preflight zastavil publikaci před prvním registry zápisem. Image workflow není
na defaultní větvi a GitHub jej proto neregistruje pro `workflow_dispatch`. Současně by
`GITHUB_TOKEN` workflow běžící ve veřejném source repozitáři podle GitHub workflow
inheritance pravidel vytvořil public package model, což odporuje schválenému private GHCR
a nelze bezpečně napravit až po zveřejnění.

Čtyři plánované image mají správně omezenou architekturu `linux/amd64`, digest manifest,
BuildKit provenance/SBOM a source labels. Před registry write je ale nutné oddělit
publikační plane do private repozitáře a doplnit fail-closed vazbu source SHA → PR head →
Quality gate → čtyři validní private digesty.

## Nejasnosti a rozhodnutí potřebná od uživatele

- existence starších privátních packages v účtu `modvolt` není potvrzena, protože
  současný `gh` OAuth token nemá `read:packages`;
- vytvoření nového private publisher repozitáře je externí změna a potřebuje výslovné
  schválení;
- odstranění nebo bezpečné nahrazení současného public-repo dispatch workflow změní
  `.github/workflows/staging-images.yml` a vyžaduje nový exact-SHA Quality gate a push;
- vlastní GHCR zápis zůstane až třetím, samostatně schvalovaným krokem po ověření private
  publisheru; souhlas s opravou workflow nebude automaticky souhlasem k image pushi.

## Jednoznačný checkpoint

FÁZE 13.8G-D-A zde končí. Preflight je uložen, registry publication byla fail-closed
zastavena. Tento checkpoint neautorizuje vytvoření repozitáře, změnu workflow, push,
změnu PR, merge, workflow dispatch, GHCR package write, změnu visibility, vytvoření PAT,
Coolify login, image pull, runtime start, S3/DNS, secrets, DB, migraci `0100`, deploy ani
produkční zásah. Automaticky se nepokračuje do F13.8G-D-B.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.8G-D-B – implementace a ověření odděleného private publication
  plane, stále bez GHCR image zápisu;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** změna zasahuje GitHub Actions trust boundary, repo/package
  visibility a vazbu exact source SHA na registry artefakty; chyba by mohla image
  nevratně zveřejnit nebo publikovat z nesprávného commitu;
- **očekávané činnosti:** po výslovném souhlasu vytvořit minimální private publisher repo,
  upravit source publication workflow na bezpečný caller model nebo jej bezpečně přesunout,
  vynutit source repo/branch/PR/Quality gate, validní čtyři digesty a private source label,
  doplnit kontraktní testy, spustit quality/release gates a předložit nový exact commit
  rozsah k pushi; image workflow zatím nedispatchovat;
- **soubory, které budou pravděpodobně změněny:** ve source repozitáři
  `.github/workflows/staging-images.yml`, `scripts/check-staging-runtime-contract.mjs`,
  `scripts/test/staging-runtime-contract.test.mjs` a `docs/audit/13-8g-d-b-*`; v novém
  private publisher repozitáři minimální `.github/workflows/*` a bezpečnostní README;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** nesmí obsahovat DB,
  migraci `0100`, Coolify/S3/DNS, secrets hodnoty, image push/pull, deploy, merge ani
  produkční změnu. Může obsahovat výslovně schválené vytvoření private GitHub repozitáře,
  lokální workflow změny a později samostatně schválený Git push.

Před pokračováním musí uživatel upravit model/reasoning v rozhraní a výslovně napsat
`Schvaluji F13.8G-D-B: vytvoření private publisher repozitáře a úzkou opravu publication workflow, zatím bez GHCR image zápisu.`
