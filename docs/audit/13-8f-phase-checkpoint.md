# FÁZE 13.8F – checkpoint

- **Datum:** 2026-08-03.
- **Stav:** **DOKONČENO – CODE PUBLICATION PASS / QUALITY GATE PASS**.
- **Publikované SHA:** `aacb767be933e3589b40066f33d8ee0bac8939f4`.
- **Remote větev:** `agent/phase13-staging-gate`.
- **PR:** [#1](https://github.com/modvolt/Site-Logbook/pull/1), otevřený draft.
- **Quality run:** [30829378906](https://github.com/modvolt/Site-Logbook/actions/runs/30829378906), `completed/success`.
- **`main`:** beze změny na `a25c3128e317c7efe6feaa3a6a8a40eecd6cdc0f`.
- **Migrace `0100`:** nepřítomná, nedotčená a nespouštěná.

## Uložené výstupy

- [publikační evidence F13.8F](13-8f-publication-verification.md)
- [předchozí F13.8E runtime hardening](13-8e-staging-runtime-hardening.md)
- [předchozí F13.8E checkpoint](13-8e-phase-checkpoint.md)

## Shrnutí

Po novém úzkém souhlasu byly na existující staging PR větev fast-forward publikovány
přesně čtyři lokálně ověřené commity `179a8dd` až `aacb767`. Remote head i následný
`git ls-remote` potvrzují plné SHA `aacb767be933e3589b40066f33d8ee0bac8939f4`.
PR zůstal otevřený, draft a nemergeovaný; `main` se nezměnil.

Automatický exact-SHA `Quality gate` run `30829378906` skončil `success`. Prošly
quality/release gate, nové staging runtime kontrakty, izolované PostgreSQL suites a
šifrovaný MinIO recovery drill včetně úklidu test targetu. GitHub connector po dokončení
potvrdil stejný PR head.

Nebyl spuštěn manuální image workflow, GHCR zápis, Coolify/S3/DNS provisioning, deploy,
staging runtime, produkční změna, secret operace ani migrace. Lokální neplatný `gh` token
zůstal nedotčen; push použil jen existující repository deploy key v prostředí jediného
příkazu bez změny Git konfigurace.

## Nejasnosti a blokery

- architektura Coolify hostu není v tomto checkpointu potvrzena jako `linux/amd64`;
- není rozhodnutá public/private visibility čtyř GHCR packages ani případný
  staging-only read credential;
- image publication nemá nový výslovný souhlas;
- AWS/provider a user-owned origin stále blokují provisioning a první deploy;
- `gh auth status` hlásí neplatný lokální token, ale tento stav neblokoval přesný push
  repository deploy klíčem a nebyl v této fázi měněn.

## Jednoznačný checkpoint

FÁZE 13.8F zde končí. Code-only publication a exact-SHA GitHub Quality gate jsou hotové.
Tento checkpoint neautorizuje `staging-images.yml`, GHCR package write, změnu package
visibility, vytvoření pull credentialu, Coolify/S3/DNS provisioning, vložení secrets,
image pull, start služby, DB nebo migrace, deploy, PR merge ani produkční zásah.
Automaticky se nepokračuje do F13.8G.

## Doporučení pro další spuštění

- **další fáze:** FÁZE 13.8G – image publication gate bez deploye; read-only potvrdit
  architekturu hostu a GHCR visibility/pull model, získat samostatný souhlas k registry
  zápisu a teprve poté případně spustit `staging-images.yml` pro exact SHA `aacb767…`;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** xhigh;
- **důvod použití této úrovně:** jde o supply-chain a externí registry zápis, kde musí
  zůstat shodné source SHA, OCI revision, čtyři digesty, SBOM/provenance a následný
  secret-free manifest, současně bez nechtěného deploye nebo zpřístupnění privátního
  balíčku;
- **očekávané činnosti:** read-only ověřit `linux/amd64`, repo/package oprávnění a
  public/private pull strategii; připravit přesný workflow dispatch scope; vyžádat nový
  souhlas; po souhlasu spustit pouze image workflow pro `aacb767…`, sledovat buildy a
  ověřit čtyři `repository@sha256` reference, provenance/SBOM a absenci deploye;
- **soubory, které budou pravděpodobně změněny:** při čistém úspěchu pouze
  `docs/audit/13-8g-*`; při selhání workflow pouze přesně identifikovaný Dockerfile nebo
  `.github/workflows/staging-images.yml` po nové úzké autorizaci;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** nesmí obsahovat
  DB, migraci `0100`, Coolify/S3/DNS provisioning, secrets, runtime start, deploy, merge
  ani produkční změnu. Může obsahovat výslovně schválený externí GHCR registry zápis a
  případně změnu package visibility nebo staging-only pull credential, což jsou rizikové
  a samostatně autorizované změny.

Před pokračováním musí uživatel upravit model/reasoning v rozhraní a výslovně napsat
`Pokračuj další fází`.
