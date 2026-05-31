---
name: api-zod request-body validator names
description: How to import generated Zod request-body validators in api-server routes (Orval naming convention)
---

Server routes validate request bodies with Zod schemas from `@workspace/api-zod`,
but the exported names are derived from the **operationId**, not from the OpenAPI
component schema names.

**Rule:** for an operation with `operationId: updateEmailSettings` and a JSON body,
the generated validator is `UpdateEmailSettingsBody` (PascalCase(operationId) + `Body`).
Responses are `...Response`, path/query params are `...Params`/`...QueryParams`.
The component schema names you wrote under `components.schemas` (e.g.
`EmailSettingsInput`, `EmailTestInput`) are **only types**, not runtime Zod values —
importing them as values fails with TS2693 ("only refers to a type, used as a value").

**Why:** Orval names zod exports after the operation, independent of the request-body
schema's component name. Easy to guess wrong because you naturally reach for the
component schema name you authored.

**How to apply:** after `pnpm --filter @workspace/api-spec run codegen`, grep
`lib/api-zod/src/generated/api.ts` for `...Body`/`...Response` to get the exact export
name before importing. See `artifacts/api-server/src/routes/email-settings.ts` and the
preferences route for examples.
