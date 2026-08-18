# Deploying Stavba

> [!CAUTION]
> **STOP — current production 0096→0107 / HOLD v2 release boundary.** Parts of
> this document describe legacy v1/v5 or ordinary operational procedures. They
> are not production authority when they conflict with the current contracts in
> [18 — host observation and attestation](docs/audit/18-production-host-attestation-runbook.md),
> [19 — 0096→0107 control plane](docs/audit/19-production-0096-0107-control-plane-contract.md),
> [20 — exact-0096 backup and isolated restore](docs/audit/20-production-exact-0096-backup-restore-contract.md),
> [20 — database-role separation](docs/audit/20-production-db-role-separation-contract.md),
> [21 — signing-key custody](docs/audit/21-production-signing-key-custody-runbook.md),
> [22 — runtime credential cutover](docs/audit/22-production-runtime-db-credential-cutover.md),
> [23 — activation HOLD v2](docs/audit/23-production-activation-hold-v2.md), and
> [24 — activation-bundle producer](docs/audit/24-production-activation-bundle-producer.md).
> Do not use Base64/environment evidence transport, direct `dist/index.mjs`
> startup, rendered secret-bearing Compose, a generic live restore, or mutable
> local image tags for this production release. On conflict, missing evidence,
> or an ambiguous result, preserve the artifacts and stop; never retry blind.

### Current production release order

1. Require the exact reviewed PR head to pass all gates, merge it through the
   reviewed two-parent merge procedure, and require the first `main` run for
   that merge SHA to pass before freezing the production source SHA.
2. Separately approve the four-image production publication `preflight` and
   `complete` phases; retain the immutable image refs, publication receipt, OCI
   provenance and signed API-image provenance.
3. Stop writers in a separately approved maintenance window, create the exact
   0096 backup, retain the durable S3 object/version, prove an isolated restore,
   and verify the signed `PASS` receipt.
4. Bootstrap the separated database roles, observe and assemble the baseline,
   execute the ten individually receipt-backed migrations, apply the role
   ceremony, and finalize the non-authorizing 0096→0107 transition.
5. Perform the separately approved runtime database-credential cutover and
   require its authoritative `PASS` receipt.
6. Separately approve and save the exact Coolify secrets and desired
   configuration.
7. Deploy the reviewed immutable API and web images with
   `activation-bundle-v2.json` absent; the API must start and remain in HOLD.
8. Collect fresh sealed Coolify, Docker and PostgreSQL observations for that
   exact HOLD challenge, then obtain the separate explicit activation approval.
9. Produce both signatures over the complete fresh bundle, publish it through
   the digest-gated host operator, then verify activation and production smoke.

Merge, registry publication, maintenance/S3 write, role or migration mutation,
runtime credential mutation, Coolify save, deployment, activation approval and
signing, and Linux bundle publication remain separate approval boundaries.

Stavba runs anywhere Docker runs — no Replit infrastructure required. The
production runtime is three services plus an externally managed Hetzner Object
Storage bucket:

| Service    | Image / source              | Purpose                              |
| ---------- | --------------------------- | ------------------------------------ |
| `postgres` | `PRODUCTION_POSTGRES_IMAGE` | Immutable application database image |
| `api`      | `PRODUCTION_API_IMAGE`      | Non-mutating REST API runtime image  |
| `web`      | `PRODUCTION_WEB_IMAGE`      | Immutable PWA + `/api` reverse proxy |

The **web** container is the single public entrypoint: it serves the built PWA
and reverse-proxies `/api/*` to the API container, so the browser always talks
to one origin (the session cookie depends on this).

---

## 1. Review the production Compose contract without rendering secrets

Review the committed `.env.example` and `docker-compose.yml` structurally.
Do not run, retain, or submit `docker compose config` against production
settings: interpolation can expose `DATABASE_URL` and other secrets. The final
desired/deployed configuration equality and resolved Compose digest are
authoritative only when derived from the sealed post-HOLD observers and bound
into the signed activation chain.

Root Compose intentionally has no `build:` entries and is not a development
quick-start. Starting it is a production action and requires separately
approved immutable images and production evidence.

