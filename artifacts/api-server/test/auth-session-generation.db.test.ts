import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, inArray, or, sql } from "drizzle-orm";
import {
  auditLogTable,
  db,
  pool,
  usersTable,
  userSessionsTable,
} from "@workspace/db";
import app from "../src/app";
import { collectOperationalSnapshot } from "../src/lib/operational-signals";
import { bindAuthenticatedAgent } from "./scoped-test-agent";

if (process.env.AUTH_DB_TEST_ENABLED !== "true") {
  throw new Error("Refusing to run auth DB tests without AUTH_DB_TEST_ENABLED=true.");
}

const PASSWORD = "Initial-Test-Password-42";
const NEXT_PASSWORD = "Changed-Test-Password-84";

function sessionIdFrom(response: { headers: Record<string, unknown> }): string {
  const rawHeader = response.headers["set-cookie"];
  const cookies = Array.isArray(rawHeader) ? rawHeader : [String(rawHeader ?? "")];
  const cookie = cookies.find((value) => value.startsWith("stavba.sid="));
  if (!cookie) throw new Error("Expected stavba.sid response cookie.");
  const value = decodeURIComponent(cookie.split(";", 1)[0].slice("stavba.sid=".length));
  if (!value.startsWith("s:")) throw new Error("Expected a signed session cookie.");
  return value.slice(2).split(".", 1)[0];
}

async function createUser(username: string, role: "guest" | "master" | "admin" = "guest") {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const [user] = await db
    .insert(usersTable)
    .values({ username, passwordHash, name: username, role, isActive: true })
    .returning();
  return user;
}

async function login(username: string) {
  const agent = request.agent(app);
  const response = await agent.post("/api/auth/login").send({ username, password: PASSWORD });
  expect(response.status).toBe(200);
  await bindAuthenticatedAgent(agent);
  return { agent, response, sid: sessionIdFrom(response) };
}

async function sessionsForUser(userId: number) {
  return db
    .select()
    .from(userSessionsTable)
    .where(
      or(
        eq(userSessionsTable.userId, userId),
        sql`${userSessionsTable.sess}->>'userId' = ${String(userId)}`,
      ),
    );
}

