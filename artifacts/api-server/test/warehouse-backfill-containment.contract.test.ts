import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(
    /\r\n?/g,
    "\n",
  );
const routes = source("../src/routes/warehouse-items.ts");
const service = source("../src/lib/warehouse-service.ts");
const app = source("../src/app.ts");
const openapi = source("../../../lib/api-spec/openapi.yaml");
const adminBackfillPage = source(
  "../../stavba/src/pages/admin-warehouse-backfill.tsx",
);

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("legacy warehouse backfill containment", () => {
  it("maps branded warehouse conflicts to bounded client responses", () => {
    expect(service).toContain("export class WarehouseAppError extends Error");
    expect(service).toContain(
      "return new WarehouseAppError(statusCode, message)",
    );
    expect(app).toContain("err instanceof WarehouseAppError");
    expect(app).toContain("[400, 404, 409].includes(err.statusCode)");
    expect(app).toContain('code: "warehouse_operation_rejected"');
  });

  it("keeps both legacy bulk mutation endpoints fail-closed", () => {
    const assign = section(
      routes,
      'router.post(\n  "/warehouse-material-backfill/assign"',
      'router.post(\n  "/warehouse-material-backfill/run"',
    );
    const run = section(
      routes,
      'router.post(\n  "/warehouse-material-backfill/run"',
      "export default router",
    );

    for (const block of [assign, run]) {
      expect(block).toContain(
        "warehouse_material_backfill_maintenance_required",
      );
      expect(block).toContain("res.status(409)");
      expect(block).not.toMatch(
        /db\.transaction|\.update\(|\.insert\(|reconcileSource/,
      );
    }
  });

  it("keeps the exported legacy service helper non-mutating", () => {
    const block = section(
      service,
      "export async function runUnambiguousWarehouseMaterialBackfill(",
      "// ---------------------------------------------------------------------------\n// Backfill cost prices",
    );
    expect(block).toContain("throw appError(");
    expect(block).toContain("maintenance plán");
    expect(block).not.toMatch(
      /\.transaction\(|lower\(|\.update\(|reconcileSource/,
    );
  });

  it("documents both endpoints as deprecated 409-only operations", () => {
    const run = section(
      openapi,
      "  /warehouse-material-backfill/run:",
      "  /warehouse-material-backfill/assign:",
    );
    const assign = section(
      openapi,
      "  /warehouse-material-backfill/assign:",
      "  /warehouse-movements:",
    );
    for (const block of [run, assign]) {
      expect(block).toContain("deprecated: true");
      expect(block).toContain('"409":');
      expect(block).not.toContain('"200":');
      expect(block).toContain(
        "warehouse_material_backfill_maintenance_required",
      );
    }
  });

  it("keeps the admin report read-only and honest about the maintenance gate", () => {
    expect(adminBackfillPage).toContain("Zápisové akce jsou dočasně vypnuté");
    expect(adminBackfillPage).toContain("pouze diagnostický report");
    expect(adminBackfillPage).not.toMatch(
      /useRunWarehouseMaterialBackfill|useAssignWarehouseMaterialGroup/,
    );
    expect(adminBackfillPage).not.toMatch(/handleRun|handleAssign|onAssigned/);
  });
});
