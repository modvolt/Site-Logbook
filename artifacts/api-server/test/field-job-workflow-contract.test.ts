import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("field job workflow contract", () => {
  it("maps field mutations to jobs.work and leaves destructive actions managed", () => {
    const permissions = read("artifacts/api-server/src/middlewares/permissions.ts");

    expect(permissions).toContain('req.method === "POST") return "jobs.work"');
    expect(permissions).toContain('req.method === "PATCH") return "jobs.work"');
    expect(permissions).toContain('manage: "jobs.manage"');
    expect(permissions).not.toMatch(/req\.method === "DELETE"[^\n]+jobs\.work/);
  });

  it("requires assignment for field reads and writes", () => {
    const access = read("artifacts/api-server/src/middlewares/job-work-access.ts");
    const jobs = read("artifacts/api-server/src/routes/jobs.ts");

    expect(access).toContain("requireAssignedJobView");
    expect(access).toContain("requireAssignedJobWork");
    expect(access).toContain("job_not_assigned");
    expect(access).toContain("missing_person_link");
    expect(jobs).toContain("listAssignedJobIds(req.auth!.personId)");
    expect(jobs).toMatch(
      /router\.get\(\s*"\/jobs\/:id",\s*requireAssignedJobView/,
    );
  });

  it("allows a field worker to control only their own timer", () => {
    const access = read("artifacts/api-server/src/middlewares/job-work-access.ts");
    const time = read("artifacts/api-server/src/routes/time-entries.ts");

    expect(access).toContain("personId !== req.auth!.personId");
    expect(access).toContain("timer_person_mismatch");
    expect(time).toContain('router.post("/jobs/:jobId/time-entries/:personId/start", requireOwnJobTimer');
    expect(time).toContain('router.post("/jobs/:jobId/time-entries/:personId/stop", requireOwnJobTimer');
    expect(time).toContain("entries.filter((entry) => entry.personId === req.auth!.personId)");
    expect(time).toContain('getWorkSummary("job", parentId, personId)');
  });

  it("does not return document attachments in field mode", () => {
    const attachments = read("artifacts/api-server/src/routes/attachments.ts");

    expect(attachments).toContain("requireAssignedJobView");
    expect(attachments).toContain('attachment.type === "photo"');
  });

  it("keeps material prices and warehouse linking out of field mutations", () => {
    const materials = read("artifacts/api-server/src/routes/materials.ts");

    expect(materials).toContain("canViewSale && m.pricePerUnit");
    expect(materials).toContain("canViewCost && m.purchasePricePerUnit");
    expect(materials).toContain("field_material_price_restricted");
    expect(materials).toContain("field_material_warehouse_restricted");
    expect(materials).toContain('new Set(["quantity", "unit", "done"])');
  });

  it("renders the simplified field shell without management controls", () => {
    const app = read("artifacts/stavba/src/App.tsx");
    const layout = read("artifacts/stavba/src/components/layout.tsx");
    const detail = read("artifacts/stavba/src/pages/job-detail.tsx");

    expect(app).toContain('can("jobs.work") && !can("jobs.manage")');
    expect(app).toContain("<FieldHome />");
    expect(layout).toContain('new Set(["/", "/calendar", "/jobs", "/me"])');
    expect(detail).toContain("<FieldJobOverview");
    expect(detail).toContain('title={fieldMode ? "Můj čas" : "Čas zaměstnanců"}');
    expect(detail).toContain("{isChangeRequest && canManage && (");
  });
});
