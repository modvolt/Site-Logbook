# Deploying Stavba

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

## 1. Render and verify the production Compose contract

```bash
cp .env.example .env      # then edit the secrets
docker compose config     # inspect exact resolved bytes before approval
```

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
3. `api` verifies the production target, raw intent/execution/steady/release
   chain, exact Coolify IDs, zero pending changes, desired/deployed config
   equality, immutable image provenance, live PostgreSQL identity and exact
   schema fingerprint. It then serves port 5000 **without running a migrator**.
   Missing, stale or mismatched evidence keeps the container stopped.
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
5. **Deploy only after approval.** API startup is read-only and never runs a migration.

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
| `AUDIT_0107_RELEASE_EVIDENCE_B64` / `AUDIT_0107_RELEASE_EVIDENCE_SHA256`           | yes               | —                 | Canonical schema-v5 release approval and its separately recorded digest.                                                     |
| `AUDIT_0107_EXECUTION_EVIDENCE_B64` / `AUDIT_0107_EXECUTION_EVIDENCE_SHA256`       | yes               | —                 | Canonical one-shot execution evidence. It must retain `authorizesApplicationStart=false`.                                    |
| `AUDIT_0107_INTENT_EVIDENCE_B64` / `AUDIT_0107_INTENT_EVIDENCE_SHA256`             | yes               | —                 | Canonical pre-transition intent; its exact bytes and runtime binding must match execution.                                   |
| `AUDIT_0107_STEADY_STATE_EVIDENCE_B64` / `AUDIT_0107_STEADY_STATE_EVIDENCE_SHA256` | yes               | —                 | Canonical read-only steady-0107 evidence with `authorizesApplicationStart=true`.                                             |
| `AUDIT_0107_RESOLVED_COMPOSE_SHA256`                                               | yes               | —                 | Separately reviewed digest of canonical resolved Compose observed by the isolated host runner.                               |
| `AUDIT_0107_DEPLOYMENT_CONFIG_SHA256`                                              | yes               | —                 | Digest of the canonical secret-free Coolify/deployment configuration after reviewing all pending changes.                    |
| `AUDIT_0107_LIVE_POSTGRES_TARGET_SHA256`                                           | yes               | —                 | Digest of the canonical live Postgres container/image/volume/network projection observed throughout the transition.          |
| `MAX_REQUEST_BODY_MB`                                                              | no                | `50`              | Max JSON/form body size (CSV bulk imports, base64 uploads). Raise nginx `client_max_body_size` too if set above 100.         |

Production additionally requires every `PRODUCTION_*_IMAGE` as an approved
`repository@sha256:<64hex>` ref; `PRODUCTION_EXPECTED_{SOURCE_SHA,API_IMAGE,DATABASE_NAME,DATABASE_USER,TARGET_SHA256,AUDIT_SCHEMA_FINGERPRINT_SHA256,PRE_MIGRATION_BACKUP_EVIDENCE_SHA256,BACKUP_INTEGRITY_SHA256,0096_0107_TRANSITION_CHAIN_SHA256,ACTIVATION_APPROVAL_SHA256}`;
and matching raw `PRODUCTION_AUDIT_0107_{TARGET,INTENT,EXECUTION,STEADY,RELEASE}_EVIDENCE_B64/_SHA256`
pairs, `PRODUCTION_ACTIVATION_APPROVAL_EVIDENCE_B64/_SHA256`, and
`PRODUCTION_HOST_ATTESTATION_B64` plus
`PRODUCTION_HOST_ATTESTATION_SIGNATURE_B64`. None has a mutable or discovery
fallback. The old unprefixed
`AUDIT_0107_*` variables belong only to the staging/control-plane v5 checker and
are not accepted by production API startup.

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

### Startup release guard (fail closed before serving)

This tree contains the in-process validator, canonical serialization helper,
read-only production host observer, detached-signature verifier and the
pre-import production startup wiring. Manually completing self-consistent JSON
is not observed production evidence and does not make this rollout ready. Both
reviewed public-key maps are intentionally empty until their separate offline
custody ceremonies are completed, so the shipped production adapter currently
fails closed with `PRODUCTION_HOST_TRUST_ROOT_UNPROVISIONED`. Activation also
requires source-pinned publisher provenance trust, fresh canonical observations
and signatures over the exact reviewed release chain.

