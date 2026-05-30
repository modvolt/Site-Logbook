---
name: Vite peer-variant typecheck conflicts
description: Why adding a vite plugin to one artifact can break another artifact's typecheck, and how to fix it
---

# Vite peer-variant typecheck conflicts

When two artifacts both depend on `vite`, pnpm resolves vite with a hashed peer
set (the parenthesized suffix in the lockfile / the `_` suffix in
`node_modules/.pnpm/`). If the peer sets differ, there are **two distinct vite
type instances**, and TS reports errors like:

> Type '...vite@7.3.3_..._tsx_yaml/.../HotUpdateOptions' is not assignable to
> '...vite@7.3.3_...terser..._tsx_yaml/.../HotUpdateOptions'

**Why:** `vite-plugin-pwa` depends on `terser`, which is an *optional peer* of
vite. Adding the PWA plugin to one artifact (stavba) makes its vite resolve
*with* terser, while another vite consumer (mockup-sandbox) still resolves
*without* terser → two instances → cross-package type clash.

**How to apply:** unify the peer set across all vite consumers. The minimal fix
is to add the same peer (`terser`) as a devDependency to the other vite
artifact(s) so every `vite` resolves to one instance. `pnpm dedupe` will NOT
merge them because the peer sets are genuinely different. After fixing, run
`pnpm run typecheck` (root) — trust it over per-package/editor state.
