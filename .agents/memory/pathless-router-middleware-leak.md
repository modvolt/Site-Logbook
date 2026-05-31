---
name: Pathless router middleware leak
description: In api-server, all sub-routers mount pathlessly, so a pathless router.use(auth) inside any of them gates EVERY request, not just that router's routes.
---

# Pathless `router.use(middleware)` leaks across the whole router chain

`artifacts/api-server/src/routes/index.ts` mounts every sub-router pathlessly
(`router.use(jobsRouter)`, `router.use(authRouter)`, …). Express therefore runs
**every** sub-router's middleware stack for **every** request, in mount order,
until one handles the response.

**Rule:** never put a pathless `router.use(requireAuth | requireRole | any
gate)` inside a sub-router. It runs for every request flowing through the chain
— including paths that belong to *other* routers — and terminates them.

**Why:** the `device-credentials` router had `router.use(requireRole("master",
"admin"))` (pathless) and was mounted *before* `authRouter`. Result:
unauthenticated `POST /auth/login` and `GET /auth/me` hit that role gate and got
`401` before ever reaching the auth handler. The app only *appeared* to work
because an already-logged-in admin passed the role check; on a fresh session
nobody could log in. Non-elevated authenticated users (guests) were also blocked
from every router mounted after device-credentials.

**How to apply:**
- Gate per-route: `router.get("/path", requireRole(...), handler)`.
- Or scope the `use` to a path: `router.use("/path", gate)` — but only when all
  of the router's routes share that prefix.
- A path-scoped `router.use("/backups", gate)` is fine (it won't leak); a
  pathless one is the hazard.
- When adding any new gated router, mind mount order relative to `authRouter`
  and `storageRouter`, but prefer per-route gating so order can't bite you.