The safe image command is `node --enable-source-maps /app/dist/index.mjs`.
`dist/index.mjs` performs the guard in-process before dynamically importing the
Express app, opening the port or loading workers. The safe runtime image does
not contain `dist/migrate.mjs` or mutating gate entrypoints. It validates six
canonical production artifacts against separately configured SHA-256 values:

1. the exact Coolify production target and immutable images;
2. the exact pre-transition production intent;
3. the exact one-shot production execution, which must preserve the intent
   binding and by design does **not** authorize API startup;
4. the later read-only steady-0107 proof, which binds the live database identity,
   exact image SHA, known migration count/hash set, the opaque legacy-row digest,
   live schema fingerprint and `0100` exclusion;
5. the canonical release evidence that binds the target, transition, steady
   state and predecessor release bytes;
6. explicit production start approval over the exact preceding bytes.

The existing schema-v4 exact-0105 release evidence remains a separate immutable
predecessor artifact. Do not edit it into schema v5; v5 records only its exact
file digest and adds the new control artifacts plus release approval. The v5
artifact also binds the reviewed resolved Compose, canonical secret-free
deployment configuration and live Postgres projection digests. These digests
must be copied from the verified host execution and reconciled with the exact
reviewed Coolify view after resolving every pending change; the container does
not query the Coolify control plane and therefore cannot establish that fact by
itself.

The separately signed publisher provenance records the production build profile
and absence of mutating entrypoints. The host producer verifies that detached
signature and binds its subject digest to the live immutable API image ref. A
staging `control-plane` image is not an admissible value for
`PRODUCTION_API_IMAGE`; its baked marker prevents staging-mode startup from the
safe production target.

After startup, a single-flight runtime watchdog revalidates the live journal by
exact `(created_at, hash)` identity plus current database/user and the complete
audit schema fingerprint every 60 seconds. The first mismatch or unverifiable
result permanently trips the in-process readiness latch, so `/api/healthz`
immediately returns 503. Before closing the HTTP server, shutdown synchronously
stops every scheduler and worker timer; the process then exits non-zero and can
restart only through the complete startup guard. This controls the approved
database/schema binding, while host/Coolify state between short-lived signed
observations remains an external monitoring boundary.

The host attestation is intentionally valid for at most 15 minutes. It is a
startup credential, not a renewable lease inside the API: an already running
process does not self-refresh it, while any later container restart must pass
the complete guard with a fresh observation and signature. Consequently, an
expired attestation can produce an intentional restart loop with
`PRODUCTION_HOST_ATTESTATION_EXPIRED`. Configure a **host-level** Coolify/node
alert on repeated container restarts, unhealthy state and non-zero API exits;
an in-process alert is insufficient because the guarded app and its alert
workers never start in this failure mode.

Safe recovery is to stop the restart loop, keep the API unavailable, and use
read-only host/Coolify/PostgreSQL inspection to determine whether the exact
image, desired/deployed configuration, database identity and schema still match
the approved release. Resolve real drift through its separately approved
procedure. Then reacquire the raw projections, produce and review a fresh
short-lived host attestation, sign it offline, update only the public
attestation/signature transport values, and restart the same reviewed immutable
image through the full startup guard. Never extend timestamps, reuse an expired
attestation, disable the guard, add an emergency trust key, switch to the
control-plane image, or repeatedly restart until one attempt happens to pass.

The currently observed Coolify state (one pending Compose change and mutable
image/build references in desired configuration) does **not** satisfy this
contract. Activation remains blocked until pending changes are zero, deployed
and desired canonical digests match, every production image is an approved
immutable digest, and the production host producer emits the complete backup
and 0096→0107 transition-chain evidence.

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

### Restoring from a backup

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

   To restore into the live database, point `-d` at it (stop the API first to
   avoid concurrent writes). `--no-owner --no-acl` avoids role-ownership errors
   when restoring across different Postgres users.

3. Point the app's `DATABASE_URL` at the restored database (or swap it in place)
   only after a separately approved exact migration gate has verified the
   restored lineage. Restarting the production API is read-only and never runs
   migrations.

> **Tip:** periodically test a restore into a throwaway database — an untested
> backup is not a backup.

---

## 6. Building images individually

Both Dockerfiles expect the **repository root** as the build context:

```bash
docker build -f artifacts/api-server/Dockerfile -t stavba-api .
docker build -f artifacts/stavba/Dockerfile     -t stavba-web .
```
