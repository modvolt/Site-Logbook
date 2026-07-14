import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("job read-only, field-work and management boundaries", () => {
  it("keeps the guest role read-only unless jobs.work is explicitly granted", () => {
    const permissions = read("lib/db/src/permissions.ts");
    const guestStart = permissions.indexOf("guest: [");
    const guestEnd = permissions.indexOf("],", guestStart);
    const guestBlock = permissions.slice(guestStart, guestEnd);

    expect(guestBlock).toContain('"jobs.view"');
    expect(guestBlock).not.toContain('"jobs.work"');
    expect(guestBlock).not.toContain('"jobs.manage"');
  });

  it("protects completion diagnostics as a management-only API", () => {
    const jobs = read("artifacts/api-server/src/routes/jobs.ts");
    const start = jobs.indexOf('"/jobs/:id/completion-readiness"');
    const block = jobs.slice(start, start + 500);

    expect(block).toContain('requirePermission("jobs.manage")');
    expect(block).toContain("requireAssignedJobView");
    expect(block.indexOf('requirePermission("jobs.manage")')).toBeLessThan(
      block.indexOf("getJobCompletionReadiness"),
    );
  });

  it("renders top-level job mutations only for jobs.manage", () => {
    const detail = read("artifacts/stavba/src/pages/job-detail.tsx");
    const jobsPage = read("artifacts/stavba/src/pages/jobs.tsx");
    const layout = read("artifacts/stavba/src/components/layout.tsx");

    expect(detail).toContain('const canManage = can("jobs.manage")');
    expect(detail).toContain(
      "{canManage ? <StatusDropdown currentStatus={job.status}",
    );
    expect(detail).toContain("{canManage && isTimerRunning && (");
    expect(detail).toContain(
      "{canManage && <Dialog open={completionDialogOpen}",
    );
    expect(detail).toContain(
      "enabled: canManage && completionDialogOpen && id > 0",
    );
    expect(detail).toContain("{canManage && <JobReadinessPanel");
    expect(jobsPage).toContain('const canWrite = can("jobs.manage")');
    expect(layout).toContain(
      'can("jobs.view") && can("jobs.manage") && ["/", "/calendar", "/jobs"]',
    );
  });

  it("guards direct frontend URLs with the matching module permission", () => {
    const app = read("artifacts/stavba/src/App.tsx");

    expect(app).toContain(
      '<PermissionOnly component={JobForm} permission={["jobs.view", "jobs.manage"]} />',
    );
    expect(app).toContain(
      '<PermissionOnly component={JobDetail} permission="jobs.view" />',
    );
    expect(app).toContain(
      '<PermissionOnly component={JobExport} permission={["jobs.view", "jobs.manage"]} />',
    );
    expect(app).toContain(
      '<PermissionOnly component={Admin} permission={["jobs.view", "jobs.manage"]} />',
    );
    expect(app).toContain('if (!can("jobs.view"))');
  });

  it("does not mount edit-only lookup queries for a read-only viewer", () => {
    const detail = read("artifacts/stavba/src/pages/job-detail.tsx");
    const infoStart = detail.indexOf("function InfoSection");
    const infoEnd = detail.indexOf("function VisitStatusBadge", infoStart);
    const info = detail.slice(infoStart, infoEnd);

    expect(info).toContain('const canManage = can("jobs.manage")');
    expect(info).toContain('enabled: canManage && can("people.view")');
    expect(info).toContain('enabled: canManage && can("customers.view")');
    expect(info).toContain("{canManage && (!editingShortName ? (");
    expect(info).toContain("{canManage && (!editingDate ? (");
    expect(info).toContain("{canManage && (!editingCustomer ? (");
    expect(info).toContain("{canManage && (!editingNotes ? (");
  });

  it("keeps field mutations available only with jobs.work", () => {
    const detail = read("artifacts/stavba/src/pages/job-detail.tsx");

    expect(detail).toContain("disabled={!canWork}");
    expect(detail).toContain("{canWork && <input");
    expect(detail).toContain(
      "{canWork && !isManagedMaterial(m) && (!fieldMode || !m.done) && (",
    );
    expect(detail).toContain(
      'enabled: can("time.manage") && can("people.view")',
    );
  });
});