What happens on startup:

1. `postgres` starts. The existing Hetzner bucket is external and is never
   created or changed by root Compose.
2. A separately approved one-shot schema control plane must already have
   applied or exact-noop verified `0107_canonical_audit_evidence` and emitted
   canonical execution plus read-only steady-state artifacts. Root Compose does
   not run that transition.
3. `api` starts `production-api-entrypoint.mjs` and serves only its loopback
   process-health endpoint in HOLD. It does not import the application, workers,
   database readiness code or object-storage clients, and it never runs a
   migrator. Missing, stale or mismatched evidence keeps every external route in
   HOLD; only the complete fresh signed bundle can import the application once.
4. `web` (nginx) serves the PWA on port 8080 and proxies `/api` to `api`.

To stop services without deleting persistent data, use `docker compose down`.
Never add `-v` in production: it deletes the named database volume and is
outside the deployment procedure.

### File uploads

Uploads are **proxied through the API**: the browser `POST`s the file to
`/api/storage/uploads` (same origin as the app), and the API streams it into the
bucket server-side. The browser never talks to the storage host directly, which
means:

- The **API** reaches the externally managed Hetzner bucket over the required
  HTTPS `S3_ENDPOINT`. This is the only storage endpoint that has to be
  reachable.
- There is **no** browser-reachable storage endpoint to configure and **no CORS**
  to set up on the bucket — the bytes flow browser → nginx → API → bucket.

Because uploads pass through nginx, `client_max_body_size` in
`artifacts/stavba/nginx.conf` (currently `100m`) must stay at/above the API's
limits — binary photo/document uploads are capped at 100 MB, and JSON/form
bulk-import payloads at `MAX_REQUEST_BODY_MB` (default 50 MB) — or large requests
are rejected by nginx with a 413 before reaching the API.

**Endpoint scheme:** endpoint values may omit the scheme —
`fsn1.your-objectstorage.com` is normalized to
`https://fsn1.your-objectstorage.com`. The production exact-backup gate accepts
only canonical HTTPS Hetzner endpoints for `fsn1`, `nbg1` or `hel1`; it rejects
plain HTTP, MinIO, AWS and arbitrary S3-compatible endpoints.

---

## 2. Deploy on Coolify

This repo's `docker-compose.yml` is Coolify-ready.

> **Staging is a separate runtime.** Use `docker-compose.staging.yml` as a
> standalone Compose file; never merge it with this production/local file. Its
> input contract is `.env.staging.example`, all inputs use the `STAGING_` prefix,
> and only the `web` service on container port `80` may receive a Coolify domain.
> Do not add custom Compose networks: Coolify supplies the isolated per-resource
> network and connects its proxy to it. PostgreSQL, API and Mailpit publish
> no host ports and must not receive a domain. The staging preflight
> rejects `modvoltapp.cz` (including subdomains), loopback origins, non-exact build
> SHAs, a non-HTTPS or non-staging S3 target, and missing or reused
> application/backup keyrings before stateful services start. Staging uses a
> separately provisioned external S3 bucket and least-privilege credential;
> this Compose file never creates or changes that bucket. Mailpit is fixed at
> `v1.30.0`; its staging-only CA enables the API's
> mandatory verified STARTTLS without weakening production mail transport. The API
> receives only the public CA volume, never Mailpit's private server key. To
> rotate that CA, replace the staging `staging_mailtls` and `staging_mailca`
> volumes and restart Mailpit followed by the API. Provisioning and the first
> staging deploy require a separate authorized
> run; merely committing this definition does not create or modify a Coolify
> resource.

1. **Create resource** → _Docker Compose_ → point it at this repository (the
   compose file is at the repo root).
2. **Environment variables** — set everything from `.env.example` in Coolify's
   UI. Use strong values for `POSTGRES_PASSWORD`, `SESSION_SECRET`, and
   `S3_SECRET_ACCESS_KEY` (`openssl rand -hex 32`).
