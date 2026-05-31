---
name: Attachment type-based section separation
description: Jobs and activities store all attachments in one list keyed by a free-string `type`; UI sections must filter by type or content leaks across sections.
---

Both jobs and activities expose a single attachments list (one query/cache key per
parent). Documents and photos are distinguished only by the attachment's
free-string `type` field — there is no enum constraint on it (server spreads
`parsed.data` straight into the insert, OpenAPI types it as plain `string`).

Convention for `type` values: `photo` (site photos), and `receipt` / `invoice` /
`delivery_note` (doklady). Uploads pick `receipt` for images, `invoice` for
non-image files (e.g. PDFs).

**Rule:** every UI section that renders attachments MUST filter the shared list by
type, or items leak across sections. Photos section → `type === "photo"` (use
`(a.type ?? "photo") === "photo"` to keep legacy null-typed photos visible).
Doklady section → `["invoice","receipt","delivery_note"].includes(a.type)`.

**Why:** activity photos and doklady share one list; before filtering was added,
adding a Doklady section made receipts/invoices show up in the photo grid.

**How to apply:** when adding any new attachment-backed section (jobs or
activities), filter by `type` on read and set a distinct `type` on create. Mirror
the jobs `DokladySection` pattern for activities.
