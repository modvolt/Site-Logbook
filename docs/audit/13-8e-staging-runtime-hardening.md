# FÁZE 13.8E – staging capacity a reproducibility hardening

- **Datum:** 2026-08-03.
- **Rozsah:** pouze repozitářový staging runtime/build contract; žádný live resource,
  image publication, deploy ani produkční změna.
- **Výchozí lokální commit:** `3b5ac57bbc9b7630e015dbb804db0f9e19f14de2`.
- **Výchozí publikovaný staging commit:**
  `7f4bd719c951dffd58f7697253156c3cb7146b23`.
- **Verdikt:** **LOCAL HARDENING PASS / PUBLICATION A PROVISIONING BLOCKED**.
- **Produkce/Coolify/S3/DNS:** bez přístupu a beze změny.
- **DB a migrace:** DB ani migrace nebyla spuštěna; `0100` zůstává vyloučená.

## Centrální registr nálezů a uzavření

| ID        | Stav             | Zjištění / změna                                                                                                                                                                                                              | Dopad / hranice                                                                                                                                                        |
| --------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F13.8E-01 | FIXED            | `docker-compose.staging.yml` už neobsahuje žádný `build:`. Čtyři vlastní služby vyžadují plný `repository@sha256:<64 hex>` image reference.                                                                                   | Coolify runtime nemá lokálně buildit API, web, Mailpit ani preflight. Chybějící nebo mutable reference skončí fail-closed před použitelným runtime.                    |
| F13.8E-02 | FIXED            | Každá z pěti služeb má explicitní `cpus`, `mem_limit`, `mem_reservation` a `pull_policy: always`. Celkový hard limit je 2,25 CPU / 2304 MiB.                                                                                  | Runtime cap odpovídá F13.8D capacity packetu. Compose je source of truth; limity ještě nebyly použity na živém hostu.                                                  |
| F13.8E-03 | FIXED            | Node, Nginx, PostgreSQL, Mailpit a Alpine jsou připnuté na ověřené OCI index digesty. Připnutý je také Dockerfile frontend `docker/dockerfile:1`.                                                                             | Stejný commit už nemůže tiše přejít na jiný obsah těchto tagů ani jiný Dockerfile parser.                                                                              |
| F13.8E-04 | FIXED            | API a web Dockerfiles byly sjednoceny z `pnpm@10.26.1` na repository/CI verzi `pnpm@11.9.0`. Finální images nesou OCI `source` a `revision` label.                                                                            | Image build používá stejnou pnpm major/minor verzi jako lockfile policy a CI; revision lze porovnat s očekávaným exact SHA.                                            |
| F13.8E-05 | FIXED            | Nový statický gate `gate:staging-runtime` kontroluje nulový počet host build definic, digesty, resource limity, image vstupy, preflight validaci, pinned Actions a přítomnost gate v Quality workflow.                        | Drift na mutable image, chybějící limit nebo neúplný publish workflow failne lokálně i v GitHub Quality gate.                                                          |
| F13.8E-06 | READY / NOT RUN  | Nový manuální workflow publikuje čtyři `linux/amd64` GHCR images, vyžaduje shodu zadaného SHA s `github.sha`, používá commit-pinned Actions, generuje SBOM/provenance a secret-free digest manifest. Neobsahuje deploy plane. | Workflow nebyl dispatchnut. GHCR package visibility/pull credential a server architektura musí být ověřeny před publikací; registry publication vyžaduje nový souhlas. |
| F13.8E-07 | PASS             | Syntetický `docker compose config` potvrdil pět digest-pinned služeb bez `build:` a normalizoval všechny CPU/RAM limity na očekávané hodnoty.                                                                                 | Statická Compose struktura je použitelná; žádná služba, DB ani migrace se nespustila.                                                                                  |
| F13.8E-08 | LOCAL PASS       | Lokální lint, peer check, audit threshold, hermetické unit testy, typecheck, API/PWA build, staging E2E typecheck, Dockerfile checks a nové contract testy prošly.                                                            | Jde o local prepublication evidence. Remote exact-SHA Quality gate, izolované DB testy, MinIO recovery drill a image build/push nebyly provedeny.                      |
| F13.8E-09 | PENDING EXTERNAL | Nové změny zatím nemají publikované SHA ani GitHub check run. Dosavadní zelený gate `7f4bd719…` se na tento strom nevztahuje.                                                                                                 | Další krok musí nejprve publikovat přesný commit na staging PR branch a získat zelený Quality gate; teprve potom lze samostatně autorizovat image workflow.            |
| F13.8E-10 | BLOCKER          | AWS účet/provider a user-owned origin z F13.8D zůstávají nerozhodnuté.                                                                                                                                                        | Nezabraňují publikaci kódu/images, ale stále blokují Coolify/S3/DNS provisioning a první deploy.                                                                       |

