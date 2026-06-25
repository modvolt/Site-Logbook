---
name: EmailImportMessage field names
description: Correct field names on EmailImportMessage and EmailImportAttachment API types
---

The generated `EmailImportMessage` type uses:
- `sentAt` — not `receivedAt`
- `error` — not `errorMessage`

The generated `EmailImportAttachment` type uses:
- `billingDocumentId` — not `documentId`

**Why:** These are the OpenAPI schema field names (8791–8840 in openapi.yaml). Using wrong names causes TS2339 runtime-silent type errors that only show up in tsc typecheck.

**How to apply:** Any component that renders email import messages must use these exact names or the build fails.
