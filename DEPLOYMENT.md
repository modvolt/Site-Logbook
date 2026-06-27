# Deploying Stavba

Stavba runs anywhere Docker runs — no Replit infrastructure required. The stack
is four services:

| Service     | Image / source                       | Purpose                                   |
| ----------- | ------------------------------------- | ----------------------------------------- |
| `postgres`  | `postgres:16-alpine`                  | Application database                       |
| `minio`     | `minio/minio`                         | S3-compatible object storage for uploads  |
| `api`       | `artifacts/api-server/Dockerfile`     | REST API (Express) + DB migrations        |
| `web`       | `artifacts/stavba/Dockerfile`         | PWA static assets + `/api` reverse proxy  |

The **web** container is the single public entrypoint: it serves the built PWA
and reverse-proxies `/api/*` to the API container, so the browser always talks
to one origin (the session cookie depends on this).

---

## 1. Run locally with Docker Compose

```bash
cp .env.example .env      # then edit the secrets
docker compose up --build
```

Then open <http://localhost:8080>.

What happens on startup:

1. `postgres` and `minio` start; a one-shot `createbuckets` job creates the
   `S3_BUCKET` bucket.
2. `api` starts, **applies all pending SQL migrations** (`dist/migrate.mjs`),
   then serves the API on port 5000.
3. `web` (nginx) serves the PWA on port 8080 and proxies `/api` to `api`.

To stop and wipe data: `docker compose down -v`.

### File uploads

Uploads are **proxied through the API**: the browser `POST`s the file to
`/api/storage/uploads` (same origin as the app), and the API streams it into the
bucket server-side. The browser never talks to the storage host directly, which
means:

- The **API** reaches storage over `S3_ENDPOINT` (`http://minio:9000` internally
  in Compose). This is the only storage endpoint that has to be reachable.
- There is **no** browser-reachable storage endpoint to configure and **no CORS**
  to set up on the bucket — the bytes flow browser → nginx → API → bucket.

Because uploads pass through nginx, `client_max_body_size` in
`artifacts/stavba/nginx.conf` (currently `100m`) must stay at/above the API's
limits — binary photo/document uploads are capped at 100 MB, and JSON/form
bulk-import payloads at `MAX_REQUEST_BODY_MB` (default 50 MB) — or large requests
are rejected by nginx with a 413 before reaching the API.

**Endpoint scheme:** endpoint values may omit the scheme — `fsn1.your-objectstorage.com`
is normalized to `https://fsn1.your-objectstorage.com`. To force plain HTTP
(e.g. an internal MinIO at `minio:9000`), write the scheme explicitly:
`http://minio:9000`.

---

## 2. Deploy on Coolify

This repo's `docker-compose.yml` is Coolify-ready.

1. **Create resource** → *Docker Compose* → point it at this repository (the
   compose file is at the repo root).
2. **Environment variables** — set everything from `.env.example` in Coolify's
   UI. Use strong values for `POSTGRES_PASSWORD`, `SESSION_SECRET`, and
   `S3_SECRET_ACCESS_KEY` (`openssl rand -hex 32`).
3. **Domains / TLS** — Coolify's reverse proxy (Traefik) terminates TLS. Map
   your domain to the **`web`** service (container port `80`). TLS and
   certificates are handled by Coolify; nothing to configure in the app.
4. **Object storage** — the API reaches MinIO over the internal
   `http://minio:9000`; no public storage subdomain or bucket CORS is needed,
   since uploads are proxied through the API. Alternatively, point all the
   `S3_*` vars at an external/managed S3 bucket and you can drop the `minio` and
   `createbuckets` services.
5. **Deploy.** Migrations run automatically on each API container start.

### Using managed Postgres / S3 instead of the bundled services

- **Database:** remove the `postgres` service and set `DATABASE_URL` to your
  managed connection string. Migrations still run on API startup.
