import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import {
  db,
  jobDocumentVersionsTable,
  jobSignatureEventsTable,
  jobsTable,
  publicAccessTokensTable,
  usersTable,
} from "@workspace/db";
import app from "../src/app";
import { hashPublicAccessToken } from "../src/lib/public-access-token";
import { ObjectStorageService } from "../src/lib/objectStorage";

const TAG = `job-public-sign-${Date.now()}`;
const PASSWORD = "job-public-sign-test-password";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const jobIds: number[] = [];
let userId = 0;
let admin: Agent;
let originalPublicUrl: string | undefined;

function tokenFromSignUrl(value: unknown): string {
  expect(typeof value).toBe("string");
  return new URL(value as string).pathname.split("/").at(-1) ?? "";
}

beforeAll(async () => {
  originalPublicUrl = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = "https://job-sign.test";
  vi.spyOn(ObjectStorageService.prototype, "putPrivateObject").mockResolvedValue(undefined);
  vi.spyOn(ObjectStorageService.prototype, "deletePrivateObject").mockResolvedValue(undefined);

  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-admin`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: `Admin ${TAG}`,
      role: "admin",
      isActive: true,
    })
    .returning();
  userId = user.id;
  admin = request.agent(app);
  const login = await admin
    .post("/api/auth/login")
    .send({ username: `${TAG}-admin`, password: PASSWORD });
  expect(login.status).toBe(200);
});

afterAll(async () => {
  if (jobIds.length > 0) {
    await db
      .delete(publicAccessTokensTable)
      .where(and(
        eq(publicAccessTokensTable.purpose, "job_signature"),
        inArray(publicAccessTokensTable.resourceId, jobIds),
      ));
  }
  if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
  if (originalPublicUrl == null) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = originalPublicUrl;
  vi.restoreAllMocks();
});

async function createJob() {
  const [job] = await db
    .insert(jobsTable)
    .values({
      title: `Public signature ${TAG}`,
      type: "planned_work",
      date: "2026-08-15",
      status: "done",
    })
    .returning();
  jobIds.push(job.id);
  return job;
}

describe("job public signature token lifecycle", () => {
  it("stores only a hash, omits the raw token field, and rotates the link", async () => {
    const job = await createJob();
    const first = await admin.post(`/api/jobs/${job.id}/signature-token`).send({});
    expect(first.status).toBe(200);
    expect(first.body.token).toBeUndefined();
    expect(first.body.documentVersion).toBe(1);
    expect(first.body.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    const firstToken = tokenFromSignUrl(first.body.signUrl);
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [storedJob] = await db
      .select({ signatureToken: jobsTable.signatureToken })
      .from(jobsTable)
      .where(eq(jobsTable.id, job.id));
    expect(storedJob?.signatureToken).toBeNull();
    const [firstRow] = await db
      .select()
      .from(publicAccessTokensTable)
      .where(and(
        eq(publicAccessTokensTable.purpose, "job_signature"),
        eq(publicAccessTokensTable.resourceId, job.id),
      ));
    expect(firstRow?.tokenHash).toBe(hashPublicAccessToken(firstToken));
    expect(JSON.stringify(firstRow)).not.toContain(firstToken);
    expect(firstRow?.artifactBindingStatus).toBe("bound");
    expect(firstRow?.jobDocumentVersionId).toEqual(expect.any(Number));

    const beforeMutation = await request(app).get(`/api/sign/${firstToken}`);
    expect(beforeMutation.status).toBe(200);
    const signedTitle = beforeMutation.body.title;
    await db.update(jobsTable).set({ title: `${TAG}-changed-live-parent` }).where(eq(jobsTable.id, job.id));
    const afterMutation = await request(app).get(`/api/sign/${firstToken}`);
    expect(afterMutation.status).toBe(200);
    expect(afterMutation.body.title).toBe(signedTitle);
    expect(afterMutation.body.snapshotSha256).toBe(beforeMutation.body.snapshotSha256);

    const second = await admin.post(`/api/jobs/${job.id}/signature-token`).send({});
    expect(second.status).toBe(200);
    const secondToken = tokenFromSignUrl(second.body.signUrl);
    expect(secondToken).not.toBe(firstToken);
    expect((await request(app).get(`/api/sign/${firstToken}`)).status).toBe(410);
    expect((await request(app).get(`/api/sign/${secondToken}`)).status).toBe(200);
    const replacementEvents = await db
      .select()
      .from(jobSignatureEventsTable)
      .where(eq(jobSignatureEventsTable.jobId, job.id));
    expect(replacementEvents).toEqual([
      expect.objectContaining({
        documentVersionId: firstRow?.jobDocumentVersionId,
        eventType: "cancelled",
        actorType: "system",
        reason: "signature_link_replaced",
      }),
    ]);
  });

  it("accepts exactly one concurrent signature and rejects replay", async () => {
    const job = await createJob();
    const issued = await admin.post(`/api/jobs/${job.id}/signature-token`).send({});
    const token = tokenFromSignUrl(issued.body.signUrl);

    const results = await Promise.all([
      request(app).post(`/api/sign/${token}`).send({ signatoryName: "Jan Testovací", signatureDataUrl: PNG }),
      request(app).post(`/api/sign/${token}`).send({ signatoryName: "Jan Testovací", signatureDataUrl: PNG }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);

    const [stored] = await db
      .select({
        signedAt: jobsTable.signedAt,
        signatureObjectPath: jobsTable.signatureObjectPath,
      })
      .from(jobsTable)
      .where(eq(jobsTable.id, job.id));
    expect(stored?.signedAt).toBeInstanceOf(Date);
    expect(stored?.signatureObjectPath).toMatch(
      new RegExp(`/objects/job-signatures/${job.id}-[0-9a-f-]{36}\\.png`),
    );
    expect(stored?.signatureObjectPath).not.toContain(token);

    const [tokenRow] = await db
      .select({ consumeAction: publicAccessTokensTable.consumeAction })
      .from(publicAccessTokensTable)
      .where(and(
        eq(publicAccessTokensTable.purpose, "job_signature"),
        eq(publicAccessTokensTable.resourceId, job.id),
      ));
    expect(tokenRow?.consumeAction).toBe("signed");
    const [version] = await db
      .select()
      .from(jobDocumentVersionsTable)
      .where(eq(jobDocumentVersionsTable.jobId, job.id));
    expect(version).toMatchObject({
      status: "signed",
      signatoryName: "Jan Testovací",
      identityAssurance: "self_declared_name",
    });
    expect(version?.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(version?.signatureSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(version?.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    const events = await db
      .select()
      .from(jobSignatureEventsTable)
      .where(eq(jobSignatureEventsTable.jobId, job.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      documentVersionId: version?.id,
      eventType: "signed",
      actorName: "Jan Testovací",
    });
    const replay = await request(app)
      .post(`/api/sign/${token}`)
      .send({ signatoryName: "Jan Testovací", signatureDataUrl: PNG });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("public_token_consumed");

    const reissue = await admin.post(`/api/jobs/${job.id}/signature-token`).send({});
    expect(reissue.status).toBe(409);
  });
});
