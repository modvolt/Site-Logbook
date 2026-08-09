# Checkpoint R16-C3C4A – řídicí vrstva baseline schématu `0104`

Datum: 2026-08-09

## Výsledek

**R16-C3C4A je implementována a lokálně ověřena jako pouze kódová, fail-closed
příprava. Žádný workflow dispatch, GHCR zápis, Docker baseline, DB migrace,
staging deploy ani zásah do produkce nebyl proveden.**

Implementační commit je
`ac04a9d2c8c761bd05e8183c8d2da0fa89e61ce3`.

Řídicí vrstva nyní:

- vytváří kanonický secret-free binding kandidátní image, observed staging
  provisioning, čerstvého obnoveného backupu a fixní predecessor API image;
- přijímá pouze auditovaný predecessor source
  `c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3`, tree
  `cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c` a přesný tail
  `0104_thin_sheva_callister`;
- vyžaduje izolovanou staging DB, `productionTargetsTouched=false`, vypnuté
  externí účty, přesný candidate image digest a odlišný predecessor image
  digest;
- zapisuje vstupní artefakty a jejich checksum atomicky, exkluzivně a bez
  přepsání existující evidence;
- přidává tři ruční, profile-only Compose služby: candidate preflight, fixní
  predecessor migrator a candidate postflight;
- povolí migrátor pouze při přesném journal prefixu před `0104`; přesné `0104`
  je ověřený no-op, drift, `0100`, `0105` nebo jiná identita jsou tvrdý stop;
- čtyřikrát ověřuje, že v izolovaném Compose projektu běží pouze `postgres`;
- po operaci vyžaduje přesně 104 migrací, tail `0104`, čerstvý svázaný backup,
  nulový externí stav a stále vypnutý feature flag;
- ukládá secret-free execution evidence atomicky a výslovně uvádí
  `authorizes0105=false` a požadavek na novou exact-0104 zálohu s restore testem.

Primární `STAGING_SCHEMA_ACTION` po celou dobu zůstává `inspect`. Confirmation pro
budoucí `0105` zůstává prázdná a migrace `0100` není zařazena.

## Změněná plocha

- nový DB kontrakt `lib/db/src/staging-baseline-0104.ts` a jeho package export;
- nový candidate API one-shot vstup
  `artifacts/api-server/src/external-schema-baseline-0104.ts`;
- nový binding generátor `scripts/check-staging-baseline-0104-binding.mjs`;
- nový ruční host runner `scripts/run-staging-baseline-0104.mjs`;
- tři profile-only služby v `docker-compose.staging.yml`;
- nové binding/runner/mutation testy, rozšířený runtime kontrakt, příklady env a
  staging schema runbook.

Nezměnil se produkční Coolify resource, produkční DB, S3, DNS, secrets ani GHCR.

## Provedené kontroly

- cílené Node testy bindingu, runneru a runtime kontraktu: 29/29 PASS;
- cílená DB schema/baseline sada: 17/17 PASS;
- `pnpm gate:staging-runtime`: PASS;
- `pnpm run typecheck:libs`: PASS;
- `pnpm --filter @workspace/api-server typecheck`: PASS;
- `pnpm --filter @workspace/api-server build`: PASS; vznikl také nový
  `dist/external-schema-baseline-0104.mjs`;
- strict YAML parse s unikátními klíči: PASS;
- `pnpm gate:quality`: PASS; lint, peer dependency check a dependency audit bez
  známých zranitelností od úrovně moderate;
- `git diff --check`: PASS.

Celá `pnpm test:staging-contract` sada skončila 68 PASS a 10 FAIL. Všech deset
neúspěchů má jedinou environmentální příčinu: lokálně chybí pinned offline image
`site-logbook/workflow-harness:alpine-3.22.1-7b2d54e4ed3722df` a Docker daemon
neběží. Nové baseline testy i všechny bez-Dockerové staging kontroly prošly.
Docker Desktop nebyl kvůli stabilitě počítače spuštěn; nejde o pozorovanou chybu
baseline kódu. Po pushi musí přesný finální head projít vzdáleným Quality gate,
který pinned harness připravuje.

## Nejasnosti a zbývající hranice

1. Fixní predecessor image zatím nebyla publikována. Private wrapper je na
   private `main`, ale uživatel dosud neschválil workflow dispatch ani případný
   GHCR zápis.
2. Kódová existence runneru není oprávnění jej spustit. Live R16-C3C4B bude
   vyžadovat samostatný souhlas, immutable candidate/predecessor manifesty,
   observed provisioning a čerstvý staging-only backup/restore důkaz.
3. Před live baseline musí být v izolovaném Compose projektu jedinou běžící
   službou `postgres`; běžící API, web nebo jiná služba operaci zablokuje.
4. Po dosažení exact `0104` je povinná nová šifrovaná staging-only záloha a její
   restore test. Teprve jejich nové ID může vstoupit do samostatného bindingu pro
   `0105`.
5. Tato podfáze neautorizuje `0105`, feature flag, Coolify staging deploy ani
   jakoukoli produkční změnu. Migrace `0100` zůstává výslovně nezařazená.

## Doporučení pro další spuštění

- další fáze: R16-C3C3C – po novém samostatném výslovném souhlasu jednorázově
  dispatchovat fixed predecessor publisher z private `main`, ověřit GHCR
  stavový automat a uložit immutable evidence; bez deploye a bez migrace;
- doporučený model: GPT-5.6 Sol;
- doporučený reasoning: xhigh;
- důvod použití této úrovně: další část může provést první externí a prakticky
  nevratný GHCR zápis a musí přesně ověřit source/tree, jediný `linux/amd64`
  digest, provenance, SBOM, package/version ID a auditní checksum;
- očekávané činnosti: znovu ověřit veřejný exact-head zelený CI, private wrapper
  na přesném `main`, nulové aktivní publisher runy a aktuální aktivní i viditelně
  smazanou GHCR inventuru; teprve po explicitní autorizaci spustit workflow s
  přesnou frází, sledovat jediný běh, stáhnout a nezávisle ověřit evidence;
- soubory, které budou pravděpodobně změněny: žádný produkční soubor; pouze nový
  veřejný auditní checkpoint. GitHub Actions může vytvořit privátní GHCR package
  verzi a evidence artifact;
- zda další fáze může obsahovat migrace nebo jiné rizikové změny: nesmí obsahovat
  DB migraci ani deploy. Může obsahovat jediný výslovně schválený externí GHCR
  zápis, pokud exact tag před spuštěním chybí.

## Stop

Checkpoint R16-C3C4A je vytvořen. Řídicí vrstva je připravena, ale publisher,
runtime baseline, `0105`, deploy i produkce zůstávají zastavené za samostatnými
schvalovacími branami.
