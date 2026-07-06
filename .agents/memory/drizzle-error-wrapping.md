---
name: Drizzle error wrapping hides pg .code/.constraint
description: node-postgres driver errors carrying .code/.constraint (e.g. unique violation 23505) get wrapped by drizzle-orm before reaching your catch block.
---

When drizzle-orm (node-postgres driver) throws from an insert/update, the error
your `catch` sees is a `DrizzleQueryError`, not the raw `pg` error. The raw pg
error (with `.code`, `.constraint`, `.detail`, etc.) is attached as `.cause`.

**Why:** A duplicate-key catch that only checks `err.code === "23505"` on the
top-level error silently never matches — the violation is real (confirmed by
the DB), but the catch's own detection logic is broken, so the error rethrows
as an unhandled 500 instead of being converted into a normal "duplicate"
result. This is easy to miss because integration tests using a mocked DB layer
won't surface it — it only shows up against a real Postgres connection.

**How to apply:** Any helper that inspects a caught DB error for a specific pg
error code/constraint must check both `err` and `err.cause`:

```ts
for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
  if (typeof candidate !== "object" || candidate === null || !("code" in candidate)) continue;
  if ((candidate as { code: unknown }).code !== "23505") continue;
  // ...
}
```

Verify with a real DB-backed test that induces the actual constraint violation
(e.g. two concurrent inserts of the same unique value) — a test using a mocked
db client would never catch this.
