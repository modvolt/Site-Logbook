# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

### Object storage (S3-compatible)

File uploads (photos/documents) are stored in an S3-compatible bucket (MinIO,
Hetzner Object Storage, AWS S3, …). Files are never stored in the database — only
their object paths are. Configure:

- `S3_ENDPOINT` — endpoint URL (e.g. `http://minio:9000`); omit for AWS S3
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

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
