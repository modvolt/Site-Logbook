# Checkpoint R16-C3C3C-A – read-only GHCR inventura

Datum: 2026-08-09

## Výsledek

**R16-C3C3C-A je dokončena se stavem `PREPARED, WRITE NOT AUTHORIZED`.**

Byl doplněn pouze dříve výslovně schválený OAuth scope `read:packages` účtu
`modvolt` a následně provedena vyčerpávající read-only inventura GHCR. Workflow
dispatch ani GHCR zápis nebyly provedeny. Produkce, Coolify, DB, S3, DNS,
secrets, migrace a aplikační kód zůstaly beze změny.

Centrální registr a přesné identifikátory jsou v
[16-c3-staging-preflight-verification.md](16-c3-staging-preflight-verification.md#r16-c3c3c-a--read-only-ghcr-inventura).

## Živě ověřený stav

- GitHub účet: `modvolt`, aktivní scopes `gist`, `read:org`, `read:packages`,
  `repo`, `workflow`;
- aktivní kontejnerové packages účtu: `0` po úplném stránkování;
- aktivní target `site-logbook-staging-api`: `0`;
- aktivní exact predecessor tag
  `c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3`: `0`;
- target metadata, active-version a deleted-version endpoint: `404 Package not
found`;
- private `main`: `9dbc048e4597eaf9ac9d4dd5d799406e1d9ddafc`;
- private wrapper: aktivní workflow ID `330628153`, přesně `0` běhů;
- wrapper SHA-256:
  `61aa49bdb033e5bc3a100d28e3a1251c8f4619591efc33e9362e8bdb16f24830`;
- wrapper je bajtově shodný s veřejnou auditovanou šablonou a připíná reusable
  workflow na `e7222e759b4ecf523defa0329d2dfd3fadd2c5eb`;
- public PR #15: open, draft, unmerged, exact head
  `daff5f9fb38545ed16c1577713def690cb85a5c6`;
- exact-head Quality run `31333804818`: `completed/success`, event
  `pull_request`, attempt `1`.

GitHub Actions policy privátního repozitáře obecně povoluje všechny actions a
nevynucuje SHA pinning na platformní úrovni. Toto není rozšíření publisheru:
konkrétní wrapper i volaný reusable workflow zůstávají commit-pinned a jejich
statický kontrakt je testován fail-closed.

## Provedené kontroly

- GHCR `/user/packages` bez filtru viditelnosti: jedna úplná stránka, `0`
  kontejnerových packages;
- GHCR `/user/packages` s `visibility=private`: jedna úplná stránka, `0` packages;
- veřejný `/users/modvolt/packages`: jedna úplná stránka, `0` packages;
- přímé target endpointy: očekávaný `404 Package not found`;
- registrace wrapperu přes stabilní workflow ID: active, `0` runs;
- byte/hash/template/pin/ancestor kontrola wrapperu: PASS;
- public PR a exact-head Quality evidence kontrola: PASS;
- `node --test scripts/test/staging-predecessor-image.test.mjs scripts/test/staging-runtime-contract.test.mjs`:
  28/28 PASS;
- `pnpm.cmd gate:staging-runtime`: PASS;
- Docker nebyl spuštěn a systémové prostředky nebyly zatíženy těžkým harness
  během.

## Nejasnosti a zbývající hranice

1. GitHub REST neumí přes aktivní package list prokázat, že zcela smazaný package
   nikdy historicky neexistoval. Nulový wrapper ledger tento residual risk
   zmenšuje, ale nevylučuje hypotetický dřívější zápis jiným registry klientem.
2. Exact predecessor image zatím neexistuje; bez ní nelze provést baseline
   `0104`, novou staging zálohu ani restore evidence.
3. Uživatel výslovně neschválil workflow dispatch ani GHCR zápis. Tato fáze je
   neautorizuje.
4. Migrace `0100` zůstává nezařazena. Tato fáze neautorizuje `0105`, feature
   flag, deploy ani změnu produkce.

## Doporučení pro další spuštění

- další fáze: R16-C3C3C-B – po novém samostatném výslovném souhlasu provést
  nejvýše jeden fixed predecessor publisher dispatch z private `main`, ověřit
  immutable artifact a zastavit bez deploye;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: fáze může vytvořit první prakticky nevratnou GHCR
  package verzi a musí přesně ověřit source commit/tree, jediný `linux/amd64`
  runnable digest, provenance, SBOM, package/version ID a checksums;
- očekávané činnosti: bezprostředně zopakovat aktivní i deleted inventuru,
  ověřit stále nulový počet publisher běhů a exact public CI/private wrapper,
  po výslovném schválení zadat přesnou confirmation frázi, sledovat jediný běh
  a nezávisle validovat artifact i registry manifest;
- soubory, které budou pravděpodobně změněny: pouze nový auditní checkpoint;
  externě může vzniknout Actions evidence artifact a jedna privátní GHCR verze;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: DB migrace,
  deploy a produkční změny zůstávají zakázány. Jedinou rizikovou změnou může být
  nově výslovně schválený, append-only GHCR zápis.

## Stop

Checkpoint R16-C3C3C-A je vytvořen. Publisher zůstává nespouštěný a GHCR beze
změny.
