---
name: Cost-document detail page assumed one file per document
description: billing-document-detail.tsx only rendered doc.objectPath (one file); multi-file docs silently hid page 2+ until fixed to iterate doc.files
---

The cost-document detail page (`billing-document-detail.tsx`) was written when
every `billing_documents` row had exactly one attached file (`doc.objectPath`).
Its "Zobrazit soubor" button and `AttachmentViewer` only ever pointed at that
single field.

When multi-page photo-group uploads were added (one document, many
`billing_document_files` rows returned in `GetCostDocument`'s `files[]`), the
backend and API contract were updated correctly, but the detail page was not —
it kept using only `doc.objectPath`, so page 2+ of a merged document was
completely invisible in the UI even though it was stored and returned by the
API. E2E testing (not typecheck or unit tests) is what caught this, since the
API-level checks all passed.

**Why:** any future feature that makes `files[]` legitimately hold >1 entry
must double check every screen that historically assumed "a cost document has
one file" — grep for `doc.objectPath` / `attachmentUrl(doc...)` outside of
`files.map`.

**How to apply:** when adding/changing multi-file support on an entity that
used to be single-file, render from the files/attachments array everywhere,
not just the legacy single field, and verify with a real e2e click-through
(not just an API/unit test) that every page becomes visible in the UI.
