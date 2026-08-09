# Checkpoint R16-C3C3 – fail-closed predecessor publication gate

Datum: 2026-08-09

## Výsledek

**Implementační část R16-C3C3 je dokončena a ověřena. Žádný merge, GHCR zápis
ani deploy nebyl proveden.**

- veřejný reusable publisher byl zpřísněn v commitu
  `e7222e759b4ecf523defa0329d2dfd3fadd2c5eb`;
- všechny živé reference na reusable workflow byly následně připnuty na tento
  implementační commit v commitu
  `8985ce7f470a69b9dc5d2cd5f76734f003cf0e83`;
- veřejný draft PR
  [modvolt/Site-Logbook#15](https://github.com/modvolt/Site-Logbook/pull/15)
  zůstává otevřený, draft a nemergovaný;
- Quality gate pro přesný head `8985ce7f470a69b9dc5d2cd5f76734f003cf0e83`
  skončil `success`: run `31326558064`, job `93277761521`, všech 19 povinných
  kroků prošlo;
- privátní wrapper byl aktualizován jedinou změnou pinu v commitu
  `d4b8c9c95f4410c101cb480f8af39707c20960ee` a pushnut non-force do draft PR
  [modvolt/site-logbook-registry#2](https://github.com/modvolt/site-logbook-registry/pull/2);
- privátní wrapper je byte-for-byte shodný s veřejnou auditovanou template;
  SHA-256 obou souborů je
  `61aa49bdb033e5bc3a100d28e3a1251c8f4619591efc33e9362e8bdb16f24830`;
- PR #2 zůstává otevřený, draft a nemergovaný a jeho workflow nebylo spuštěno;
- produkce, Coolify, DB, S3, DNS, secrets, migrace a GHCR nebyly změněny.

Tento soubor je následný dokumentační commit. Jeho přesný public PR head musí mít
vlastní úspěšný Quality gate. Tento výsledek bude uložen jako GitHub check u PR
#15; po zeleném gate se head v této podfázi už nesmí změnit.

## Zpřísněný kontrakt

Publisher nyní před jakýmkoli možným zápisem fail-closed vyžaduje:

- úplné stránkování aktivních i viditelných smazaných GHCR verzí ve všech třech
  inventurních bodech;
- shodu agregovaného počtu aktivních verzí s `package.version_count`, nulový
  počet viditelných smazaných verzí a unikátní package/version ID, digesty a
  tagy;
- přesně jeden immutable SHA tag při verified-noop; vybraná verze se znovu načte
  podle ID a musí mít přesně jediný očekávaný tag;
- OCI index se dvěma unikátními deskriptory: jeden spustitelný `linux/amd64` a
  jeden na něj navázaný attestation manifest;
- runtime image labely, `BUILD_SHA`, Dockerfile, VCS revision/source a pinned
  base image digest svázané s fixním predecessor commitem;
- SLSA provenance v0.2 a obsahový SPDX 2.2/2.3 SBOM s package položkami a
  vazbou `CONTAINS` na existující package SPDXID;
- Buildx `v0.34.1` a BuildKit
  `moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f`;
- evidence schema v2 s počty inventury, toolchainem, runtime/provenance/SBOM
  údaji a následným secret-free verifierem.

Fixní zdroj zůstává
`c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3`, tree
`cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c`, přesně 104 migrací s tail
`0104_thin_sheva_callister`; `0100` ani `0105` nejsou součástí predecessor
image.

## Důkazy ověření

Lokálně prošlo:

- Prettier check změněných souborů;
- strict YAML parse s kontrolou duplicitních klíčů;
- cílená verifier/runtime-contract sada 26/26;
- `pnpm run check:staging-runtime-contract`;
- `pnpm run lint`;
- `git diff --check`.

Lokální Docker daemon nebyl dostupný, proto zde nešel spustit offline workflow
harness. Nejde o pozorovanou chybu kódu: přesný remote Quality gate následně
úspěšně provedl přípravu pinned harnessu i test staging guard/evidence/runtime
kontraktů včetně extrahovaných shell bloků, dále API DB sady, MinIO recovery,
šifrovaný backup/restore, object recovery a R14 full-stack/fault gate.

Nezávislé review nenašlo konkrétní blokující vadu v Bash/YAML/JQ kontraktu,
provenance, SBOM, OCI vazbě ani supply-chain pinech.

## Nejasnosti a blokátory

1. GHCR inventura je stále `UNKNOWN`. Současné přihlášení `gh` nemá
   `read:packages`; HTTP 403 nelze interpretovat jako neexistenci package nebo
   exact tagu.
2. GitHub API zpřístupňuje pouze viditelné smazané verze existujícího package.
   Zcela smazaný package nelze stejným dotazem bezpečně odlišit od namespace,
   který nikdy neexistoval. Evidence proto výslovně používá omezení
   `visible-package-versions-only` a neslibuje úplnou historickou absenci.
3. Privátní PR #2 není mergovaný a wrapper není dostupný na private `main`.
4. Merge PR #2 vyžaduje samostatný explicitní souhlas po nové live kontrole
   head/base/template hashů.
5. Pokud read-only inventura prokáže absenci exact tagu, jednorázový GHCR write
   vyžaduje další samostatný explicitní souhlas. Merge ani souhlas s inventurou
   zápis neautorizují.
6. Runtime baseline `0104`, staging backup/restore, aplikace `0105`, feature
   flag, Coolify staging a produkce jsou mimo tento checkpoint.

## Doporučení pro další spuštění

- další fáze: R16-C3C3 pokračování – autorizovaná read-only GHCR inventura a
  dokončení privátní no-deploy predecessor publication; zastavit před runtime
  baseline;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: další část pracuje s rozšířením oprávnění
  `read:packages`, merge privátního security workflow a případným jediným
  nevratným zápisem immutable image do privátního GHCR namespace;
- očekávané činnosti: obnovit `gh` scope pouze po souhlasu, úplně načíst aktivní
  i smazanou GHCR inventuru, revalidovat exact public/private heads a zelený
  check, po samostatném souhlasu mergovat pouze PR #2, po dalším samostatném
  souhlasu případně dispatchovat fixní wrapper, stáhnout a ověřit manifest,
  provenance, SBOM, digest a checksum a zastavit bez deploye;
- soubory, které budou pravděpodobně změněny: žádný produkční soubor; v private
  repo se připravený `.github/workflows/publish-staging-predecessor.yml` může
  pouze mergovat. Při autorizované publikaci vznikne GitHub Actions artifact a
  nejvýše jedna GHCR package verze;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: DB migrace,
  Coolify a deploy jsou zakázány. Rizikové jsou změna auth scope, merge
  privátního workflow a případný nevratný GHCR package write; každý krok musí
  být zvlášť autorizován a kontrolován fail-closed.

## Stop

Checkpoint R16-C3C3 je vytvořen. GHCR inventura, merge privátního PR, publisher
dispatch, runtime baseline ani deploy se v tomto spuštění automaticky
nezahajují.
