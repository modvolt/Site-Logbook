import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request, { type SuperAgentTest } from "supertest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  customersTable,
  db,
  deviceCredentialsTable,
  pool,
  userPermissionOverridesTable,
  usersTable,
  userSessionsTable,
} from "@workspace/db";
import app from "../src/app";

if (process.env.AUTHORIZATION_DB_TEST_ENABLED !== "true") {
  throw new Error(
    "Refusing to run authorization DB tests without AUTHORIZATION_DB_TEST_ENABLED=true.",
  );
}

const PASSWORD = "Vault-Authorization-Test-42";

type TestActor = {
  agent: SuperAgentTest;
  userId: number;
  username: string;
};

let customerId: number;
let credentialId: number;
let cannotView: TestActor;
let cannotManage: TestActor;
let cannotAccessCustomer: TestActor;
let fullAccess: TestActor;

async function createActor(
  username: string,
  deniedPermissions: string[],
): Promise<TestActor> {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const [user] = await db
    .insert(usersTable)
    .values({ username, passwordHash, name: username, role: "master", isActive: true })
    .returning();
  if (deniedPermissions.length > 0) {
    await db.insert(userPermissionOverridesTable).values(
      deniedPermissions.map((permission) => ({
        userId: user.id,
        permission,
        effect: "deny",
      })),
    );
  }

  const agent = request.agent(app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username, password: PASSWORD });
  expect(login.status).toBe(200);
  return { agent, userId: user.id, username };
}

async function loginActor(username: string): Promise<SuperAgentTest> {
  const agent = request.agent(app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username, password: PASSWORD });
  expect(login.status).toBe(200);
  return agent;
}

function expectPermissionDenied(
  response: request.Response,
  requiredPermission: string,
): void {
  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({
    error: "Forbidden",
    requiredPermission,
  });
}

beforeAll(async () => {
  await db.delete(userSessionsTable);
  await db.delete(auditLogTable);
  await db.delete(deviceCredentialsTable);
  await db.delete(customersTable);

  const [customer] = await db
    .insert(customersTable)
    .values({ companyName: "Vault authorization test customer" })
    .returning();
  customerId = customer.id;

  const [credential] = await db
    .insert(deviceCredentialsTable)
    .values({
      customerId,
      type: "test-device",
      username: "vault-user",
      password: "vault-canary-secret",
    })
    .returning();
  credentialId = credential.id;

  cannotView = await createActor("vault-deny-view", ["credentials.view"]);
  cannotManage = await createActor("vault-deny-manage", ["credentials.manage"]);
  cannotAccessCustomer = await createActor("vault-deny-customer", [
    "customers.view",
    "customers.manage",
  ]);
  fullAccess = await createActor("vault-full-access", []);
});

afterAll(async () => {
  const actorIds = [
    cannotView.userId,
    cannotManage.userId,
    cannotAccessCustomer.userId,
    fullAccess.userId,
  ];
  await db.delete(userSessionsTable);
  await db.delete(auditLogTable);
  await db.delete(deviceCredentialsTable);
  await db.delete(customersTable);
  await db
    .delete(userPermissionOverridesTable)
    .where(inArray(userPermissionOverridesTable.userId, actorIds));
  await db.delete(usersTable).where(inArray(usersTable.id, actorIds));
  await pool.end();
});

