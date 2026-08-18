# FÁZE 13.8G-D-C2 – spustitelná verifikace publikačního workflow

- **Datum:** 2026-08-04.
- **Verdikt:** **PASS – OFFLINE EXECUTION PROOF, BEZ REGISTRY ZÁPISU A DEPLOYE**.
- **Výchozí source commit:** `6dddd64676631fffca6aef9baf74d79b127f8a01`.
- **Implementace:** `231e198669551d9e2508607543674e140a45ce9e` a úzká Linux CI oprava
  `1a2ae900e3d4dea033bb17f5067597177e43bbf5`.
- **Větev:** `agent/phase13-staging-workflow-harness`.
- **GitHub:** [stacked draft PR #2](https://github.com/modvolt/Site-Logbook/pull/2), base
  `agent/phase13-staging-gate`.
- **Exact-SHA Quality gate:** [run 30871725613](https://github.com/modvolt/Site-Logbook/actions/runs/30871725613),
  `completed/success` pro `1a2ae900e3d4dea033bb17f5067597177e43bbf5`.

## Uzavřená důkazní mezera

Předchozí staging kontrakty kontrolovaly převážně text a pořadí kroků reusable workflow.
Tato část nyní parsuje workflow jako strict unique-key YAML, vyzvedne z něj přesné `run`
skripty a skutečně je provede proti deterministickým mockům GitHub API a Docker Buildx.
Nevznikla druhá ručně udržovaná implementace stavového automatu.

## Implementované bezpečnostní vlastnosti

- všech `2 × 16 = 32` kombinací `publication_stage × package-state` se vykonává a povolené
  jsou jen čtyři explicitní fail-closed stavy;
- samostatně je ověřen skutečně prázdný první inventory i existující private package bez
  přesného source SHA tagu;
- chybné API odpovědi, duplicitní tag, digest drift, public nebo cizímu repozitáři přiřazený
  package a TOCTOU objevení tagu končí chybou;
- každý push krok má bezprostřední guard se stejnou `if` podmínkou, package identitou a SHA
  tagem, bez `always()` nebo `continue-on-error`;
- remote verifier požaduje OCI index se právě jedním `linux/amd64` runnable manifestem a
  právě jedním OCI attestation manifestem navázaným na jeho digest;
- provenance musí být BuildKit SLSA pro `linux/amd64`, SBOM musí být SPDX document a evidence
  ukládá také digest runnable manifestu;
- formát manifestů, provenance a SBOM odpovídá rozhraní `docker buildx imagetools inspect`:
  [Docker CLI dokumentace](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/),
  [attestation storage](https://docs.docker.com/build/metadata/attestations/attestation-storage/).

## Izolovaný execution harness

- přípravný krok sestaví image z digestem připnutého Alpine 3.22.1 a přesně verzovaných
  `bash`, `jq` a `shellcheck`;
- lokální tag obsahuje hash Dockerfile, takže jeho změna nemůže tiše použít starý image;
- příprava image je oddělena od testu; vlastní execution vždy používá `--network none`,
  read-only root filesystem, `--cap-drop ALL`, `no-new-privileges` a omezení procesů;
- hostitelské secrets ani environment se do kontejneru nedědí;
- POSIX používá pouze numerické UID/GID vlastníka privátního temp bind mountu, Windows
  ponechává neprivilegovaného uživatele `nobody` z Dockerfile;
- exact workflow skripty procházejí ShellCheckem a dočasné soubory jsou po testu odstraněny.

## Provedené kontroly

- `pnpm test:staging-contract`: **39/39 PASS** lokálně a v Linux GitHub Actions;
- `pnpm gate:staging-runtime`: **PASS**;
- `pnpm gate:quality`: **PASS**, bez peer dependency problémů a bez známých zranitelností;
- `pnpm gate:release`: **PASS** – typecheck, 29 hermetických testů, 127 frontend testů,
  15 live-events testů, 316 backend unit testů a oba buildy;
- lokální digest-pinned Postgres na `127.0.0.1:15432` s daty pouze v tmpfs:
  **141/141 izolovaných DB testovacích souborů PASS**; kontejner byl následně odstraněn;
- pinned `actionlint` se sítí vypnutou: **PASS**; ESLint, Prettier a `git diff --check`:
  **PASS**;
- dvě nezávislé read-only agentní re-review: žádný zbývající P0/P1 a žádná potvrzená
  falešně zelená mezera v zamýšleném kontraktu;
- GitHub run `30871725613`: quality, release, execution harness, DB suite a encrypted object
  recovery drill všechny **success**.

## Negativní důkazy a hranice

- žádný workflow dispatch ani volání private publisheru;
- žádný GHCR image build/pull/push, package write, změna visibility nebo package delete;
- žádný merge ani změna `main` nebo rodičovského draft PR #1;
- žádný kontakt s produkcí, Coolify, Hetzner S3, DNS ani produkční databází;
- žádný secret nebyl čten, měněn nebo uložen;
- migrace `0100` nebyla přidána, v migration adresáři není a nebyla spuštěna;
- lokální Postgres byl pouze nový disposable testovací kontejner, ne kopie produkčních dat;
- tato fáze neověřuje reálný první GHCR zápis, výslednou package visibility ani skutečný
  serverový tvar GHCR attestation; tyto body zůstávají za samostatným explicitním risk gate.

## Zbývající nejasnosti

- úplný GHCR inventory zůstává `UNKNOWN`, dokud nebude k dispozici read-only `read:packages`;
- skutečné chování prvního private package a `GITHUB_TOKEN` vůči package API lze potvrdit až
  jednorázovým preflight publikačním krokem;
- lokálně byly ověřeny Docker harness a kompletní Postgres DB testy, nikoli ještě plný
  browserový PWA závod dvou karet, změna identity a service-worker update.
