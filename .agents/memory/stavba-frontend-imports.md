---
name: Stavba frontend generated imports
description: Where the stavba web artifact imports generated API hooks and types from
---

The `@workspace/stavba` artifact depends only on `@workspace/api-client-react`,
NOT on `@workspace/api-zod`. Import generated hooks, query-key helpers, AND
param/response types (e.g. `ListAuditLogsParams`) all from
`@workspace/api-client-react` — the param/schema types are re-exported there.

**Why:** Importing types from `@workspace/api-zod` in a stavba page fails
typecheck (`TS2307 Cannot find module '@workspace/api-zod'`) because that
package isn't a dependency of the artifact.

**How to apply:** In any `artifacts/stavba/src` file, pull both runtime hooks
and `type` imports from `@workspace/api-client-react`.
