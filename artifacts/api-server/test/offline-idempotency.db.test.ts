import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import express from "express";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { and, count, eq } from "drizzle-orm";
import {
  ROLE_PERMISSIONS,
  apiIdempotencyRecordsTable,
  auditLogTable,
  db,
  jobsTable,
  materialsTable,
  pool,
  userSessionsTable,
  usersTable,
} from "@workspace/db";
import app from "../src/app";
import {
  enforceOfflineIdempotency,
  fingerprintOfflineReplayRequest,
} from "../src/middlewares/offline-idempotency";

if (process.env.AUTHORIZATION_DB_TEST_ENABLED !== "true") {
  throw new Error(
    "Refusing to run offline idempotency DB tests without AUTHORIZATION_DB_TEST_ENABLED=true.",
  );
}

const TAG = `offline-idempotency-${Date.now()}`;
const PASSWORD = "Offline-Idempotency-Test-42";
let userId: number;
let jobId: number;
let offlineScope: string;
let agent: Agent;

function offlineHeaders(key: string): Record<string, string> {
  return {
    "Idempotency-Key": key,
    "X-Stavba-Offline-Scope": offlineScope,
  };
}

beforeAll(async () => {
  const [user] = await db.insert(usersTable).values({
    username: TAG,
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    name: "Offline idempotency test",
    role: "admin",
    isActive: true,
  }).returning();
  userId = user.id;
  const [job] = await db.insert(jobsTable).values({
    title: TAG,
    date: "2042-08-01",
  }).returning();
  jobId = job.id;
  agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ username: TAG, password: PASSWORD })).status).toBe(200);
  const me = await agent.get("/api/auth/me");
  expect(me.status).toBe(200);
  offlineScope = me.body.offlineScope as string;
});

