---
name: drizzle node-postgres .execute() returns QueryResult
description: raw sql .execute() on the node-postgres driver returns {rows}, not an array
---

`db.execute(sql\`...\`)` / `tx.execute(...)` on `drizzle-orm/node-postgres` resolves to a
pg `QueryResult` **object** with a `.rows` array — it is NOT itself an array.

**Why:** destructuring `const [row] = await tx.execute(...)` throws a runtime
`TypeError` (QueryResult is not iterable) → request 500s, and the `as unknown as Array<...>`
cast hides it from the typechecker so it only surfaces at runtime.

**How to apply:** read raw-SQL results as
`const res = (await tx.execute(sql\`...\`)) as unknown as { rows: Array<{...}> };`
then use `res.rows[0]`. (Neon/other drivers differ — this note is specifically the
node-postgres driver used by `@workspace/db`.)
