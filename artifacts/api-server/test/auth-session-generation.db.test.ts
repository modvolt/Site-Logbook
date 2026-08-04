import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, or, sql } from "drizzle-orm";
import {
  auditLogTable,
  db,
  pool,
  usersTable,
  userSessionsTable,
} from "@workspace/db";
import app from "../src/app";
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

beforeEach(async () => {
  await db.delete(userSessionsTable);
  await db.delete(auditLogTable);
  await db.delete(usersTable);
});

afterAll(async () => {
  await pool.end();
});

describe("isolated account and session lifecycle", () => {
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
});
