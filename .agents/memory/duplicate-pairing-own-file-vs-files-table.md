---
name: Duplicate pairing own-file vs billingDocumentFilesTable
description: Why a paired duplicate's file can appear missing even though linkAsDuplicateTx never deletes anything
---

When surfacing files for a cost document's linked duplicate / primary
(`linkedDuplicates[].files`, `duplicateOf.files`), querying only
`billingDocumentFilesTable` by `documentId` is not enough — it will show
"no file" for the common case of a plain single-file document.

**Why:** each document's originally-ingested file lives in its own
top-level `objectPath`/`fileName`/`contentType` columns on
`billingDocumentsTable`, not in `billingDocumentFilesTable`. Pairing
(`linkAsDuplicateTx`) only moves the *extra* role-tagged
`billingDocumentFilesTable` rows to the primary; the top-level columns on
both documents are left untouched by design (so nothing is ever deleted).
A doc with just one uploaded file has zero `billingDocumentFilesTable`
rows, so a query scoped to that table alone returns empty.

**How to apply:** when serializing a document's files for cross-document
display (duplicate pairing, merges, etc.), synthesize a file entry from
the doc's own top-level `objectPath`/`fileName`/`contentType` (if
`objectPath` is set) and merge it with any `billingDocumentFilesTable`
rows for that doc id — don't rely on one source alone.
