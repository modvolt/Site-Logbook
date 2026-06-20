# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only, interactive)
- `pnpm --filter @workspace/db run generate` — generate versioned SQL migrations (commit them; used for production deploys)
- `pnpm --filter @workspace/db run migrate` — apply pending migrations non-interactively (`DATABASE_URL` required)
- Required env: `DATABASE_URL` — Postgres connection string; `SESSION_SECRET` — signs session cookies
- Optional env: `CORS_ORIGINS` — comma-separated allowlist of cross-origin origins. Unset = cross-origin blocked (the web app is same-origin behind nginx, so this is the safe default)

## Deploy (Docker / Coolify)

The app is fully containerized and self-hostable (no Replit infra). See
**`DEPLOYMENT.md`** for the full guide. Quick start:

- `cp .env.example .env` then `docker compose up --build` → app on <http://localhost:8080>
- Stack: PostgreSQL + MinIO (S3) + API (`artifacts/api-server/Dockerfile`) + web/PWA (`artifacts/stavba/Dockerfile`, nginx serving static assets and reverse-proxying `/api`).
- The API container applies SQL migrations on startup (`dist/migrate.mjs`), replacing interactive `drizzle-kit push` for production.
- Production builds skip the Replit-only Vite plugins (gated on `REPL_ID`).

### Object storage (S3-compatible)

File uploads (photos/documents) are stored in an S3-compatible bucket (MinIO,
Hetzner Object Storage, AWS S3, …). Files are never stored in the database — only
their object paths are. Configure:

- `S3_ENDPOINT` — endpoint the API uses (e.g. `http://minio:9000`); omit for AWS S3
- `S3_REGION` — region (default `us-east-1`)
- `S3_BUCKET` — bucket name (required)
- `S3_ACCESS_KEY_ID` — access key (required)
- `S3_SECRET_ACCESS_KEY` — secret key (required)
- `S3_FORCE_PATH_STYLE` — `true` for MinIO / path-style gateways (default `false`)
- `S3_PRIVATE_PREFIX` — key prefix for uploaded objects (default `private`)
- `S3_PUBLIC_PREFIX` — comma-separated prefixes for public assets (default `public`)

### Email (SMTP)

The job-sheet PDF is emailed to the customer via SMTP. Configure:

- `SMTP_HOST` — SMTP server host (required to send email)
- `SMTP_PORT` — port (default `587`)
- `SMTP_SECURE` — `true` for implicit TLS (port 465); defaults to `true` when port is 465
- `SMTP_USER` / `SMTP_PASSWORD` — credentials (optional for open relays)
- `SMTP_FROM` — From address (falls back to `SMTP_USER`)

### AI document extraction (OpenAI)

Optional. When configured **and** enabled, uploaded cost-document PDFs/photos are
extracted by OpenAI to **prefill** the header + lines. The result is **never**
auto-approved — it is saved as a `needs_review` suggestion (`ai_raw_json`,
`ai_confidence`, `ai_model`) for an admin to confirm; confidence < 0.7 is flagged.
The app works fully without OpenAI (documents route to manual review). Self-hosted
prod uses the operator's **own** OpenAI key (no Replit proxy off-Replit); the key
is read from env only, never stored in the DB or logged. Status + a no-document
"test configuration" action live on `/billing/settings` (admin-only). Configure:

- `OPENAI_API_KEY` — operator's OpenAI key; empty disables extraction
- `OPENAI_DOCUMENT_EXTRACTION_ENABLED` — master switch; runs only when exactly `true` (default `false`)
- `OPENAI_DOCUMENT_MODEL` — vision/file-capable model (default `gpt-4o`)
- `OPENAI_MAX_FILE_MB` — max input file size sent to OpenAI (default `20`)
- `OPENAI_REQUEST_TIMEOUT_MS` — per-request timeout in ms (default `60000`)

### Gmail / Google Workspace import (OAuth)

Optional + fully modular. When configured **and** an admin connects a Google
account, supplier cost-document attachments (PDFs/photos) are imported from Gmail
into Fakturace as `billing_documents` (`source="email"`) for review — never
auto-approved. Off by default; the app works fully without it (manual upload
always available). OAuth refresh tokens are encrypted at rest (AES-256-GCM) with
`TOKEN_ENCRYPTION_KEY`; only the encrypted token is stored, never logged.
Attachments are deduped by SHA-256 and stored in the private object bucket (only
the object path is stored in the DB). Connect/disconnect/sync are audited.
Admin-only UI at `/billing/email-import`. The redirect URI must point at
`/api/billing/email-import/callback`. Labels are configured in the UI (multi-label)
and stored per-account; the `GMAIL_*` env vars are only defaults. Configure:

- `GOOGLE_CLIENT_ID` — OAuth web-client id; empty disables the feature
- `GOOGLE_CLIENT_SECRET` — OAuth web-client secret
- `GOOGLE_REDIRECT_URI` — full callback URL (`…/api/billing/email-import/callback`)
- `TOKEN_ENCRYPTION_KEY` — required; AES-256-GCM key (e.g. `openssl rand -base64 32`)
- `GMAIL_LABEL` — default label(s), comma-separated; empty = whole mailbox
- `GMAIL_QUERY` — extra Gmail search query (e.g. `has:attachment`)
- `GMAIL_MAX_MESSAGES` — max messages fetched per sync (default `50`)
- `GMAIL_LABEL_AFTER_IMPORT` — `true` to label processed emails so they aren't re-fetched (default `false`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

- Routers in `artifacts/api-server/src/routes/index.ts` are mounted **pathlessly**
  (`router.use(jobsRouter)`), so every request flows through every router in order.
  Never use a pathless `router.use(requireAuth/requireRole)` inside a sub-router —
  it leaks to all downstream routers. Apply auth/role middleware **per-route**.
- Auth is gated centrally in `app.ts` via `PUBLIC_PREFIXES` allowlist + `requireAuth`;
  public paths are `/api/healthz`, `/api/auth/`, `/api/storage/public-objects/`.
- DB backups are `pg_dump -Fc` (custom format) uploaded to the uploads bucket under
  `backups/`; only the object path is stored, never the dump bytes, in DB.

## Product

Stavba is a Czech construction job tracker for Modvolt s.r.o.: jobs/tasks,
materials, people, customers (with sites & contacts), a device-credential vault
(admin-only), time entries, dashboard/stats, audit log, GDPR erase, PDF job
sheets emailed to customers, an installable PWA with offline shell, and
admin-managed automated database backups.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Sub-routers are mounted pathlessly in `routes/index.ts`; a pathless
  `router.use(requireAuth/requireRole)` inside any sub-router 401s **all**
  downstream routes. Always gate per-route.
- `backup_log` in dev was created via direct `psql` (drizzle migrate replay can
  fail on `0000` in dev). Never blind `push --force` (can drop `user_sessions`).
- Dev DB admin (`admin` / role admin) password is `admin` (reset directly in the
  dev Postgres for convenient local testing). Change it in Settings; this only
  affects the dev database, never production.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