3. **Domains / TLS** — Coolify's reverse proxy (Traefik) terminates TLS. Map
   your domain to the **`web`** service (container port `80`). TLS and
   certificates are handled by Coolify. Set `PUBLIC_APP_URL` to the canonical
   HTTPS origin and `NGINX_SERVER_NAME` to the exact accepted hostname(s), for
   example `modvoltapp.cz www.modvoltapp.cz`. Unknown Host values are rejected
   by nginx and the API never derives bearer links from request headers.
4. **Object storage** — create the production bucket and project-bound
   credentials in Hetzner Object Storage, then set the exact `S3_*` values. The
   root Compose has no MinIO fallback and never creates or mutates the bucket.
   Uploads remain proxied through the API, so no public storage subdomain or
   browser CORS policy is needed.
5. **Deploy only after its separate approval.** Deployment starts the reviewed
   API image in HOLD with `activation-bundle-v2.json` absent. It does not run a
   migration or activate the application; fresh observation, explicit approval,
   signing and host publication follow as separate steps.

### Using managed Postgres / S3 instead of the bundled services

- **Database:** remove the `postgres` service and set `DATABASE_URL` to your
  managed connection string. The separately approved control plane remains the
  only migration path; API startup stays read-only.
- **Storage:** the production contract is specifically Hetzner Object Storage.
  Set `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` and
  `S3_FORCE_PATH_STYLE=false`; create the bucket once in Hetzner. The exact
  pre-migration backup verifies the official HTTPS endpoint, enabled bucket
  versioning, and the exact durable `VersionId` returned for the MVE1-encrypted
  payload.

---

## 3. Environment variables

The current production runtime contract is defined by the committed
`.env.example` and `docker-compose.yml`. HOLD v2 accepts no canonical evidence,
host attestation or expected configuration digest from environment variables.
Historical `AUDIT_*`, `PRODUCTION_AUDIT_*_B64`,
`PRODUCTION_HOST_ATTESTATION_B64` and `PRODUCTION_EXPECTED_*` names are
legacy/staging or control-plane notes, not production API startup authority.