## Pull-only runtime kontrakt

`docker-compose.staging.yml` přijímá čtyři nové nesenzitivní proměnné:

```text
STAGING_PREFLIGHT_IMAGE=registry/repository@sha256:<64 lowercase hex>
STAGING_MAILPIT_IMAGE=registry/repository@sha256:<64 lowercase hex>
STAGING_API_IMAGE=registry/repository@sha256:<64 lowercase hex>
STAGING_WEB_IMAGE=registry/repository@sha256:<64 lowercase hex>
```

Jejich hodnoty nevznikají ručně. Později je dodá secret-free artifact manuálního image
workflow. Compose přítomnost vyžaduje už při interpolaci a `staging-preflight` znovu
ověří formát bez vypsání reference. Image názvy nejsou secrets, ale úplné registry
reference se budou uchovávat v release evidence, nikoli pevně v Compose.

PostgreSQL je veřejný upstream image připnutý přímo v Compose. Vlastní images se
nevytvářejí na Coolify hostu a runtime Compose už neobsahuje build context ani build
args. `STAGING_BUILD_SHA` zůstává samostatný exact-SHA runtime kontrakt; po deployi se
musí shodovat s OCI revision a frontend/API health identitou.

## Resource limity

| Služba              | CPU hard limit | RAM hard limit | RAM reservation |
| ------------------- | -------------- | -------------- | --------------- |
| `staging-preflight` | 0,25           | 128 MiB        | 64 MiB          |
| `postgres`          | 0,50           | 768 MiB        | 512 MiB         |
| `mailpit`           | 0,25           | 256 MiB        | 128 MiB         |
| `api`               | 1,00           | 1024 MiB       | 768 MiB         |
| `web`               | 0,25           | 128 MiB        | 64 MiB          |
| **celkem**          | **2,25**       | **2304 MiB**   | **1536 MiB**    |

Limity jsou konzervativní startovní hodnoty, nikoli kapacitní garance. Po prvním
samostatně schváleném startu je nutné měřit OOM/restart count, RAM, load a disk. Limit
se nesmí zvyšovat na úkor produkce bez nového capacity gate.

## Ověřené image digesty

Base image evidence byla 2026-08-03 načtena read-only přes
`docker buildx imagetools inspect`; Dockerfile frontend digest potvrdil Buildx při
`docker buildx build --check`. Použity jsou multi-platform OCI index digesty; samotný
publish workflow záměrně vytváří jen `linux/amd64` vlastní images.

| Reference                 | Připnutý digest                                                           |
| ------------------------- | ------------------------------------------------------------------------- |
| `docker/dockerfile:1`     | `sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89` |
| `node:24-slim`            | `sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7` |
| `nginx:1.27-alpine`       | `sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10` |
| `postgres:16-alpine`      | `sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777` |
| `axllent/mailpit:v1.30.0` | `sha256:0059ef81e492a7192af3816281eed6859eb078bd7bdc58b76757c13e10e53a7d` |
| `alpine:3.22.1`           | `sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1` |

Digest aktualizace se musí provést jako samostatná reviewable změna s novým registry
lookupem, Dockerfile checkem, buildem, testy a exact-SHA gate. Pohyblivý tag se nesmí
vrátit jako fallback.

## Manuální GHCR publication contract

`.github/workflows/staging-images.yml`:

1. lze spustit pouze ručně;
2. vyžaduje 40znakový `expected_sha` shodný s vybraným `github.sha` a boolean potvrzení
   registry publication;
3. má jen `contents: read` a `packages: write`;
4. používá commit-pinned `checkout`, `setup-buildx`, `login`, `build-push` a
   `upload-artifact` Actions;
5. publikuje preflight, Mailpit, API a web images s exact-SHA tagem, SBOM a provenance;
6. ukládá `staging-images.json` obsahující source SHA a čtyři `repository@digest`
   reference;
7. neobsahuje Coolify, SSH, Kubernetes, deploy ani produkční credential.

GitHub action tagy byly 2026-08-03 ověřeny read-only přes `gh api` a v workflow jsou
uloženy konkrétní commit SHA. Workflow zatím neexistuje na remote a nebylo spuštěno.

