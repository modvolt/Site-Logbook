import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const jobsRoute = source("src/routes/jobs.ts");
const statusService = source("src/lib/job-status-service.ts");
const jobDetail = source("../stavba/src/pages/job-detail.tsx");
const jobsPage = source("../stavba/src/pages/jobs.tsx");
const adminPage = source("../stavba/src/pages/admin.tsx");
const openApi = source("../../lib/api-spec/openapi.yaml");

describe("safe job-status contract", () => {
  it("funnels single and bulk status writes through one transactional service", () => {
    expect(jobsRoute).toContain("transitionJobStatuses(");
    expect(jobsRoute).toContain("transitionJobStatus(");
    expect(statusService).toContain("return db.transaction(async (tx)");
    expect(statusService).toContain('.for("update")');
    expect(statusService).toContain("jobs.push(await transitionOne(tx");
  });

  it("rejects status bypasses through generic edits and finished-job timer starts", () => {
    expect(jobsRoute).toContain('code: "use_status_endpoint"');
    expect(jobsRoute).toContain('code: "finished_job_timer_locked"');
    expect(jobsRoute).toContain('["done", "cancelled", "vyfakturovano"].includes(existingJob.status)');
    expect(adminPage).toContain("updateStatus.mutate(");
    expect(adminPage).toContain("{ id: editingId, data: { status: draft.status as JobStatusUpdateStatus } }");
    expect(adminPage).not.toContain("status: editStatus as UpdateJobBodyStatus");
  });

  it("keeps completion, recurrence creation and audit in the same transaction", () => {
    expect(statusService).toContain("await tx.insert(auditLogTable)");
    expect(statusService).toContain("if (status === \"done\") await createNextRecurringJob(tx, updated)");
    expect(statusService).toContain("pg_advisory_xact_lock");
    expect(statusService).toContain('"job_completed"');
    expect(statusService).toContain('"job_reopened"');
  });

  it("requires explicit warning acknowledgement in the API contract", () => {
    expect(openApi).toContain("/jobs/{id}/completion-readiness:");
    expect(openApi.match(/acknowledgeWarnings:/g)).toHaveLength(2);
    expect(openApi).toContain("JobStatusTransitionError:");
    expect(jobsPage).toContain('error?.data?.code === "completion_warnings"');
    expect(jobsPage).toContain("runBulkStatusUpdate(true)");
  });

  it("shows readiness before completion and hides timer start on closed jobs", () => {
    expect(jobDetail).toContain("completionDialogOpen");
    expect(jobDetail).toContain("getGetJobCompletionReadinessQueryKey");
    expect(jobDetail).toContain("Dokončit i s upozorněními");
    expect(jobDetail).toContain('const canStartTimer = job?.status === "planned" || job?.status === "in_progress"');
    expect(jobDetail).toContain(": canStartTimer ? (");
  });
});
