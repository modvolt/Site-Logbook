import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { materialShouldIssueStock } from "../src/lib/material-consumption-policy";

const migrationSql = readFileSync(
  resolve(process.cwd(), "../../lib/db/migrations/0087_chief_marvel_apes.sql"),
  "utf8",
);
const rollbackSql = readFileSync(
  resolve(process.cwd(), "../../lib/db/rollbacks/0087_chief_marvel_apes.down.sql"),
  "utf8",
);
const invoiceService = readFileSync(
  resolve(process.cwd(), "src/lib/invoice-service.ts"),
  "utf8",
);
const materialsRoute = readFileSync(
  resolve(process.cwd(), "src/routes/materials.ts"),
  "utf8",
);
const statsRoute = readFileSync(resolve(process.cwd(), "src/routes/stats.ts"), "utf8");
const jobDetail = readFileSync(
  resolve(process.cwd(), "../stavba/src/pages/job-detail.tsx"),
  "utf8",
);
const offlineQueue = readFileSync(
  resolve(process.cwd(), "../stavba/src/hooks/use-offline-queue.tsx"),
  "utf8",
);

describe("job material planned/consumed policy", () => {
  it("issues job stock only after explicit consumption", () => {
    expect(materialShouldIssueStock("material", { done: false })).toBe(false);
    expect(materialShouldIssueStock("material", { done: true })).toBe(true);
    expect(materialShouldIssueStock("material", {})).toBe(false);
  });

  it("preserves the existing immediate issue behaviour for activity materials", () => {
    expect(materialShouldIssueStock("activity_material", { done: false })).toBe(true);
    expect(materialShouldIssueStock("activity_material", {})).toBe(true);
  });

  it("updates consumption metadata and reconciles stock in one transaction", () => {
    const patchStart = materialsRoute.indexOf('router.patch("/jobs/:jobId/materials/:materialId"');
    const patchEnd = materialsRoute.indexOf('router.delete("/jobs/:jobId/materials/:materialId"');
    const patchRoute = materialsRoute.slice(patchStart, patchEnd);

    expect(patchRoute).toContain("db.transaction");
    expect(patchRoute).toContain("updateData.consumedAt");
    expect(patchRoute).toContain("updateData.consumedByUserId");
    expect(patchRoute).toContain("reconcileMaterialStockMovement(tx, m, actor)");
    expect(patchRoute).toContain('action: done ? "material_consumed" : "material_returned_to_plan"');
    expect(patchRoute).toContain("Spotřebovaný materiál musí mít kladné množství.");
  });

  it("keeps planned materials out of both invoice material queries", () => {
    const consumedFilters = invoiceService.match(/eq\(materialsTable\.done, true\)/g) ?? [];
    expect(consumedFilters).toHaveLength(2);
    expect(statsRoute.match(/eq\(materialsTable\.done, true\)/g)).toHaveLength(3);
  });

  it("exposes a clear field action and queues it while offline", () => {
    expect(jobDetail).toContain('m.done ? "Spotřebováno" : "Plánováno"');
    expect(jobDetail).toContain('type: "set_material_consumed"');
    expect(offlineQueue).toContain('case "set_material_consumed"');
    expect(offlineQueue).toContain("JSON.stringify({ done })");
  });
});

describe("job material consumption migration safety", () => {
  it("backfills legacy rows as consumed without deleting data", () => {
    expect(migrationSql).toContain('UPDATE "materials"');
    expect(migrationSql).toContain('"done" = true');
    expect(migrationSql).toContain('"consumed_at" = COALESCE("consumed_at", "created_at")');
    expect(migrationSql).not.toMatch(/DELETE\s+FROM\s+"?materials"?/i);
  });

  it("blocks rollback while planned rows would change meaning", () => {
    expect(rollbackSql).toContain('WHERE "done" = false');
    expect(rollbackSql).toContain("Rollback 0087 blocked");
    expect(rollbackSql).toContain("created_at = 1783981467968");
    expect(rollbackSql).toContain("BEGIN;");
    expect(rollbackSql).toContain("COMMIT;");
  });
});