- **Storage:** point the API at the external bucket by setting `S3_ENDPOINT`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` and `S3_FORCE_PATH_STYLE`
  in your environment (these override the bundled-MinIO defaults). Create the
  bucket once on the provider. For AWS S3 set `S3_FORCE_PATH_STYLE=false`
  (virtual-hosted style); for Hetzner/MinIO keep it `true`.
  - You can leave the bundled `minio` + `createbuckets` services running (they
    sit unused), **or** remove them — but if you remove them you must also remove
    the `createbuckets` entry under `api.depends_on`, otherwise Compose refuses to
    start the API (it waits on a service that no longer exists).

---

## 3. Environment variables

| Variable                  | Required | Default       | Notes                                                            |
| ------------------------- | -------- | ------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`            | yes      | —             | Postgres connection string (set by Compose from the vars below). |
| `POSTGRES_USER/PASSWORD/DB` | yes\*  | —             | Used by the bundled `postgres` service to build `DATABASE_URL`.  |
| `SESSION_SECRET`          | yes      | —             | Secret signing session cookies.                                  |
| `PORT`                    | no       | `5000`        | API listen port (inside the container).                          |
| `S3_BUCKET`               | yes      | —             | Bucket for uploads.                                              |
| `S3_ACCESS_KEY_ID`        | yes      | —             | Access key. Single credential pair for both the API and bundled MinIO; set to the provider's key for external S3. |
| `S3_SECRET_ACCESS_KEY`    | yes      | —             | Secret key (>= 8 chars for MinIO). Set to the provider's secret for external S3. |
| `S3_ENDPOINT`             | no       | `http://minio:9000` | Endpoint the API uses to reach storage. Override for external S3 (e.g. `https://fsn1.your-objectstorage.com`). |
| `S3_REGION`               | no       | `us-east-1`   |                                                                  |
| `S3_FORCE_PATH_STYLE`     | no       | `true`        | Compose default `true` (MinIO/Hetzner path-style). Set `false` for AWS virtual-hosted style. |
| `S3_PRIVATE_PREFIX`       | no       | `private`     | Key prefix for uploaded objects.                                 |
| `S3_PUBLIC_PREFIX`        | no       | `public`      | Comma-separated prefixes for public assets.                      |
| `SMTP_HOST`               | no       | —             | Empty disables outbound email (PDF job sheets).                  |
| `SMTP_PORT`               | no       | `587`         |                                                                  |
| `SMTP_SECURE`             | no       | auto          | `true` for implicit TLS (465).                                   |
| `SMTP_USER/PASSWORD`      | no       | —             | Credentials (optional for open relays).                          |
| `SMTP_FROM`               | no       | `SMTP_USER`   | From address.                                                    |
| `OPENAI_API_KEY`          | no       | —             | Empty disables AI cost-document extraction (manual review still works). Your own OpenAI key. |
| `OPENAI_DOCUMENT_EXTRACTION_ENABLED` | no | `false` | Master switch; extraction runs only when exactly `true`.         |
| `OPENAI_DOCUMENT_MODEL`   | no       | `gpt-4o`      | Vision/file-capable model used for extraction.                   |
| `OPENAI_MAX_FILE_MB`      | no       | `32`          | Max input file size sent to OpenAI. OpenAI caps inputs (~32 MB/PDF, ~20 MB/image); higher has no effect. |
| `OPENAI_REQUEST_TIMEOUT_MS` | no     | `60000`       | Per-request timeout to OpenAI (ms).                             |
| `BACKUP_ENABLED`          | no       | `true`        | `false` disables scheduled backups (manual still works).         |
| `BACKUP_INTERVAL_HOURS`   | no       | `24`          | Hours between scheduled backups.                                 |
| `BACKUP_RETENTION`        | no       | `14`          | Most-recent successful backups to keep; older ones are pruned.    |
| `PG_DUMP_PATH`            | no       | `pg_dump`     | Path to the `pg_dump` binary if not on `PATH`.                   |
| `MIGRATIONS_DIR`          | no       | `/app/migrations` | Where the API reads SQL migrations (set in the image).      |
| `MAX_REQUEST_BODY_MB`     | no       | `50`          | Max JSON/form body size (CSV bulk imports, base64 uploads). Raise nginx `client_max_body_size` too if set above 100. |

\* Required when using the bundled `postgres` service; otherwise supply
`DATABASE_URL` directly.

---

## 4. Database migrations

Production uses **non-interactive, file-based migrations** instead of
`drizzle-kit push`.

- Generate migration SQL after changing the schema (`lib/db/src/schema`):

  ```bash
  pnpm --filter @workspace/db run generate
  ```

  This writes versioned SQL + snapshots under `lib/db/migrations` — **commit
  them**. They are baked into the API image and applied on startup.

- Apply migrations manually against a database (rarely needed; the API does this
  automatically on boot):

  ```bash
  DATABASE_URL=postgres://… pnpm --filter @workspace/db run migrate
  ```

- `pnpm --filter @workspace/db run push` remains available for **local dev
  only** — never use it against production.

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
   and restart the API. Migrations are idempotent and run on boot.

> **Tip:** periodically test a restore into a throwaway database — an untested
> backup is not a backup.

---

## 6. Building images individually

Both Dockerfiles expect the **repository root** as the build context:

```bash
docker build -f artifacts/api-server/Dockerfile -t stavba-api .
docker build -f artifacts/stavba/Dockerfile     -t stavba-web .
```

## 7. Build runs out of memory on a small host (4 GB)

`docker compose up --build` builds the **api** and **web** images **in
parallel**. Each one runs a full `pnpm install` plus a build (the web image's
vite/rollup build is the heavier of the two). On a small box (e.g. 2 vCPU /
4 GB) the two parallel builds can exhaust RAM and the kernel OOM-killer kills a
build — the deploy then appears to "hang" or fail mid-build.

The repo already caps the Node heap of each build (`NODE_OPTIONS=--max-old-space-size`
in both Dockerfiles) so a single build can't size its heap to the whole
machine. On a 4 GB host also apply **one** of these so the two builds don't
peak at the same time:

- **Add swap** (simplest, recommended — the build spike is brief):

  ```bash
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # persist across reboots
  ```

- **Build the images sequentially** instead of in parallel. In the Coolify
  resource's environment (or the shell that runs compose) set:

  ```bash
  COMPOSE_BAKE=false
  COMPOSE_PARALLEL_LIMIT=1
  ```

  `COMPOSE_BAKE=false` uses the classic builder (which honours
  `COMPOSE_PARALLEL_LIMIT`), so the web image builds only after the api image
  finishes — roughly halving peak build memory.

Runtime memory is not the issue here; both containers are small at rest. This
only concerns the **build** phase.
