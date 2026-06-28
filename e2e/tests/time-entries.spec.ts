import { test, expect } from "@playwright/test";
import { cleanupJob, cleanupPerson } from "./helpers";

test.describe("Job time-entry mutations", () => {
  let jobId: number;
  let personId: number;

  test.beforeAll(async ({ request }) => {
    const personRes = await request.post("/api/people", {
      data: { name: `E2E_TE_Person_${Date.now()}` },
    });
    expect(personRes.status()).toBe(201);
    const person = (await personRes.json()) as { id: number };
    personId = person.id;

    const jobRes = await request.post("/api/jobs", {
      data: {
        title: `E2E_TE_Job_${Date.now()}`,
        date: "2026-01-15",
        type: "other",
        status: "planned",
      },
    });
    expect(jobRes.status()).toBe(201);
    const job = (await jobRes.json()) as { id: number };
    jobId = job.id;
  });

  test.afterAll(async ({ request }) => {
    await request
      .delete(`/api/jobs/${jobId}/time-entries/${personId}`)
      .catch(() => {});
    if (jobId) await cleanupJob(request, jobId);
    if (personId) await cleanupPerson(request, personId);
  });

  test("create time entry returns hours=0 and no running timer", async ({
    request,
  }) => {
    const res = await request.post(`/api/jobs/${jobId}/time-entries`, {
      data: { personId, hours: 0 },
    });
    expect(res.status()).toBe(201);
    const entry = (await res.json()) as {
      hours: number;
      timerStartedAt: string | null;
    };
    expect(entry.hours).toBe(0);
    expect(entry.timerStartedAt).toBeNull();
  });

  test("start sets timerStartedAt", async ({ request }) => {
    const res = await request.post(
      `/api/jobs/${jobId}/time-entries/${personId}/start`,
    );
    expect(res.status()).toBe(200);
    const entry = (await res.json()) as { timerStartedAt: string | null };
    expect(entry.timerStartedAt).not.toBeNull();
  });

  test("edit hours while timer running rebases timerStartedAt (prevents double-count)", async ({
    request,
  }) => {
    const res = await request.patch(
      `/api/jobs/${jobId}/time-entries/${personId}`,
      { data: { hours: 2 } },
    );
    expect(res.status()).toBe(200);
    const entry = (await res.json()) as {
      hours: number;
      timerStartedAt: string | null;
    };
    expect(entry.hours).toBe(2);
    expect(entry.timerStartedAt).not.toBeNull();

    const rebasedAt = new Date(entry.timerStartedAt!).getTime();
    const now = Date.now();
    expect(rebasedAt).toBeGreaterThan(now - 10_000);
  });

  test("stop accumulates only elapsed-since-rebase, not full duration", async ({
    request,
  }) => {
    const res = await request.post(
      `/api/jobs/${jobId}/time-entries/${personId}/stop`,
    );
    expect(res.status()).toBe(200);
    const entry = (await res.json()) as {
      hours: number;
      timerStartedAt: string | null;
    };
    expect(entry.timerStartedAt).toBeNull();
    expect(entry.hours).toBeGreaterThanOrEqual(2);
    expect(entry.hours).toBeLessThan(2.1);
  });

  test("delete removes the entry", async ({ request }) => {
    const res = await request.delete(
      `/api/jobs/${jobId}/time-entries/${personId}`,
    );
    expect(res.status()).toBe(204);

    const listRes = await request.get(`/api/jobs/${jobId}/time-entries`);
    expect(listRes.status()).toBe(200);
    const entries = (await listRes.json()) as Array<{ personId: number }>;
    const gone = entries.every((e) => e.personId !== personId);
    expect(gone).toBe(true);
  });
});
