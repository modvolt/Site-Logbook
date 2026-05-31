---
name: Vite config env requirements at build time
description: Why stavba's vite.config.ts must not require PORT during build, and the PWA precache size cap
---

# Vite build-time env requirements (stavba PWA)

Two things break a production `vite build` (Docker / Coolify / any non-Replit CI)
for `@workspace/stavba`:

## 1. Do not require PORT during `build`

`vite.config.ts` validates env vars at module load. `PORT` is only used by the
dev/preview server (`server.port` / `preview.port`), **never** by `vite build`.
Gate the PORT requirement on `command === "serve"` inside the function form of
`defineConfig(async ({ command }) => …)`. `BASE_PATH` is still required in all
modes (it sets `base` and the PWA manifest `start_url`/`scope`).

**Why:** Coolify/buildpack runs the build command without a runtime `PORT`, so a
top-level `throw` on missing PORT fails the build before it starts. The Replit
dev workflow always sets PORT, so it kept passing locally and masked the bug.

**How to apply:** When adding env validation to a Vite config, ask whether the
var is needed for *build* or only for *serve*. Only enforce serve-only vars when
`command === "serve"`. The config function must be `async` because the
Replit-only dev plugins use top-level `await import(...)`.

## 2. PWA precache size cap

vite-plugin-pwa (workbox) refuses to precache files over 2 MiB by default and
**fails the build**. The stavba main bundle is ~2.3 MB, so set
`workbox.maximumFileSizeToCacheInBytes` high enough (currently 6 MiB) to precache
the full offline app shell.

**Why:** Production builds previously failed at the PORT check, so this second
blocker was never reached until PORT was fixed.

**How to apply:** If the main chunk grows past the cap again, either raise the
limit or code-split to shrink the largest chunk (reduces SW update payload too).
