import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import {
  db,
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
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
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

    const second = await admin.post(`/api/jobs/${job.id}/signature-token`).send({});
    expect(second.status).toBe(200);
    const secondToken = tokenFromSignUrl(second.body.signUrl);
    expect(secondToken).not.toBe(firstToken);
    expect((await request(app).get(`/api/sign/${firstToken}`)).status).toBe(410);
    expect((await request(app).get(`/api/sign/${secondToken}`)).status).toBe(200);
  });

  it("accepts exactly one concurrent signature and rejects replay", async () => {
    const job = await createJob();
    const issued = await admin.post(`/api/jobs/${job.id}/signature-token`).send({});
    const token = tokenFromSignUrl(issued.body.signUrl);

    const results = await Promise.all([
      request(app).post(`/api/sign/${token}`).send({ signatureDataUrl: PNG }),
      request(app).post(`/api/sign/${token}`).send({ signatureDataUrl: PNG }),
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
    const replay = await request(app)
      .post(`/api/sign/${token}`)
      .send({ signatureDataUrl: PNG });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("public_token_consumed");

    const reissue = await admin.post(`/api/jobs/${job.id}/signature-token`).send({});
    expect(reissue.status).toBe(409);
  });
});