| Variable                                                                           | Required          | Default           | Notes                                                                                                                        |
| ---------------------------------------------------------------------------------- | ----------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                     | yes               | —                 | Postgres connection string (set by Compose from the vars below).                                                             |
| `POSTGRES_USER/PASSWORD/DB`                                                        | yes\*             | —                 | Used by the bundled `postgres` service to build `DATABASE_URL`.                                                              |
| `SESSION_SECRET`                                                                   | yes               | —                 | Secret signing session cookies.                                                                                              |
| `PORT`                                                                             | no                | `5000`            | API listen port (inside the container).                                                                                      |
| `PUBLIC_APP_URL`                                                                   | yes               | —                 | Canonical external origin used for all emailed/shared links; HTTPS is mandatory in production and no path/query is accepted. |
| `NGINX_SERVER_NAME`                                                                | yes in production | `localhost`       | Space-separated public hostnames accepted by nginx. Loopback names are added internally for healthchecks.                    |
| `S3_BUCKET`                                                                        | yes               | —                 | Bucket for uploads.                                                                                                          |
| `S3_ACCESS_KEY_ID`                                                                 | yes               | —                 | Project-bound Hetzner Object Storage access key.                                                                             |
| `S3_SECRET_ACCESS_KEY`                                                             | yes               | —                 | Project-bound Hetzner Object Storage secret key.                                                                             |
| `S3_ENDPOINT`                                                                      | yes               | —                 | Canonical Hetzner HTTPS endpoint, for example `https://fsn1.your-objectstorage.com`.                                         |
| `S3_REGION`                                                                        | yes               | —                 | Exact Hetzner bucket location: `fsn1`, `nbg1` or `hel1`.                                                                     |
| `S3_FORCE_PATH_STYLE`                                                              | no                | `false`           | Production default uses the provider's virtual-hosted addressing.                                                            |
| `S3_PRIVATE_PREFIX`                                                                | no                | `private`         | Key prefix for uploaded objects.                                                                                             |
| `S3_PUBLIC_PREFIX`                                                                 | no                | `public`          | Comma-separated prefixes for public assets.                                                                                  |
| `SMTP_HOST`                                                                        | no                | —                 | Empty disables outbound email (PDF job sheets).                                                                              |
| `SMTP_PORT`                                                                        | no                | `587`             |                                                                                                                              |
| `SMTP_SECURE`                                                                      | no                | auto              | `true` for implicit TLS (465).                                                                                               |
| `SMTP_USER/PASSWORD`                                                               | no                | —                 | Credentials (optional for open relays).                                                                                      |
| `SMTP_FROM`                                                                        | no                | `SMTP_USER`       | From address.                                                                                                                |
| `OPENAI_API_KEY`                                                                   | no                | —                 | Empty disables AI cost-document extraction (manual review still works). Your own OpenAI key.                                 |
| `OPENAI_DOCUMENT_EXTRACTION_ENABLED`                                               | no                | `false`           | Master switch; extraction runs only when exactly `true`.                                                                     |
| `OPENAI_DOCUMENT_MODEL`                                                            | no                | `gpt-4o`          | Vision/file-capable model used for extraction.                                                                               |
| `OPENAI_MAX_FILE_MB`                                                               | no                | `32`              | Max input file size sent to OpenAI. OpenAI caps inputs (~32 MB/PDF, ~20 MB/image); higher has no effect.                     |
| `OPENAI_REQUEST_TIMEOUT_MS`                                                        | no                | `60000`           | Per-request timeout to OpenAI (ms).                                                                                          |
| `BACKUP_ENABLED`                                                                   | no                | `true`            | `false` disables scheduled backups (manual still works).                                                                     |
| `BACKUP_INTERVAL_HOURS`                                                            | no                | `24`              | Hours between scheduled backups.                                                                                             |
| `BACKUP_RETENTION`                                                                 | no                | `14`              | Most-recent successful backups to keep; older ones are pruned.                                                               |
| `PG_DUMP_PATH`                                                                     | no                | `pg_dump`         | Path to the `pg_dump` binary if not on `PATH`.                                                                               |
| `MIGRATIONS_DIR`                                                                   | no                | `/app/migrations` | Where the API reads SQL migrations (set in the image).                                                                       |
| `BUILD_SHA`                                                                        | yes               | —                 | Exact 40-character commit SHA baked into the API image and bound by release evidence.                                        |
| `AUDIT_0107_RELEASE_EVIDENCE_B64` / `AUDIT_0107_RELEASE_EVIDENCE_SHA256`           | no (legacy)       | —                 | Retired v1/v5 environment transport; not accepted by current production API startup.                                         |
| `AUDIT_0107_EXECUTION_EVIDENCE_B64` / `AUDIT_0107_EXECUTION_EVIDENCE_SHA256`       | no (legacy)       | —                 | Retired v1/v5 environment transport; not accepted by current production API startup.                                         |
| `AUDIT_0107_INTENT_EVIDENCE_B64` / `AUDIT_0107_INTENT_EVIDENCE_SHA256`             | no (legacy)       | —                 | Retired v1/v5 environment transport; not accepted by current production API startup.                                         |
| `AUDIT_0107_STEADY_STATE_EVIDENCE_B64` / `AUDIT_0107_STEADY_STATE_EVIDENCE_SHA256` | no (legacy)       | —                 | Retired v1/v5 environment transport; not accepted by current production API startup.                                         |
| `AUDIT_0107_RESOLVED_COMPOSE_SHA256`                                               | no (legacy)       | —                 | Retired copied-digest transport; only sealed final observers are authoritative.                                              |
| `AUDIT_0107_DEPLOYMENT_CONFIG_SHA256`                                              | no (legacy)       | —                 | Retired copied-digest transport; only sealed final observers are authoritative.                                              |
| `AUDIT_0107_LIVE_POSTGRES_TARGET_SHA256`                                           | no (legacy)       | —                 | Retired copied-digest transport; only sealed final observers are authoritative.                                              |
| `MAX_REQUEST_BODY_MB`                                                              | no                | `50`              | Max JSON/form body size (CSV bulk imports, base64 uploads). Raise nginx `client_max_body_size` too if set above 100.         |

