---
name: Health check migrations folder path
description: resolveMigrationsFolder in health.ts must go up 3 levels from import.meta.url (not 4), because in the esbuild bundle the entry is dist/index.mjs — one level shallower than the TypeScript source.
---

## Rule
`resolveMigrationsFolder()` in `health.ts` uses `import.meta.url` which in the esbuild bundle points to `artifacts/api-server/dist/index.mjs`. Going up 3 levels reaches the workspace root; going up 4 lands in `/home/runner` (parent of workspace).

## Why
The original comment said "artifacts/api-server/src/routes → up 4 → workspace root", which is correct for the TypeScript source path (src/routes is 4 deep from workspace root). But esbuild bundles everything into a single `dist/index.mjs`, so `import.meta.url` in the bundle is only 3 levels deep (`dist` → `api-server` → `artifacts` → workspace root).

## How to apply
- Correct: 3× `..` → `lib/db/migrations`
- Wrong: 4× `..` → `/home/runner/lib/db/migrations` (doesn't exist → journal unreadable → `migrationParity: false` → healthz returns 503 on every request)
- Override with env var `MIGRATIONS_DIR` if the path ever needs changing without code edit.
