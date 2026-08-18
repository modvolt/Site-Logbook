# FÁZE 13.8G-C – checkpoint

- **Datum:** 2026-08-03.
- **Stav:** **DOKONČENO – EXACT-SHA REMOTE QUALITY GATE PASS**.
- **Publikovaný kandidát:** `01606ff564456f49ac9e3094c564917db023b977`.
- **Remote větev:** `origin/agent/phase13-staging-gate` na přesném kandidátu.
- **Quality gate:** [run 30856976202](https://github.com/modvolt/Site-Logbook/actions/runs/30856976202), `completed/success`.
- **PR #1:** otevřený, draft, nesloučený; head přesně `01606ff…`.
- **`main`:** beze změny na `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`.
- **Migrace `0100`:** nepřítomná, nedotčená a nespouštěná.

## Uložené výstupy

- [publication verification](13-8g-c-publication-verification.md)
- [předchozí dependency remediation](13-8g-b-dependency-remediation.md)
- [předchozí checkpoint](13-8g-b-phase-checkpoint.md)

## Shrnutí

Výslovně schválený lineární rozsah pěti commitů `25ea531…01606ff` byl publikován jediným
non-force exact-refspec pushem. Vzdálený head, PR head a CI source SHA jsou shodné na
`01606ff564456f49ac9e3094c564917db023b977`; `main` se nezměnil. Nezávislé read-only
kontroly potvrdily stav před i po dokončení CI.

Nový exact-SHA Quality gate skončil zeleně. Prošly quality/release gates, staging
kontrakty, izolované databázové sady i šifrovaný recovery drill proti dočasnému MinIO a
všechny testovací kontejnery byly uklizeny. Nebyl publikován image ani spuštěn deploy.

## Nejasnosti a zbývající gate

- ručně psaný popis PR má zastaralý textový Head SHA, přestože autoritativní PR metadata
  a CI jsou správné; jeho oprava je další samostatná GitHub mutace;
- před prvním registry zápisem je nutné read-only potvrdit privátní GHCR package model,
  oprávnění workflow a pull přístup pro budoucí Coolify staging;
- samotné spuštění `staging-images.yml` vytvoří čtyři externí registry objekty a vyžaduje
  nový výslovný souhlas k GHCR write na exact source SHA `01606ff…`;
- Coolify deploy, staging runtime, S3, DNS, secrets, DB restore a smoke zůstávají za
  pozdějšími samostatnými gates.

## Jednoznačný checkpoint

FÁZE 13.8G-C zde končí. Exact-SHA push a odpovídající vzdálený Quality gate jsou hotové.
Tento checkpoint neautorizuje změnu PR popisu, workflow dispatch, GHCR package write,
změnu package visibility, image pull, Coolify/S3/DNS provisioning, vložení secrets,
runtime start, databázi, migraci `0100`, restore/backfill, staging smoke, deploy, merge
ani produkční zásah. Automaticky se nepokračuje do F13.8G-D.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.8G-D – privátní GHCR image publication gate pro přesný source
  SHA `01606ff…`, bez deploye;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** jde o externí supply-chain registry zápis čtyř image,
  kde je nutné svázat source SHA, linux/amd64 build, privátní viditelnost, digest,
  provenance, SBOM a pull oprávnění bez spuštění image nebo deploye;
- **očekávané činnosti:** read-only ověřit GHCR model a workflow oprávnění, aktualizaci
  zastaralého PR popisu řešit jen po samostatném souhlasu, předložit přesný plán čtyř
  package zápisů, vyžádat výslovný souhlas k registry write, dispatchnout
  `staging-images.yml` pouze pro `01606ff…`, ověřit čtyři privátní immutable digesty,
  provenance/SBOM a secret-free manifest bez pullu nebo spuštění image;
- **soubory, které budou pravděpodobně změněny:** při čistém průchodu pouze
  `docs/audit/13-8g-d-*`; `.github/workflows/staging-images.yml` nebo Dockerfile pouze po
  novém úzkém schválení, pokud preflight odhalí konkrétní chybu;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** nesmí obsahovat DB,
  migraci `0100`, secrets, Coolify/S3/DNS, image pull, runtime start, deploy, merge ani
  produkční změnu. Bude obsahovat výslovně schválený GHCR registry write, což je externí
  a auditovatelná změna s novými privátními package objekty.

Před pokračováním musí uživatel upravit model/reasoning v rozhraní a výslovně napsat
`Pokračuj další fází`.