Production requires every `PRODUCTION_*_IMAGE` as an approved
`repository@sha256:<64hex>` ref. The only runtime evidence transport is the
fixed read-only evidence mount described by the HOLD v2 contract, with the two
pinned public-key files present before container creation and the canonical
`activation-bundle-v2.json` absent until its separately approved publication.

\* Required when using the bundled `postgres` service; otherwise supply
`DATABASE_URL` directly.

---

## 4. Database migrations

Production uses **non-interactive, file-based migrations** instead of
`drizzle-kit push`, but production API startup never applies them. Migration
execution and application startup are separate approval boundaries.

- Generate migration SQL after changing the schema (`lib/db/src/schema`):

  ```bash
  pnpm --filter @workspace/db run generate
  ```

  This writes versioned SQL + snapshots under `lib/db/migrations` â€” **commit
  them**. They are baked into the API image for the separately invoked control
  plane and for read-only health identity checks.

- Apply migrations only to an isolated local development database when a
  feature-specific one-shot runner is not required:

  ```bash
  DATABASE_URL=postgres://â€¦ pnpm --filter @workspace/db run migrate
  ```

- `pnpm --filter @workspace/db run push` remains available for **local dev
  only** â€” never use it against production.

  The generic command is not production authorization and must not be used to
  bypass a numbered one-shot gate.

### Current HOLD v2 startup guard

The former six-artifact/Base64 environment guard, direct
`node --enable-source-maps /app/dist/index.mjs` command, schema-v5 copied-digest
procedure and empty-trust-map state are legacy and are not production authority.
Do not reproduce or recover through that path.

The production image starts only through `production-api-entrypoint.mjs`. The
two distinct reviewed public keys are source-pinned, and the fixed mounted
bundle is verified before the application module can be imported. The complete
semantic result—not an unsigned request, an environment value or a manually
assembled digest—supplies the runtime source/image/configuration, backup,
migration, credential, PostgreSQL and API-image-provenance bindings. A staging
`control-plane` image remains inadmissible as `PRODUCTION_API_IMAGE`.

After startup, a single-flight runtime watchdog revalidates the live journal by
exact `(created_at, hash)` identity plus current database/user and the complete
audit schema fingerprint every 60 seconds. The first mismatch or unverifiable
result permanently trips the in-process readiness latch, so `/api/healthz`
immediately returns 503. Before closing the HTTP server, shutdown synchronously
stops every scheduler and worker timer; the process then exits non-zero and can
restart only through the complete startup guard. This controls the approved
database/schema binding, while host/Coolify state between short-lived signed
observations remains an external monitoring boundary.

The activation bundle has a five-minute issuance/expiry window and is bound to
the current process nonce plus its exact Docker container identity. It is not a
renewable lease. Any new process challenge requires fresh observations,
approval and signatures over a new no-clobber bundle. Configure a host-level
Coolify/node alert on repeated container restarts, HOLD/unhealthy state and
non-zero API exits; application workers cannot alert before activation.

Safe recovery keeps the API in HOLD, preserves a rejected bundle under a
separate audit filename outside the fixed live path, resolves any real drift
through its own approved procedure, and starts the same reviewed immutable image
with the live bundle filename absent. Reacquire every observation and approval
for the new challenge, then use the attended producer and digest-gated host
publication again. Never edit timestamps, nonces, digests or signatures; add an
emergency trust key; switch to the control-plane image; delete unreviewed
evidence merely to retry; or repeatedly restart until an attempt passes.

Never treat a deployment-state snapshot written in this document as current.
Only fresh sealed Coolify, Docker and PostgreSQL observations from the exact
HOLD ceremony can establish zero pending changes, desired/deployed equality,
resolved Compose identity and the live database binding.

### If the deployed DB falls behind the code

Symptom: plain reads like `GET /api/jobs` or `GET /api/dashboard/today` return
500, or writes (creating a job, recording a warehouse movement) fail, because the
DB is missing columns/tables newer migrations add. Most likely causes:

