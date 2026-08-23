import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../lib/db/migrations/0108_invoice_source_allocations_and_advances.sql",
    import.meta.url,
  ),
  "utf8",
);
const rollback = readFileSync(
  new URL(
    "../../../lib/db/rollbacks/0108_invoice_source_allocations_and_advances.down.sql",
    import.meta.url,
  ),
  "utf8",
);
const invoiceService = readFileSync(
  new URL("../src/lib/invoice-service.ts", import.meta.url),
  "utf8",
);
const openApi = readFileSync(
  new URL("../../../lib/api-spec/openapi.yaml", import.meta.url),
  "utf8",
);

describe("invoice source-allocation migration contract", () => {
  it("stores raw source identity and every required settlement lifecycle state", () => {
    expect(migration).toContain('CREATE TABLE "invoice_source_allocations"');
    for (const column of [
      '"invoice_id_snapshot"',
      '"source_type"',
      '"source_id"',
      '"job_id"',
      '"invoice_line_id"',
      '"original_quantity"',
      '"allocated_quantity"',
      '"settlement_method"',
      '"created_by_user_id"',
      '"updated_by_user_id"',
    ]) {
      expect(migration).toContain(column);
    }
    for (const state of [
      "reserved",
      "billed",
      "included_in_lump_sum",
      "not_charged",
      "deferred",
      "released",
      "reversed",
    ]) {
      expect(migration).toContain(`'${state}'`);
    }
  });

  it("prevents two live invoices from owning one raw source but frees deferred sources", () => {
    const uniqueIndex = migration.match(
      /CREATE UNIQUE INDEX "invoice_source_allocations_active_source_uq"[^;]+;/,
    )?.[0];
    expect(uniqueIndex).toBeTruthy();
    expect(uniqueIndex).toContain("'reserved'");
    expect(uniqueIndex).toContain("'billed'");
    expect(uniqueIndex).toContain("'included_in_lump_sum'");
    expect(uniqueIndex).toContain("'not_charged'");
    expect(uniqueIndex).not.toContain("'deferred'");
    expect(uniqueIndex).not.toContain("'released'");
    expect(uniqueIndex).not.toContain("'reversed'");
  });

  it("backfills only explicit historical identities and marks ambiguity", () => {
    expect(migration).toContain("WHERE il.source_id IS NOT NULL");
    expect(migration).toContain("WHEN live_uses > 1 THEN 'released'");
    expect(migration).toContain("legacy_incomplete");
    expect(migration).toContain(
      "Work-session links carry a reliable 1:1 raw identity",
    );
  });

  it("ships a fail-closed rollback instead of silently deleting new accounting data", () => {
    expect(rollback).toContain("Rollback 0108 blocked");
    expect(rollback).toContain("verified invoice source allocations exist");
    expect(rollback).toContain("invoice data uses the new document fields");
    expect(rollback).toContain("invoice section rows exist");
  });
});

describe("invoice operational boundary contract", () => {
  it("does not create or reverse warehouse movements from invoice finalisation", () => {
    expect(invoiceService).not.toContain("warehouseMovementsTable");
    expect(invoiceService).not.toContain("warehouseMovementService");
    expect(invoiceService).toContain("stock consumption has");
    expect(invoiceService).toContain(
      "already happened on the work/material event",
    );
  });

  it("exposes jobless invoices, advances and explicit customer override in the API", () => {
    expect(openApi).toMatch(/documentType:[\s\S]*enum: \[standard, advance\]/);
    expect(openApi).toContain("allowCustomerMismatch:");
    expect(openApi).toContain("sourceAllocations:");
    expect(openApi).toMatch(/rowType:[\s\S]*enum: \[item, section\]/);
  });
});