Před dispatch je povinné:

- ověřit, že Coolify host je `linux/amd64`;
- rozhodnout, zda GHCR packages budou veřejné, nebo vytvořit staging-only read token;
- mít zelený exact-SHA Quality gate pro stejný commit;
- získat nový výslovný souhlas k registry zápisu;
- po publikaci ověřit, že manifest má čtyři digesty a žádný deploy neproběhl.

## Automatické kontraktní kontroly

Nový `scripts/check-staging-runtime-contract.mjs` kontroluje:

- nulový počet `build:` a absenci `ports:`/`networks:` ve staging Compose;
- přesný PostgreSQL digest a čtyři povinné custom image vstupy;
- CPU, hard RAM a reservation pro každou službu;
- digest na každém `FROM` a Dockerfile frontend directive;
- OCI revision label a `pnpm@11.9.0` v aplikačních Dockerfiles;
- prázdné image placeholdery v `.env.staging.example`;
- fail-closed image validaci v preflight shellu;
- přesně čtyři publication kroky, pinned Actions, `linux/amd64`, digest manifest a
  absenci deployment plane;
- spuštění staging runtime gate i testů z GitHub Quality workflow.

Negativní testy prokazují odmítnutí host `build:`, driftu CPU limitu, mutable base
image a neúplné registry publication.

## Provedené kontroly

| Kontrola                                                           | Výsledek                                           |
| ------------------------------------------------------------------ | -------------------------------------------------- |
| registry OCI index lookup pro Node/Nginx/PostgreSQL/Mailpit/Alpine | PASS                                               |
| GitHub Action tag-to-commit lookup                                 | PASS                                               |
| `docker compose config --format json` se syntetickými hodnotami    | PASS; 5 služeb, 0 buildů, všechny digesty a limity |
| `node scripts/check-staging-runtime-contract.mjs`                  | PASS                                               |
| staging contract testy                                             | 16/16 PASS                                         |
| cílený ESLint nových skriptů                                       | PASS                                               |
| `pnpm gate:quality`                                                | PASS; lint a peers čisté, audit jen 1 low advisory |
| hermetické bezpečnostní testy                                      | 18/18 PASS                                         |
| frontend unit testy                                                | 127/127 PASS                                       |
| live-events testy                                                  | 15/15 PASS                                         |
| API unit testy                                                     | 316/316 PASS                                       |
| workspace typecheck                                                | PASS, 4/4 projekty                                 |
| staging E2E typecheck                                              | PASS                                               |
| API build                                                          | PASS                                               |
| PWA production build                                               | PASS; pouze existující chunk-size warning          |
| `docker buildx build --check` všech čtyř Dockerfiles               | PASS, bez warningu; žádný image build              |
| Prettier podporovaných JSON/YAML/JS souborů                        | PASS                                               |
| `git diff --check`                                                 | PASS                                               |

První monolitické spuštění `gate:release` bylo přerušeno nástrojovým orchestratorem
bez výsledku; přesně stejné child kroky byly následně spuštěny samostatně a všechny
prošly. Přesně identifikovaný osiřelý lokální testovací API process tree byl po
přerušení ukončen; produkční proces nebyl dotčen.

## Výslovně neprovedené kontroly a změny

- nebyl spuštěn GitHub exact-SHA Quality workflow pro nový commit;
- nebyly spuštěny CI izolované DB suites ani MinIO recovery drill;
- nebyl proveden skutečný Docker image build, push, GHCR package write ani workflow
  dispatch;
- nebyl kontaktován Coolify, produkční web/API, S3 bucket, DNS ani DB;
- nebyl vytvořen resource, secret, credential, origin ani certifikát;
- nebyl spuštěn API runtime, migrace ani `0100`;
- nebyl proveden push, merge ani produkční rebuild/deploy.

## Stop podmínky

- image workflow se nesmí spustit před publikovaným exact SHA a zeleným Quality gate;
- nesmí se použít SHA tag bez digestu v runtime Compose;
- Coolify nesmí dostat source build ani povolení buildit vlastní images;
- privátní GHCR token musí být staging-only read token a nesmí jít do Git/evidence;
- pokud host není `linux/amd64`, workflow platform policy se musí nejprve opravit a
  znovu projít gate;
- AWS/provider/origin rozhodnutí stále blokují provisioning;
- produkční Compose drift a rebuild zůstávají mimo tento workstream;
- žádná migrace `0100`.