describe("credential vault permission composition", () => {
  it("fails closed on every vault path until password step-up succeeds for this session", async () => {
    const blocked = await Promise.all([
      fullAccess.agent.get(`/api/customers/${customerId}/device-credentials`),
      fullAccess.agent
        .post(`/api/customers/${customerId}/device-credentials`)
        .send({ type: "blocked-create" }),
      fullAccess.agent
        .patch(`/api/device-credentials/${credentialId}`)
        .send({ note: "blocked-update" }),
      fullAccess.agent.delete(`/api/device-credentials/${credentialId}`),
      fullAccess.agent.post(`/api/customers/${customerId}/device-credentials/audit-export`),
      fullAccess.agent
        .post(`/api/device-credentials/${credentialId}/audit-access`)
        .send({ action: "view", field: "password" }),
      fullAccess.agent
        .post(`/api/customers/${customerId}/send-credentials-email`)
        .send({}),
    ]);

    for (const response of blocked) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "biometric_required" });
    }

    const wrongPassword = await fullAccess.agent
      .post("/api/auth/vault/verify-password")
      .send({ password: "wrong-password" });
    expect(wrongPassword.status).toBe(401);
    expect(
      (await fullAccess.agent.get(`/api/customers/${customerId}/device-credentials`)).status,
    ).toBe(403);

    const verified = await fullAccess.agent
      .post("/api/auth/vault/verify-password")
      .send({ password: PASSWORD });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ verified: true, method: "password" });

    const listed = await fullAccess.agent.get(
      `/api/customers/${customerId}/device-credentials`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ id: credentialId, password: "vault-canary-secret" }),
    ]);

    const [audit] = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.entityType, "vault-step-up"));
    expect(audit).toMatchObject({ actorUserId: fullAccess.userId, action: "security" });

    const separateSession = await loginActor(fullAccess.username);
    const separateRequest = await separateSession.get(
      `/api/customers/${customerId}/device-credentials`,
    );
    expect(separateRequest.status).toBe(403);
    expect(separateRequest.body).toMatchObject({ code: "biometric_required" });
  });

  it("applies credentials.view deny to every plaintext read and distribution path", async () => {
    const responses = await Promise.all([
      cannotView.agent.get(`/api/customers/${customerId}/device-credentials`),
      cannotView.agent.post(`/api/customers/${customerId}/device-credentials/audit-export`),
      cannotView.agent
        .post(`/api/device-credentials/${credentialId}/audit-access`)
        .send({ action: "view", field: "password" }),
      cannotView.agent
        .post(`/api/customers/${customerId}/send-credentials-email`)
        .send({}),
    ]);

    for (const response of responses) {
      expectPermissionDenied(response, "credentials.view");
    }
  });

  it("allows viewing but blocks every vault mutation when credentials.manage is denied", async () => {
    const verified = await cannotManage.agent
      .post("/api/auth/vault/verify-password")
      .send({ password: PASSWORD });
    expect(verified.status).toBe(200);

    const listed = await cannotManage.agent.get(
      `/api/customers/${customerId}/device-credentials`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        id: credentialId,
        username: "vault-user",
        password: "vault-canary-secret",
      }),
    ]);

    const responses = await Promise.all([
      cannotManage.agent
        .post(`/api/customers/${customerId}/device-credentials`)
        .send({ type: "blocked-create" }),
      cannotManage.agent
        .patch(`/api/device-credentials/${credentialId}`)
        .send({ note: "blocked-update" }),
      cannotManage.agent.delete(`/api/device-credentials/${credentialId}`),
    ]);

    for (const response of responses) {
      expectPermissionDenied(response, "credentials.manage");
    }
  });

  it("requires customer access in addition to credentials permissions", async () => {
    const view = await cannotAccessCustomer.agent.get(
      `/api/customers/${customerId}/device-credentials`,
    );
    expectPermissionDenied(view, "customers.view");

    const create = await cannotAccessCustomer.agent
      .post(`/api/customers/${customerId}/device-credentials`)
      .send({ type: "blocked-customer-create" });
    expectPermissionDenied(create, "customers.view");
  });
});

describe("internal API boundary integration", () => {
  it("keeps unknown and wrong-method internal routes behind session auth", async () => {
    const unknown = await request(app).post("/api/internal/future-admin-action");
    expect(unknown.status).toBe(401);

    const wrongMethod = await request(app).get("/api/internal/backup-trigger");
    expect(wrongMethod.status).toBe(401);
  });

  it("reaches the exact public backup trigger but rejects a wrong bearer token", async () => {
    const response = await request(app)
      .post("/api/internal/backup-trigger")
      .set("Authorization", "Bearer wrong-isolated-secret");
    expect(response.status).toBe(401);
  });
});
