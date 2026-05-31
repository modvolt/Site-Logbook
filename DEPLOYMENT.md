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

### File uploads & the two MinIO endpoints

Uploads use presigned URLs: the browser `PUT`s the file **directly** to MinIO.
A presigned URL's signature is bound to its host, so the host the API signs for
must equal the host the browser uses:

- The **API** reaches MinIO over the internal network at `http://minio:9000`
  (`S3_ENDPOINT`, hard-wired in `docker-compose.yml`).
- The **browser** reaches MinIO via `S3_PUBLIC_ENDPOINT` — `http://localhost:9000`
  locally. The API signs upload URLs with this endpoint so they validate.

If you only have a single endpoint reachable by both (e.g. AWS S3 or a MinIO
subdomain), leave `S3_PUBLIC_ENDPOINT` equal to that endpoint.

---

## 2. Deploy on Coolify

This repo's `docker-compose.yml` is Coolify-ready.

1. **Create resource** → *Docker Compose* → point it at this repository (the
   compose file is at the repo root).
2. **Environment variables** — set everything from `.env.example` in Coolify's
   UI. Use strong values for `POSTGRES_PASSWORD`, `SESSION_SECRET`, and
   `MINIO_ROOT_PASSWORD` (`openssl rand -hex 32`).
3. **Domains / TLS** — Coolify's reverse proxy (Traefik) terminates TLS. Map
   your domain to the **`web`** service (container port `80`). TLS and
   certificates are handled by Coolify; nothing to configure in the app.
4. **Object storage endpoint** — give MinIO a public subdomain (e.g.
   `storage.yourdomain.tld`) and set `S3_PUBLIC_ENDPOINT` to it (HTTPS). The API
   can keep using the internal `http://minio:9000`. Alternatively, point all the
   `S3_*` vars at an external/managed S3 bucket and you can drop the `minio` and
   `createbuckets` services.
5. **Deploy.** Migrations run automatically on each API container start.

### Using managed Postgres / S3 instead of the bundled services

- **Database:** remove the `postgres` service and set `DATABASE_URL` to your
  managed connection string. Migrations still run on API startup.
- **Storage:** remove `minio` + `createbuckets`, set the `S3_*` variables to the
  managed bucket, create the bucket once, and unset `S3_FORCE_PATH_STYLE` (AWS
  uses virtual-hosted style).

---

## 3. Environment variables

| Variable                  | Required | Default       | Notes                                                            |
| ------------------------- | -------- | ------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`            | yes      | —             | Postgres connection string (set by Compose from the vars below). |
| `POSTGRES_USER/PASSWORD/DB` | yes\*  | —             | Used by the bundled `postgres` service to build `DATABASE_URL`.  |
| `SESSION_SECRET`          | yes      | —             | Secret signing session cookies.                                  |
| `PORT`                    | no       | `5000`        | API listen port (inside the container).                          |
| `S3_BUCKET`               | yes      | —             | Bucket for uploads.                                              |
| `S3_ACCESS_KEY_ID`        | yes      | —             | From `MINIO_ROOT_USER` in Compose.                              |
| `S3_SECRET_ACCESS_KEY`    | yes      | —             | From `MINIO_ROOT_PASSWORD` in Compose.                          |
| `S3_ENDPOINT`             | no       | AWS default   | Internal endpoint the API uses (`http://minio:9000` in Compose). |
| `S3_PUBLIC_ENDPOINT`      | no       | `S3_ENDPOINT` | Browser-reachable endpoint for presigned uploads.                |
| `S3_REGION`               | no       | `us-east-1`   |                                                                  |
| `S3_FORCE_PATH_STYLE`     | no       | `false`       | `true` for MinIO / path-style gateways.                         |
| `S3_PRIVATE_PREFIX`       | no       | `private`     | Key prefix for uploaded objects.                                 |
| `S3_PUBLIC_PREFIX`        | no       | `public`      | Comma-separated prefixes for public assets.                      |
| `SMTP_HOST`               | no       | —             | Empty disables outbound email (PDF job sheets).                  |
| `SMTP_PORT`               | no       | `587`         |                                                                  |
| `SMTP_SECURE`             | no       | auto          | `true` for implicit TLS (465).                                   |
| `SMTP_USER/PASSWORD`      | no       | —             | Credentials (optional for open relays).                          |
| `SMTP_FROM`               | no       | `SMTP_USER`   | From address.                                                    |
| `MIGRATIONS_DIR`          | no       | `/app/migrations` | Where the API reads SQL migrations (set in the image).      |

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

## 5. Building images individually

Both Dockerfiles expect the **repository root** as the build context:

```bash
docker build -f artifacts/api-server/Dockerfile -t stavba-api .
docker build -f artifacts/stavba/Dockerfile     -t stavba-web .
```
