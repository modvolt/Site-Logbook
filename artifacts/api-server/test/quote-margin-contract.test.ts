import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CreateQuoteBody } from "@workspace/api-zod";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("quote margin and structural-row contract", () => {
  it("keeps migration 0096 additive and defaults legacy rows to financial items", () => {
    const migration = read("lib/db/migrations/0096_far_smiling_tiger.sql");

    expect(migration).toContain(
      "ADD COLUMN \"row_type\" text DEFAULT 'item' NOT NULL",
    );
    expect(migration).toContain(
      'ADD COLUMN "purchase_unit_price" numeric(12, 2)',
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("blocks destructive rollback after a margin or structural row is used", () => {
    const rollback = read("lib/db/rollbacks/0096_far_smiling_tiger.down.sql");

    expect(rollback).toContain("row_type <> 'item'");
    expect(rollback).toContain("purchase_unit_price IS NOT NULL");
    expect(rollback).toContain("Rollback 0096 blocked");
    expect(rollback).toContain("created_at = 1786383352759");
  });

  it("accepts price rows, section headings and blank spacers through the API", () => {
    const parsed = CreateQuoteBody.safeParse({
      title: "Dvě nabízené varianty",
      items: [
        { rowType: "section", description: "Systém A" },
        {
          rowType: "item",
          description: "Střídač",
          quantity: 1,
          unit: "ks",
          purchaseUnitPrice: 10000,
          unitPrice: 12500,
          vatRate: 21,
        },
        { rowType: "spacer", description: "" },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("never exposes internal purchase prices in public JSON or customer PDF", () => {
    const service = read("artifacts/api-server/src/lib/quote-service.ts");
    const versionService = read(
      "artifacts/api-server/src/lib/quote-version-service.ts",
    );
    const versionSchema = read("lib/db/src/schema/document-versions.ts");
    const publicStart = service.indexOf(
      "export async function getQuoteByShareToken",
    );
    const publicEnd = service.indexOf(
      "export async function acceptQuoteByToken",
    );
    const publicBlock = service.slice(publicStart, publicEnd);
    const pdf = read("artifacts/api-server/src/lib/quote-pdf.ts");
    const spec = read("lib/api-spec/openapi.yaml");
    const publicSchemaStart = spec.indexOf("    PublicQuoteItem:");
    const publicSchemaEnd = spec.indexOf("    QuotePublicActionResult:");
    const publicSchema = spec.slice(publicSchemaStart, publicSchemaEnd);

    expect(publicBlock).toContain("snapshot.items.map");
    expect(versionService).toContain("const rowType = normalizeQuoteRowType");
    expect(versionService).toContain("rowType: item.rowType");
    expect(versionSchema).toContain('rowType: "item" | "section" | "spacer"');
    expect(versionSchema).toContain("schemaVersion: 2");
    expect(publicBlock).not.toContain("purchaseUnitPrice:");
    expect(versionService).not.toContain("purchaseUnitPrice:");
    expect(
      pdf.slice(
        pdf.indexOf("export interface QuotePdfItem"),
        pdf.indexOf("export interface QuotePdfData"),
      ),
    ).not.toContain("purchaseUnitPrice");
    expect(publicSchema).not.toContain("purchaseUnitPrice");
  });
});
