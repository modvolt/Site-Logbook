# Checkpoint R16-C3C2 – remote candidate a privátní predecessor wrapper

Datum: 2026-08-09

## Výsledek

**R16-C3C2 je dokončena bez deploye a bez zápisu do GHCR.**

- veřejná větev `agent/phase16c3-staging-preflight` byla publikována non-force;
- veřejný draft PR [modvolt/Site-Logbook#15](https://github.com/modvolt/Site-Logbook/pull/15)
  zůstává otevřený, draft a nemergovaný;
- přesný implementační head `2290b33fcbddac537093ac675cdab9571131cc10`
  má úspěšný Quality gate run `31323046140`, job `93268923493`;
- privátní větev `agent/phase16c3-predecessor-wrapper` vznikla z
  `main@aeec7c4331c2305525b78a069352da587264c08d`;
- privátní draft PR
  [modvolt/site-logbook-registry#2](https://github.com/modvolt/site-logbook-registry/pull/2)
  obsahuje přesně jeden soubor a head
  `96fec7f524cc78792ee4cac210341de2d01d5754`;
- privátní workflow nebylo spuštěno. Produkce, Coolify, DB, S3, DNS, secrets,
  migrace a existující GHCR package verze nebyly změněny.

Tento checkpoint je následný dokumentační commit. Po jeho publikaci musí mít
nový finální public PR head vlastní úspěšný exact-SHA Quality gate; výsledek se
uloží jako GitHub check u PR #15 a už se nesmí zneplatnit dalším commitem.

## Úzká CI remediation

První PR běh správně selhal v `pnpm audit --audit-level=moderate` na čtyřech
nově evidovaných advisories. Schválená oprava změnila pouze:

- `dompurify 3.4.12 -> 3.4.13`;
- `js-yaml 4.3.0 -> 4.3.1`;
- `nanoid 3.3.16 -> 3.3.17`;
- `pdfjs-dist 6.1.200 -> 6.2.108`;
- odpovídající manifest a lockfile.

Žádná aplikační logika ani migrace nebyla změněna.

## Důkazy ověření

Lokálně prošlo:

- `pnpm install --frozen-lockfile`;
- `pnpm gate:quality` včetně výsledku `No known vulnerabilities found`;
- PDF regresní sada 4 soubory / 17 testů;
- API build a typecheck;
- frontend production build s `BASE_PATH=/` a typecheck;
- Orval codegen a kontrola nulového generated driftu;
- `git diff --check`.

Remote Quality gate na `2290b33...` prošel za 8 min 45 s včetně:

- frozen install, quality a hermetic release gate;
- immutable staging runtime, pinned workflow harness a staging kontraktů;
- fail-closed external schema preflightu;
- izolovaných API DB testů;
- šifrovaného backup/restore a object recovery drillu;
- R14 full-stack/fault gate.

Privátní wrapper:

- je byte-for-byte shodný s auditovanou public template; SHA-256 je
  `aa7ca6f356a46a4c5d23f405f75dc003d2feed7cd5b728e9d1c543e8ecc5549a`;
- prošel YAML parse a kontrolou požadovaných jobů;
- odkazuje na vzdáleně dosažitelný public reusable workflow na přesném commitu
  `a66bc2fcf5e0dd0dfbd45c450783b12d61c1c10f`;
- povoluje pouze ruční dispatch z private `main`, vlastníka `modvolt` a
  přesnou no-deploy potvrzovací frázi;
- má `packages: write` pouze na jediném reusable publikačním jobu.

## Nejasnosti a blokátory

1. Privátní PR #2 není mergovaný a workflow proto není dostupné z
   `refs/heads/main`.
2. GHCR inventura je stále `UNKNOWN`: lokální `gh` token nemá
   `read:packages`. Absenci nebo existenci exact predecessor tagu nelze z 404
   bezpečně dovodit.
3. GHCR predecessor workflow nebylo autorizováno ani spuštěno. PR #2 ani PR #15
   se nesmí mergovat nebo dispatchovat automaticky.
4. Runtime baseline cesta pro produkční kopii na exact `0104`
   (`apply-0104-baseline`, oddělený binding/checksum, fresh backup a restore
   evidence) ještě není implementována.
5. Aplikace `0105`, restart stagingu, feature flag, pilotní externí účet a
   produkce zůstávají mimo dokončenou podfázi.

## Doporučení pro další spuštění

- další fáze: R16-C3C3 – autorizované dokončení privátní no-deploy predecessor
  publikace a důkaz immutable GHCR stavu; bez Coolify deploye;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: fáze obsahuje merge privátního security workflow,
  rozšíření package-read oprávnění, fail-closed inventuru existujícího GHCR
  namespace a jednorázový package write, který nesmí vytvořit duplicitní nebo
  zaměnitelný image tag;
- očekávané činnosti: ověřit finální exact-SHA check PR #15, získat autorizovanou
  read-only GHCR inventuru, zkontrolovat PR #2 a jeho přesný diff, po samostatném
  výslovném souhlasu mergovat pouze PR #2 do private `main`, ručně spustit
  wrapper s přesnou frází, ověřit jediný `linux/amd64` predecessor digest,
  provenance/SBOM/manifest/checksum a zastavit bez deploye;
- soubory, které budou pravděpodobně změněny: v public repo žádný produkční
  soubor; v private repo již připravený
  `.github/workflows/publish-staging-predecessor.yml` se může pouze mergovat.
  Vzniknou GitHub Actions artefakty a jedna autorizovaná GHCR package verze;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: nesmí aplikovat
  DB migraci, měnit Coolify, staging ani produkci. Obsahuje však rizikový merge
  privátního workflow, změnu autentizačních scopes a nevratný GHCR package write;
  každý z těchto kroků vyžaduje samostatnou explicitní autorizaci a fail-closed
  kontrolu exact tagu.

## Stop

Checkpoint R16-C3C2 je vytvořen. R16-C3C3, GHCR publication ani runtime baseline
se v tomto spuštění automaticky nezahajují.
