---
name: Per-category material markup rules
description: Case-insensitive category uniqueness + drizzle onConflict limitation for functional unique indexes
---

# Per-category material markup rules

Material markup resolution chain for invoices:
per-line override → category default → invoice default → settings default.
A job material's category is resolved from the matching warehouse item's
`category` (matched by normalized name). When no category rule matches,
resolution falls through to the single global markup, so the feature degrades
cleanly to the prior single-markup behaviour. Override of `0` is a deliberate
opt-out (no markup); null/NaN/negative falls through to the next layer.

## Case-insensitive category uniqueness

`material_markup_rules.category` is unique **case-insensitively**: the unique
index is functional — `CREATE UNIQUE INDEX ... ON (lower(category))`. The
resolver lowercases both sides when mapping warehouse categories → markup, so a
case-sensitive unique index would let "Kabeláž" and "kabeláž" both exist and one
would silently shadow the other.

**Why:** a plain `uniqueIndex().on(t.category)` is case-sensitive and produced
duplicate rules that the resolver then merged non-deterministically.

**How to apply:** in the drizzle schema use
`uniqueIndex(...).on(sql\`lower(${t.category})\`)`.

## Drizzle onConflict cannot target a functional index

drizzle-orm pg `onConflictDoUpdate({ target })` only accepts `IndexColumn |
IndexColumn[]` at the type level — passing a `sql\`lower(col)\`` expression is a
TS2322 error. Do **not** fight the types. Instead do an explicit
lookup-then-update/insert inside a single `db.transaction`: select where
`lower(category) = lower(input)`, update by id if found, else insert. This keeps
the upsert race-safe and honours the case-insensitive index.