async function waitForAuditAction(action: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await db
      .select({ id: auditLogTable.id })
      .from(auditLogTable)
      .where(eq(auditLogTable.action, action));
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for audit action ${action}`);
}

beforeEach(async () => {
  await db.delete(userSessionsTable);
  await db.delete(auditLogTable);
  await db.delete(usersTable);
});

afterAll(async () => {
  await pool.end();
});

describe("isolated account and session lifecycle", () => {
  it("counts exact legacy security actions without accepting arbitrary prefixes", async () => {
    await db.insert(auditLogTable).values([
      {
        action: "security",
        entityType: "legacy_event",
        summary: "legacy vault event",
        method: "POST",
        path: "/unrelated",
      },
      {
        action: "security_admin_password_reset",
        entityType: "legacy_event",
        summary: "legacy password reset",
        method: "PATCH",
        path: "/unrelated",
      },
      {
        action: "security.attacker_controlled",
        entityType: "legacy_event",
        summary: "must not match by prefix",
        method: "POST",
        path: "/unrelated",
      },
      {
        action: "security.auth.password.login.succeeded",
        entityType: "security_event",
        summary: "ordinary success",
        method: "POST",
        path: "/auth/login",
      },
    ]);

    const snapshot = await collectOperationalSnapshot({ now: new Date() });
    expect(snapshot.metrics.security).toMatchObject({
      available: true,
      sensitiveEventCount: 2,
    });
  });

  it("serializes concurrent first-admin setup", async () => {
    const [first, second] = await Promise.all([
      request(app).post("/api/auth/setup").send({
        username: "first-admin",
        password: PASSWORD,
        name: "First Admin",
      }),
      request(app).post("/api/auth/setup").send({
        username: "second-admin",
        password: PASSWORD,
        name: "Second Admin",
      }),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const users = await db.select().from(usersTable);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ role: "admin", sessionGeneration: 1 });
    const setupEvents = await db
      .select({ action: auditLogTable.action })
      .from(auditLogTable)
      .where(
        inArray(auditLogTable.action, [
          "security.auth.setup.succeeded",
          "security.auth.setup.denied",
        ]),
      );
    expect(setupEvents.map((event) => event.action).sort()).toEqual([
      "security.auth.setup.denied",
      "security.auth.setup.succeeded",
    ]);
  });

  it("rotates the pre-authentication cookie and stores the current generation", async () => {
    const user = await createUser("cookie-user");
    const agent = request.agent(app);

    const begin = await agent
      .post("/api/auth/webauthn/login/begin")
      .send({ username: user.username });
    expect(begin.status).toBe(200);
    const anonymousSid = sessionIdFrom(begin);

    const authenticated = await agent
      .post("/api/auth/login")
      .send({ username: user.username, password: PASSWORD });
    expect(authenticated.status).toBe(200);
    const authenticatedSid = sessionIdFrom(authenticated);

    expect(authenticatedSid).not.toBe(anonymousSid);
    expect(await db.select().from(userSessionsTable).where(eq(userSessionsTable.sid, anonymousSid))).toHaveLength(0);
    const [stored] = await db
      .select({ sess: userSessionsTable.sess })
      .from(userSessionsTable)
      .where(eq(userSessionsTable.sid, authenticatedSid));
    expect(stored?.sess).toMatchObject({ userId: user.id, sessionGeneration: 1 });
  });

  it("rejects a stale session resurrected after password revocation", async () => {
    const admin = await createUser("revocation-admin", "admin");
    const target = await createUser("revocation-target");
    const adminLogin = await login(admin.username);
    const first = await login(target.username);
    const second = await login(target.username);

    const [staleRow] = await db
      .select()
      .from(userSessionsTable)
      .where(eq(userSessionsTable.sid, first.sid));
    expect(staleRow).toBeDefined();

    const changed = await adminLogin.agent
      .patch(`/api/users/${target.id}`)
      .send({ password: NEXT_PASSWORD });
    expect(changed.status).toBe(200);

    const [updatedUser] = await db
      .select({ sessionGeneration: usersTable.sessionGeneration })
      .from(usersTable)
      .where(eq(usersTable.id, target.id));
    expect(updatedUser.sessionGeneration).toBe(2);
    expect(await sessionsForUser(target.id)).toHaveLength(0);

    await db.insert(userSessionsTable).values(staleRow);

    const staleRequest = await first.agent.get("/api/auth/me");
    expect(staleRequest.status).toBe(200);
    expect(staleRequest.body).toMatchObject({ authenticated: false });
    expect(await db.select().from(userSessionsTable).where(eq(userSessionsTable.sid, first.sid))).toHaveLength(0);

    const removedRequest = await second.agent.get("/api/auth/me");
    expect(removedRequest.body).toMatchObject({ authenticated: false });

    expect((await request(app).post("/api/auth/login").send({ username: target.username, password: PASSWORD })).status).toBe(401);
    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ username: target.username, password: NEXT_PASSWORD });
    expect(newLogin.status).toBe(200);
    const [freshSession] = await db
      .select({ sess: userSessionsTable.sess })
      .from(userSessionsTable)
      .where(eq(userSessionsTable.sid, sessionIdFrom(newLogin)));
    expect(freshSession.sess).toMatchObject({ sessionGeneration: 2 });
  });

  it("keeps only the caller when revoking its other sessions", async () => {
    const admin = await createUser("self-revoke-admin", "admin");
    const current = await login(admin.username);
    const other = await login(admin.username);

    const revoked = await current.agent.delete(`/api/users/${admin.id}/sessions`);
    expect(revoked.status).toBe(204);

    const [updatedUser] = await db
      .select({ sessionGeneration: usersTable.sessionGeneration })
      .from(usersTable)
      .where(eq(usersTable.id, admin.id));
    expect(updatedUser.sessionGeneration).toBe(2);

    const remaining = await sessionsForUser(admin.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sid).toBe(current.sid);
    expect(remaining[0].sess).toMatchObject({ sessionGeneration: 2 });

    expect((await current.agent.get("/api/auth/me")).body).toMatchObject({ authenticated: true });
    expect((await other.agent.get("/api/auth/me")).body).toMatchObject({ authenticated: false });
  });

  it("records stable redacted password login and logout security events", async () => {
    const user = await createUser("security-audit-user");
    const wrongPassword = "Definitely-Wrong-Password-Do-Not-Store";

    const denied = await request(app)
      .post("/api/auth/login")
      .send({ username: user.username, password: wrongPassword });
    expect(denied.status).toBe(401);

    const authenticated = await login(user.username);
    expect((await authenticated.agent.post("/api/auth/logout")).status).toBe(204);

    const actions = [
      "security.auth.password.login.denied",
      "security.auth.password.login.succeeded",
      "security.auth.logout.succeeded",
    ];
    const events = await db
      .select()
      .from(auditLogTable)
      .where(inArray(auditLogTable.action, actions));

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.action).sort()).toEqual([...actions].sort());
    expect(events.every((event) => event.actorName === null)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(user.username);
    expect(JSON.stringify(events)).not.toContain(wrongPassword);
  });

  it("records one redacted vault success and denial without the legacy PII event", async () => {
    const user = await createUser("vault-audit-user");
    const authenticated = await login(user.username);

    expect(
      (
        await authenticated.agent
          .post("/api/auth/vault/verify-password")
          .send({ password: "wrong-vault-password" })
      ).status,
    ).toBe(401);
    expect(
      (
        await authenticated.agent
          .post("/api/auth/vault/verify-password")
          .send({ password: PASSWORD })
      ).status,
    ).toBe(200);

    const events = await db
      .select()
      .from(auditLogTable)
      .where(
        inArray(auditLogTable.action, [
          "security.auth.vault.password.denied",
          "security.auth.vault.password.succeeded",
          "security",
        ]),
      );
    expect(events.map((event) => event.action).sort()).toEqual([
      "security.auth.vault.password.denied",
      "security.auth.vault.password.succeeded",
    ]);
    expect(events.every((event) => event.actorName === null)).toBe(true);
  });

  it("audits a WebAuthn denial after response finish and skips protected anonymous completes", async () => {
    const denied = await request(app)
      .post("/api/auth/webauthn/login/complete")
      .send({});
    expect(denied.status).toBe(400);
    await waitForAuditAction("security.auth.webauthn.login.denied");

    expect(
      (await request(app).post("/api/auth/webauthn/register/complete").send({})).status,
    ).toBe(401);
    expect(
      (await request(app).post("/api/auth/webauthn/verify/complete").send({})).status,
    ).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const events = await db
      .select({ action: auditLogTable.action })
      .from(auditLogTable)
      .where(
        inArray(auditLogTable.action, [
          "security.auth.webauthn.login.denied",
          "security.auth.webauthn.registration.denied",
          "security.auth.webauthn.verify.denied",
        ]),
      );
    expect(events).toEqual([
      { action: "security.auth.webauthn.login.denied" },
    ]);
  });

  it("deduplicates repeated protected WebAuthn denials per user and source", async () => {
    const user = await createUser("webauthn-denial-dedupe-user");
    const authenticated = await login(user.username);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        (await authenticated.agent.post("/api/auth/webauthn/register/complete").send({})).status,
      ).toBe(400);
      expect(
        (await authenticated.agent.post("/api/auth/webauthn/verify/complete").send({})).status,
      ).toBe(400);
    }
    await waitForAuditAction("security.auth.webauthn.registration.denied");
    await waitForAuditAction("security.auth.webauthn.verify.denied");

    const events = await db
      .select({ action: auditLogTable.action })
      .from(auditLogTable)
      .where(
        inArray(auditLogTable.action, [
          "security.auth.webauthn.registration.denied",
          "security.auth.webauthn.verify.denied",
        ]),
      );
    expect(events.map((event) => event.action).sort()).toEqual([
      "security.auth.webauthn.registration.denied",
      "security.auth.webauthn.verify.denied",
    ]);
  });

  it("deduplicates repeated rate-limit rejections into one durable event", async () => {
    const source = "198.51.100.77";
    let responseStatus = 0;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", source)
        .send({ username: "rate-limit-missing-user", password: "invalid-password" });
      responseStatus = response.status;
    }
    expect(responseStatus).toBe(429);

    const events = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.action, "security.auth.rate_limit.exceeded"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorName: null,
      entityType: "security_event",
      summary: "outcome=rate_limited;reason=limit_exceeded",
    });
    expect(JSON.stringify(events)).not.toContain(source);
  });
});
