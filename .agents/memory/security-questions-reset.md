---
name: Security-questions password reset
description: Admin-only forgot-password via security questions — where authed vs public routes must live, and answer handling.
---

Admin-only password reset built on a `security_questions` table (per-user, 3 rows
keyed by `position`, answers bcrypt-hashed, never plaintext).

**Public vs authed route placement (the gotcha):** `/api/auth/` is in
`PUBLIC_PREFIXES` (app.ts), so anything mounted under `/auth/` bypasses
`requireAuth`. Therefore:
- The *authed* setup/status endpoints must NOT be under `/auth/` — they live in
  `security-questions.ts` at `/security-questions[/status]`, gated per-route with
  `requireAuth` + explicit `req.auth.role === "admin"` check.
- The *public* reset endpoints (`/auth/forgot-password/questions` and
  `/auth/forgot-password/reset`) live in `auth.ts` so they are public, and reuse
  `authLimiter` for brute-force protection.

**Why:** mis-placing the authed routes under `/auth/` would silently make them
public; placing the public ones elsewhere would 401 a logged-out user trying to
recover.

**Answer matching:** normalize with trim + lowercase + collapse-whitespace on
BOTH write and verify (`normalizeAnswer` in security-questions.ts, imported by
auth.ts), else a correct answer with different casing/spacing fails. Reset is
constrained to active `admin` accounts that have all 3 questions configured;
return generic 401/404 to avoid username enumeration.
