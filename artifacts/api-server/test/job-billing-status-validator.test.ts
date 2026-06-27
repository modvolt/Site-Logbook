import { describe, it, expect } from "vitest";
import {
  UpdateJobBody,
  UpdateJobStatusBody,
  BulkUpdateJobStatusBody,
  CreateJobBody,
} from "@workspace/api-zod";

/**
 * Invariant: a job can never be marked invoiced ("vyfakturovano") by a client.
 *
 * A job's billed state is the "vyfakturovano" status, which is reachable only
 * through the invoice issue flow (done → vyfakturovano). invoice-service flips
 * it server-side with a direct DB write when an invoice is issued, and reverts
 * it to "done" on storno — it never travels through these client-facing PATCH
 * validators. The lifecycle status the client may set is limited to
 * `planned | in_progress | done | cancelled`.
 *
 * These tests pin the generated validators so another client or a future
 * refactor can't silently re-open a manual `status: "vyfakturovano"` write path
 * (which would create phantom-billed jobs). They run as a pure unit test against
 * the generated Zod schemas (no DB) — the legitimate issue/storno path that
 * flips and reverts the status is covered by job-invoice-lifecycle.test.ts.
 */

const CLIENT_STATUSES = ["planned", "in_progress", "done", "cancelled"] as const;

describe("job status validators reject a manual invoiced status", () => {
  it("UpdateJobBody rejects status: \"vyfakturovano\" (PATCH /jobs/:id returns 400)", () => {
    const result = UpdateJobBody.safeParse({ status: "vyfakturovano" });
    expect(result.success).toBe(false);
  });

  it("UpdateJobStatusBody rejects status: \"vyfakturovano\" (PATCH /jobs/:id/status returns 400)", () => {
    const result = UpdateJobStatusBody.safeParse({ status: "vyfakturovano" });
    expect(result.success).toBe(false);
  });

  it("BulkUpdateJobStatusBody rejects status: \"vyfakturovano\" (PATCH /jobs/status returns 400)", () => {
    const result = BulkUpdateJobStatusBody.safeParse({
      ids: [1],
      status: "vyfakturovano",
    });
    expect(result.success).toBe(false);
  });

  it("CreateJobBody rejects status: \"vyfakturovano\" (a new job can't start invoiced)", () => {
    const result = CreateJobBody.safeParse({
      title: "Zakázka",
      type: "other",
      date: "2026-06-27",
      status: "vyfakturovano",
    });
    expect(result.success).toBe(false);
  });
});

describe("job status validators accept every legitimate client status", () => {
  for (const status of CLIENT_STATUSES) {
    it(`UpdateJobStatusBody accepts status: "${status}"`, () => {
      const result = UpdateJobStatusBody.safeParse({ status });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.status).toBe(status);
    });

    it(`UpdateJobBody accepts status: "${status}"`, () => {
      const result = UpdateJobBody.safeParse({ status });
      expect(result.success).toBe(true);
    });
  }

  it("UpdateJobBody accepts an omitted status (other fields can be updated alone)", () => {
    const result = UpdateJobBody.safeParse({ notes: "Poznámka" });
    expect(result.success).toBe(true);
  });

  it("rejects an arbitrary unknown status value", () => {
    expect(UpdateJobStatusBody.safeParse({ status: "billed" }).success).toBe(false);
  });
});
