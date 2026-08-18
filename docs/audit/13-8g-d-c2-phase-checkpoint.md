# FÁZE 13.8G-D-C2 – checkpoint

- **Datum:** 2026-08-04.
- **Stav:** **DOKONČENO – EXECUTABLE WORKFLOW PROOF, BEZ PRODUKČNÍHO DOPADU**.
- **Rodič:** `6dddd64676631fffca6aef9baf74d79b127f8a01`.
- **Ověřený implementační head:** `1a2ae900e3d4dea033bb17f5067597177e43bbf5`.
- **Draft PR:** [#2](https://github.com/modvolt/Site-Logbook/pull/2), stacked na
  `agent/phase13-staging-gate`.
- **Exact-SHA GitHub gate:** [30871725613](https://github.com/modvolt/Site-Logbook/actions/runs/30871725613),
  `completed/success`.
- **GHCR / deploy / produkce:** beze změny.
- **Migrace `0100`:** nepřítomná, nepřidaná a nespouštěná.

## Uložené výstupy

- [spustitelná verifikace publikačního workflow](13-8g-d-c2-offline-workflow-verification.md)
- `scripts/workflow-execution-harness.mjs`
- `scripts/prepare-workflow-execution-harness.mjs`
- `scripts/test/staging-workflow-execution.test.mjs`
- `deploy/test/workflow-harness/Dockerfile`

## Shrnutí

Publisher workflow již není chráněn jen textovým kontraktem. Jeho přesné Bash skripty jsou
spouštěny v no-egress Docker harnessu proti všem 32 stavům dvoustupňové publikace a proti
TOCTOU, API, digest, platform, provenance, SBOM a attestation chybám. Remote verifier je
fail-closed pro jediný OCI `linux/amd64` runnable manifest a jedinou správně navázanou
attestation.

Lokální Docker/Postgres požadavek byl splněn: 141/141 izolovaných DB souborů prošlo proti
novému tmpfs Postgres kontejneru na loopback portu `15432`; kontejner byl po testu odstraněn.
GitHub Linux gate pro exact implementation head je kompletně zelený.

## Nevyřešené otázky

- bez read-only `read:packages` není potvrzen úplný výchozí GHCR inventory;
- reálný první private GHCR preflight, visibility a serverové attestations zůstávají
  samostatným rizikovým krokem vyžadujícím výslovné schválení;
- draft PR #1 ani stacked PR #2 se v této fázi nemají mergovat;
- R14 browserový důkaz dvou karet, identity, offline replay a service-worker update ještě
  nebyl proveden.

## Jednoznačný checkpoint

FÁZE 13.8G-D-C2 zde končí. Tento checkpoint neautorizuje merge PR #1 nebo #2, spuštění
private publisheru, GHCR zápis/pull/delete, změnu visibility, vytvoření package tokenu,
Coolify, DNS, S3, staging deploy, produkční přístup, DB restore, backfill ani migraci `0100`.
Produkční Site Logbook zůstal beze změny.

## Doporučení pro další spuštění

- **další fáze:** FÁZE R14-A – lokální real-browser PWA identity/offline isolation pack;
- **doporučený model:** GPT-5.6 Sol;
- **doporučený reasoning:** high;
- **důvod použití této úrovně:** další část kombinuje skutečný service worker, závod dvou
  karet, idempotenci offline replay a izolaci dat mezi uživateli; chyba by mohla způsobit
  duplicitní zápis nebo zobrazení dat jiné identity;
- **očekávané činnosti:** vytvořit oddělený loopback-only Edge/Playwright profil se dvěma
  kartami a dvěma falešnými uživateli, ověřit právě jeden flush a idempotency záznam,
  přepnutí A → B bez úniku queue/cache, service-worker update bez replaye cizích operací,
  cílené offline testy, typecheck, build a závěrečný release gate;
- **soubory, které budou pravděpodobně změněny:** `e2e/playwright.pwa-isolation.config.ts`,
  `e2e/pwa-isolation/mock-pwa-server.mjs`, `e2e/pwa-isolation/offline-identity.spec.ts`,
  `e2e/pwa-isolation/service-worker-update.spec.ts`, `e2e/tsconfig.pwa-isolation.json`,
  kořenový `package.json` a `docs/audit/14-a-*`;
- **zda další fáze může obsahovat migrace nebo jiné rizikové změny:** nemá obsahovat migraci
  `0100`, jinou DB migraci, produkční DB/S3/DNS/Coolify, GHCR write, publisher dispatch,
  deploy ani merge. Obsahuje pouze lokální browserové profily, mock API a testovací změny;
  případné vzdálené CI začlenění patří až do samostatně ověřené navazující části.

Před pokračováním uživatel upraví doporučené nastavení v rozhraní a výslovně napíše
`Pokračuj další fází`.
