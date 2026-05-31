---
name: Bulk import / upsert endpoints
description: Conventions for CSV/price-list style bulk import endpoints (lenient validation, partial update, code matching)
---

# Bulk import / upsert endpoints

Rules learned building the supplier price-list import (Sklad / warehouse-items).

- **Do NOT reuse the strict create schema for the import item.** The create
  schema enforces `name` minLength(1); reusing it makes a single bad row 400 the
  **entire batch**. Define a separate lenient import-item schema (e.g.
  `WarehouseImportItem`, `name` is plain string) and skip+count invalid rows
  server-side, returning `{created, updated, skipped}`.
  **Why:** the task contract surfaces a "skipped" count; a strict schema makes
  that count impossible because the whole request is rejected first.

- **Updates must be PARTIAL.** Build the update `set` from only the fields the
  caller actually provided (`raw.field !== undefined`). Never coerce missing
  optional fields to `null` — a partial supplier file (code + price only) would
  otherwise wipe category/unit/other prices on matched rows.
  **How to apply:** insert path may include all fields (+code); update path only
  the provided ones. The frontend already omits empty fields, so undefined =
  "leave as-is".

- **Match by code case-insensitively** (`code.trim().toLowerCase()`), and add
  newly-inserted codes into the in-transaction map so duplicate codes within one
  file resolve to update (not duplicate insert). Run the whole import in one
  `db.transaction`.

- Czech CSV normalization lives client-side: strip spaces/nbsp/`Kč`, comma→dot
  before sending numbers as JSON numbers (papaparse with auto delimiter handles
  `;`).
