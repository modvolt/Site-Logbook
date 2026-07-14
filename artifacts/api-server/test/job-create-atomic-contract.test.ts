import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CreateJobBody } from "@workspace/api-zod";

const jobsRoute = readFileSync(resolve(process.cwd(), "src/routes/jobs.ts"), "utf8");
const jobForm = readFileSync(
  resolve(process.cwd(), "../stavba/src/pages/job-form.tsx"),
  "utf8",
);

const baseJob = {
  title: "Atomická zakázka",
  type: "planned_work",
  date: "2026-07-14",
  status: "planned",
};

describe("atomic job-create contract", () => {
  it("accepts initial assignees, tasks and materials in one request", () => {
    const parsed = CreateJobBody.safeParse({
      ...baseJob,
      assignedPersonId: 1,
      assigneeIds: [1, 2],
      tasks: [{ title: "Kontrola rozvaděče" }],
      materials: [{ name: "CYKY 3x2,5", quantity: 12, unit: "m", pricePerUnit: 25 }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.materials?.[0].done).toBe(false);
  });

  it("rejects malformed nested records and oversized collections", () => {
    expect(CreateJobBody.safeParse({ ...baseJob, tasks: [{ title: "" }] }).success).toBe(false);
    expect(CreateJobBody.safeParse({ ...baseJob, materials: [{ quantity: 1 }] }).success).toBe(false);
    expect(CreateJobBody.safeParse({
      ...baseJob,
      assigneeIds: Array.from({ length: 101 }, (_, index) => index + 1),
    }).success).toBe(false);
  });

  it("keeps all related inserts and stock reconciliation inside one transaction", () => {
    const createStart = jobsRoute.indexOf('router.post("/jobs"');
    const createEnd = jobsRoute.indexOf('router.patch("/jobs/status"');
    const createRoute = jobsRoute.slice(createStart, createEnd);
    const txMatch = /db\s*\.transaction/.exec(createRoute);
    const txStart = txMatch?.index ?? -1;
    const txBlock = createRoute.slice(txStart);

    expect(txStart).toBeGreaterThan(0);
    expect(txBlock).toMatch(/tx\s*\.insert\(jobsTable\)/);
    expect(txBlock).toMatch(/tx\s*\.insert\(jobAssigneesTable\)/);
    expect(txBlock).toMatch(/tx\s*\.insert\(tasksTable\)/);
    expect(txBlock).toMatch(/\.insert\(materialsTable\)/);
    expect(txBlock).toContain("reconcileMaterialStockMovement(tx");
    expect(createRoute).toContain("pg_advisory_xact_lock");
  });

  it("submits the form once and no longer swallows follow-up write failures", () => {
    expect(jobForm).toContain("assigneeIds,");
    expect(jobForm).toContain("tasks: tasks.map");
    expect(jobForm).toContain("materials: materials.map");
    expect(jobForm).toContain("done: false");
    expect(jobForm).not.toContain("useUpdateJobAssignees");
    expect(jobForm).not.toContain("useCreateTask");
    expect(jobForm).not.toContain("useCreateMaterial");
    expect(jobForm).not.toContain(".catch(() => {})");
  });
});
