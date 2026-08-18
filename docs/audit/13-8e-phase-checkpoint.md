# Checkpoint FÁZE 13.8E – staging capacity a reproducibility hardening

- **Datum:** 2026-08-03.
- **Stav podfáze:** **COMPLETE**.
- **Verdikt:** **LOCAL HARDENING PASS / REMOTE PUBLICATION BLOCKED**.
- **Výchozí lokální SHA:** `3b5ac57bbc9b7630e015dbb804db0f9e19f14de2`.
- **Výchozí publikované staging SHA:**
  `7f4bd719c951dffd58f7697253156c3cb7146b23`.
- **Produkce/externí systémy:** bez přístupu a beze změny.
- **Migrace 0100:** nedotčená, nepřítomná a nadále vyloučená.

## Uložené výstupy

- [centrální F13.8E evidence](13-8e-staging-runtime-hardening.md)
- [předchozí F13.8D decision gate](13-8d-provider-origin-capacity-decision.md)
- pull-only runtime: `docker-compose.staging.yml`
- statický gate: `scripts/check-staging-runtime-contract.mjs`
- manuální no-deploy publish workflow: `.github/workflows/staging-images.yml`

## Shrnutí

Staging runtime už na Coolify hostu nic nebuildí. Vlastní preflight, Mailpit, API a web
images musí přijít jako plné `repository@sha256` reference z odděleného manuálního GHCR
workflow. PostgreSQL a všechny Dockerfile base images včetně Dockerfile frontend jsou
připnuté na registry digest. API/web build používá stejný `pnpm@11.9.0` jako repozitář a
CI a images nesou exact revision OCI label.

Všech pět služeb má explicitní CPU/RAM limit a reservation; celkem 2,25 CPU, 2304 MiB
hard RAM a 1536 MiB reservation. Syntetická Compose normalizace potvrdila pět služeb,
nulový počet build definic a immutable image reference.

Nový fail-closed kontrakt i negativní testy jsou zapojené do GitHub Quality workflow.
Manuální image workflow vyžaduje přesný SHA a potvrzení, publikuje čtyři linux/amd64
images s SBOM/provenance a vytvoří secret-free digest manifest; neobsahuje deploy.
Workflow nebyl spuštěn a nic nebylo pushnuto.

Lokálně prošel přesný `gate:quality`, všechny hermetické child kroky release gate,
typecheck, 18 bezpečnostních testů, 127 frontend testů, 15 live-events testů, 316 API
testů, oba buildy, staging E2E typecheck, Compose config, 16 staging kontraktů a čtyři
Dockerfile checks. Audit threshold prošel s jedním low advisory. GitHub exact-SHA gate,
DB suite, MinIO drill a skutečný image build/push zůstávají neprovedené.

## Nevyřešené otázky

1. Je Coolify host potvrzeně `linux/amd64`?
2. Budou čtyři GHCR packages public, nebo Coolify dostane samostatný staging-only
   read token?
3. Která remote staging PR branch má dostat lokální F13.8D/F13.8E commity?
4. Má owner dostupný a schválený AWS účet, nebo požaduje Hetzner SSE-C workstream?
5. Jaký user-owned origin bude použit; případně bude výslovně schválen dočasný
   `sslip.io` waiver?

První tři otázky blokují image publication/deploy. Poslední dvě stále blokují resource
provisioning, ne publikaci kódu.

## Jednoznačný checkpoint

FÁZE 13.8E zde končí. Lokální code-only hardening je hotový a otestovaný. Tento
checkpoint neautorizuje push, PR merge, workflow dispatch, registry publication,
Coolify/S3/DNS provisioning, vložení secrets, image pull, start služby, DB test nad
stagingem, migrace ani deploy. Automaticky se nepokračuje do F13.8F.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.8F – publication gate pouze pro kód; ověřit cílovou staging
  PR branch, pushnout lokální checkpoint commit po novém výslovném souhlasu a čekat na
  exact-SHA GitHub Quality gate; ještě nespouštět `staging-images.yml` ani deploy;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** high;
- **důvod použití této úrovně:** změny jsou lokálně zelené, ale je nutné bezpečně
  oddělit Git push/CI od následného registry zápisu a ověřit, že remote gate běží nad
  přesně stejným SHA bez přimíchání produkčního diffu;
- **očekávané činnosti:** ověřit branch/PR mapping a remote head, zkontrolovat staged
  scope, získat úzký push souhlas, pushnout pouze F13.8D/F13.8E commit chain, vyčkat na
  `Quality gate`, ověřit commit SHA a check závěr a uložit publication evidence; při CI
  chybě jen diagnostikovat nebo provést úzkou opravu v nové podfázi;
- **soubory, které budou pravděpodobně změněny:** při čistém úspěchu pouze
  `docs/audit/13-8f-*`; při selhání CI jen přesně identifikovaný workflow/test soubor po
  nové úzké autorizaci;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** nesmí obsahovat
  DB ani migraci `0100`, registry image publication, Coolify/S3/DNS provisioning,
  production změnu, secrets, build na shared hostu ani deploy. Rizikovou externí změnou
  je pouze schválený Git push a spuštění CI; image publication patří do pozdějšího
  samostatně schváleného gate.

Před pokračováním musí uživatel upravit model/reasoning v rozhraní a výslovně napsat
„Pokračuj další fází“.