1. **Stale Docker image / cached build.** A cached image can contain an older
   journal or a different `BUILD_SHA`. Force a no-cache rebuild and verify the
   immutable image digest and exact build SHA before producing new evidence.
2. **Wrong `MIGRATIONS_DIR`.** The env var points at a folder that doesn't contain
   the current migrations (or is empty/missing `meta/_journal.json`). The startup
   health inventory names the wrong expected count/latest tag. Fix the image or
   `MIGRATIONS_DIR`; do not authorize startup with a rewritten evidence file.
3. **Missing or mismatched v5 evidence.** Keep API/web stopped, re-run the
   read-only steady verifier against the intended database and image, review all
   raw artifacts offline and issue a new v5 approval. Never copy evidence from a
   different database, image or environment.

If production is genuinely behind, keep the API stopped and use only the
approved numbered one-shot transition with its backup, preflight, postflight and
execution receipt. The generic migrator command is not a recovery procedure.

---

## 5. Database backups & restore

> [!WARNING]
> The scheduled/manual API backups below are ordinary operational backups. They
> do not satisfy the exact-0096 release gate. The current release must use the
> signed plan, exact Hetzner S3 object version, isolated PostgreSQL restore
> lifecycle and authoritative `PASS` receipt in
> [the exact-0096 contract](docs/audit/20-production-exact-0096-backup-restore-contract.md).

The API takes **automated `pg_dump` backups** and uploads them to the same object
storage bucket as uploads, under the `backups/` prefix. Backups use Postgres's
custom format (`pg_dump -Fc`), which is compressed and restorable with
`pg_restore`.

- **Scheduled:** a backup runs on startup-scheduled intervals
  (`BACKUP_INTERVAL_HOURS`, default 24h). Old backups beyond `BACKUP_RETENTION`
  (default 14) are pruned from storage and the `backup_log` table.
- **Manual:** admins (`master`/`admin` roles) can trigger a backup and download
  any backup from **Settings → Backups** in the app, or via the API:
  - `POST /api/backups` — create a backup now
  - `GET /api/backups` — list backups + last success time
  - `GET /api/backups/:id/download` — download the dump file
- **Requirements:** object storage must be configured (`S3_*`) and `pg_dump`
  must be available on the API container. The API image already installs
  `postgresql-client-16`. If object storage is not configured, backups are
  skipped (logged, not fatal).

### Restoring an operational backup into an isolated database

1. Download the desired backup (admin UI or `GET /api/backups/:id/download`).
   The file is named `stavba-<timestamp>.pgcustom`.
2. Restore into a Postgres database with `pg_restore`. To restore into a clean
   database:

   ```bash
   # Create an empty target DB (or drop & recreate the existing one).
   createdb -h <host> -U <user> stavba_restore

   # Restore. --clean --if-exists makes it idempotent against an existing schema.
   pg_restore --clean --if-exists --no-owner --no-acl \
     -h <host> -U <user> -d stavba_restore \
     stavba-<timestamp>.pgcustom
   ```

   `--no-owner --no-acl` avoids role-ownership errors when restoring across
   different Postgres users.

   Never point this generic procedure at the live production database. A live
   restore or database swap is a distinct destructive recovery action requiring
   its own reviewed runbook, exact target resolution and explicit approval; it
   is not part of the current release procedure.

3. Keep the restored database isolated and validate its lineage and contents as
   a recovery drill. Do not point the production application at it through this
   worksheet.

> **Tip:** periodically test a restore into a throwaway database — an untested
> backup is not a backup.

---

## 6. Building local development images individually

> [!WARNING]
> The mutable tags produced below are non-production developer conveniences.
> They are not reviewed publication authority and must never be deployed for the
> current release. Production authority comes only from the separately approved
> two-phase four-image workflow and its immutable digest-bound receipt and
> provenance.

Both Dockerfiles expect the **repository root** as the build context:

```bash
docker build -f artifacts/api-server/Dockerfile -t stavba-api .
docker build -f artifacts/stavba/Dockerfile     -t stavba-web .
```
