---
name: Drizzle snapshot schema field rules
description: Exact field requirements for drizzle-kit v0.31 snapshot Zod validators — what must/must not be present to pass backwardCompatiblePgSchema
---

# Drizzle snapshot schema field rules (drizzle-kit 0.31.10)

## column3 (strict)
Allowed: name, type, typeSchema, primaryKey, notNull, default, isUnique, uniqueName, nullsNotDistinct, generated, identity
**NOT allowed:** `autoincrement` (SQLite-only field)

## index3 (strict)
Allowed: name, columns, isUnique, with, method, where, concurrently
**NOT allowed:** `nullsNotDistinct`
columns must be `indexColumn2` objects: `{expression, isExpression, asc, nulls?, opclass?}`
**NOT allowed:** plain string columns (those are for pgSchemaV5/V6)

## fk3 (strict)
Allowed: name, tableFrom, columnsFrom, tableTo, schemaTo?, columnsTo, onUpdate?, onDelete?
**Required:** `name` (NOT `constraintName` — that was an older format)

## table3 (strict)
Required additional fields vs V5/V6: `isRLSEnabled`, `policies`, `checkConstraints`

## Table `schema` field
Use `""` (empty string) for tables defined with `pgTable()` (no explicit schema).
Use `"public"` ONLY for tables defined via `pgSchema("public").table()`.
Mismatch causes `applyPgSnapshotsDiff` to see a schema change and fail with ZodError on `alteredTablesWithColumns[N].schema` being an object.

**Why:** backwardCompatiblePgSchema is a union([pgSchemaV5, pgSchemaV6, pgSchema]).
For v7 snapshots, the third member (pgSchema) must pass. ALL of its nested validators are `.strict()`.

**How to apply:** When hand-crafting or copying snapshots, validate every column for extra fields, every FK for `name` vs `constraintName`, every index for object columns and no `nullsNotDistinct`.