afterAll(async () => {
  await db.delete(auditLogTable);
  await db.delete(userSessionsTable);
  await db.delete(jobsTable).where(eq(jobsTable.id, jobId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await pool.end();
});

describe("durable offline idempotency ledger", () => {
  it("replays a completed material creation without a second side effect", async () => {
    const key = "offline-material-create-0001";
    const body = { name: "Kabel CYKY", quantity: 12, unit: "m", done: false };
    const first = await agent
      .post(`/api/jobs/${jobId}/materials`)
      .set(offlineHeaders(key))
      .send(body);
    let replay = await agent
      .post(`/api/jobs/${jobId}/materials`)
      .set(offlineHeaders(key))
      .send(body);
    for (let attempt = 0; replay.body.code === "idempotency_in_progress" && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      replay = await agent
        .post(`/api/jobs/${jobId}/materials`)
        .set(offlineHeaders(key))
        .send(body);
    }

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.body.id).toBe(first.body.id);
    const [materialCount] = await db
      .select({ value: count() })
      .from(materialsTable)
      .where(and(eq(materialsTable.jobId, jobId), eq(materialsTable.name, body.name)));
    expect(materialCount.value).toBe(1);
  });

  it("rejects reuse of one key for a different request body", async () => {
    const key = "offline-material-create-0002";
    const first = await agent
      .post(`/api/jobs/${jobId}/materials`)
      .set(offlineHeaders(key))
      .send({ name: "První materiál", quantity: 1, unit: "ks" });
    const changed = await agent
      .post(`/api/jobs/${jobId}/materials`)
      .set(offlineHeaders(key))
      .send({ name: "Jiný materiál", quantity: 2, unit: "ks" });

    expect(first.status).toBe(201);
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("idempotency_key_reused");
  });

  it("fails closed when a scoped offline mutation omits its key", async () => {
    const response = await agent
      .post(`/api/jobs/${jobId}/materials`)
      .set({ "X-Stavba-Offline-Scope": offlineScope })
      .send({ name: "Bez klíče", quantity: 1, unit: "ks" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("idempotency_key_required");
    const [materialCount] = await db
      .select({ value: count() })
      .from(materialsTable)
      .where(and(eq(materialsTable.jobId, jobId), eq(materialsTable.name, "Bez klíče")));
    expect(materialCount.value).toBe(0);
  });

  it("fails closed before a scoped raw upload without a content digest", async () => {
    let sideEffects = 0;
    const probe = express();
    probe.use((req, _res, next) => {
      req.auth = {
        userId,
        username: TAG,
        role: "admin",
        name: "Offline idempotency test",
        personId: null,
        permissions: [...ROLE_PERMISSIONS.admin],
      };
      next();
    });
    probe.use(enforceOfflineIdempotency);
    probe.post("/raw-probe", express.raw({ type: "image/jpeg" }), (_req, res) => {
      sideEffects += 1;
      res.status(201).json({ sideEffects });
    });

    const body = Buffer.from("raw upload");
    const missing = await request(probe)
      .post("/raw-probe")
      .set(offlineHeaders("offline-raw-upload-0001"))
      .set("Content-Type", "image/jpeg")
      .send(body);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("offline_content_digest_required");
    expect(sideEffects).toBe(0);

    const digest = createHash("sha256").update(body).digest("hex");
    const accepted = await request(probe)
      .post("/raw-probe")
      .set(offlineHeaders("offline-raw-upload-0002"))
      .set("X-Stavba-Content-SHA256", digest)
      .set("Content-Type", "image/jpeg")
      .send(body);
    expect(accepted.status).toBe(201);
    expect(sideEffects).toBe(1);
  });

  it("serializes concurrent tabs and replays the winner", async () => {
    let sideEffects = 0;
    const probe = express();
    probe.use(express.json());
    probe.use((req, _res, next) => {
      req.auth = {
        userId,
        username: TAG,
        role: "admin",
        name: "Offline idempotency test",
        personId: null,
        permissions: [...ROLE_PERMISSIONS.admin],
      };
      next();
    });
    probe.use(enforceOfflineIdempotency);
    probe.post("/probe", async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      sideEffects += 1;
      res.status(201).json({ sideEffects });
    });

    const headers = offlineHeaders("offline-concurrent-tabs-0001");
    const [left, right] = await Promise.all([
      request(probe).post("/probe").set(headers).send({ value: 1 }),
      request(probe).post("/probe").set(headers).send({ value: 1 }),
    ]);
    expect([left.status, right.status].sort()).toEqual([201, 409]);
    expect([left.body.code, right.body.code]).toContain("idempotency_in_progress");
    expect(sideEffects).toBe(1);

    let replay = await request(probe).post("/probe").set(headers).send({ value: 1 });
    for (let attempt = 0; replay.body.code === "idempotency_in_progress" && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      replay = await request(probe).post("/probe").set(headers).send({ value: 1 });
    }
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.body).toEqual({ sideEffects: 1 });
    expect(sideEffects).toBe(1);
  });

  it("does not reserve the shared DB pool while distinct operations execute", async () => {
    let sideEffects = 0;
    const probe = express();
    probe.use(express.json());
    probe.use((req, _res, next) => {
      req.auth = {
        userId,
        username: TAG,
        role: "admin",
        name: "Offline idempotency test",
        personId: null,
        permissions: [...ROLE_PERMISSIONS.admin],
      };
      next();
    });
    probe.use(enforceOfflineIdempotency);
    probe.post("/pool-probe", async (_req, res) => {
      await pool.query("select pg_sleep(0.01)");
      sideEffects += 1;
      res.status(201).json({ sideEffects });
    });

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) => request(probe)
        .post("/pool-probe")
        .set(offlineHeaders(`offline-pool-probe-${String(index).padStart(4, "0")}`))
        .send({ index })),
    );

    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(201));
    expect(sideEffects).toBe(12);
  });

  it("keeps an interrupted pending record ambiguous instead of executing it again", async () => {
    const key = "offline-ambiguous-result-0001";
    const path = "/ambiguous-probe";
    const body = { value: 7 };
    const requestHash = fingerprintOfflineReplayRequest({
      method: "POST",
      originalUrl: path,
      body,
      headers: { "content-type": "application/json" },
    } as never);
    await db.insert(apiIdempotencyRecordsTable).values({
      userId,
      offlineScope,
      idempotencyKey: key,
      method: "POST",
      path,
      requestHash,
      state: "pending",
      lastSeenAt: new Date(Date.now() - 120_000),
    });

    let sideEffects = 0;
    const probe = express();
    probe.use(express.json());
    probe.use((req, _res, next) => {
      req.auth = {
        userId,
        username: TAG,
        role: "admin",
        name: "Offline idempotency test",
        personId: null,
        permissions: [...ROLE_PERMISSIONS.admin],
      };
      next();
    });
    probe.use(enforceOfflineIdempotency);
    probe.post(path, (_req, res) => {
      sideEffects += 1;
      res.status(201).json({ sideEffects });
    });

    const response = await request(probe).post(path).set(offlineHeaders(key)).send(body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("idempotency_ambiguous");
    expect(sideEffects).toBe(0);
  });
});
