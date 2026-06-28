import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { db, usersTable, webauthnCredentialsTable } from "@workspace/db";
import app from "../src/app";
// vi.mock is hoisted by vitest so this import receives the mocked module.
import { verifyAuthenticationResponse } from "@simplewebauthn/server";

/**
 * WebAuthn login/begin → login/complete flow tests.
 *
 * Covers:
 *  1. Username-scoped flow  — login/begin with username, login/complete resolves
 *     user via username + credential ownership check.
 *  2. Discoverable flow     — login/begin with no username, login/complete
 *     resolves user via credential id alone.
 *  3. Invalid credential ID — both branches must return 401 when the credential
 *     is not found in the database.
 *
 * Real WebAuthn cryptography is intentionally not exercised here — the browser
 * authenticator and the CBOR-encoded attestation cannot be reproduced in a Node
 * test environment.  Instead we:
 *  - Insert a fake credential row directly into the DB.
 *  - Mock `verifyAuthenticationResponse` from @simplewebauthn/server so we can
 *    control the verification outcome.
 *  - Use supertest session agents so the session cookie (which carries the
 *    challenge) is preserved across begin → complete requests.
 */

// ── Mock @simplewebauthn/server ───────────────────────────────────────────────
// vi.mock is hoisted to run before all imports, so the import above gets the
// mocked version.
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(),
  };
});

const mockVerify = vi.mocked(verifyAuthenticationResponse);

// ── Test data ─────────────────────────────────────────────────────────────────
const TAG = `test-wa-login-${Date.now()}`;
const PASSWORD = "test-wa-pw-123";

const CRED_ID = `cred-${TAG}`;
const FAKE_PUBLIC_KEY = Buffer.from("fake-public-key-bytes-for-testing").toString("base64");

let userId: number;
let credDbId: number;

const createdUserIds: number[] = [];

// ── Setup & teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-user`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: `WebAuthn Test User ${TAG}`,
      role: "worker",
      isActive: true,
    })
    .returning();
  userId = user.id;
  createdUserIds.push(userId);

  const [cred] = await db
    .insert(webauthnCredentialsTable)
    .values({
      userId,
      credentialId: CRED_ID,
      publicKey: FAKE_PUBLIC_KEY,
      counter: 0,
      deviceName: "Test Device",
    })
    .returning();
  credDbId = cred.id;
});

afterAll(async () => {
  vi.restoreAllMocks();
  // webauthn_credentials cascade-deletes when the user is deleted
  if (createdUserIds.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function beginWithUsername(): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/webauthn/login/begin")
    .send({ username: `${TAG}-user` });
  expect(res.status).toBe(200);
  expect(typeof res.body.challenge).toBe("string");
  return agent;
}

async function beginDiscoverable(): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/webauthn/login/begin")
    .send({});
  expect(res.status).toBe(200);
  expect(typeof res.body.challenge).toBe("string");
  return agent;
}

function mockVerifySuccess(newCounter = 1): void {
  mockVerify.mockResolvedValueOnce({
    verified: true,
    authenticationInfo: {
      newCounter,
      credentialID: CRED_ID,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      userVerified: true,
      origin: "http://localhost",
      rpID: "localhost",
    },
  } as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
}

// ── login/begin ───────────────────────────────────────────────────────────────

describe("POST /api/auth/webauthn/login/begin", () => {
  it("username-scoped: returns 200 with challenge and allowCredentials for the user", async () => {
    const res = await request(app)
      .post("/api/auth/webauthn/login/begin")
      .send({ username: `${TAG}-user` });

    expect(res.status).toBe(200);
    expect(typeof res.body.challenge).toBe("string");
    expect(res.body.challenge.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.allowCredentials)).toBe(true);
    expect(res.body.allowCredentials.length).toBeGreaterThanOrEqual(1);
  });

  it("username-scoped: unknown username returns 200 with empty allowCredentials (no user enumeration)", async () => {
    const res = await request(app)
      .post("/api/auth/webauthn/login/begin")
      .send({ username: "__nobody__" });

    expect(res.status).toBe(200);
    expect(typeof res.body.challenge).toBe("string");
    expect(Array.isArray(res.body.allowCredentials)).toBe(true);
    expect(res.body.allowCredentials.length).toBe(0);
  });

  it("discoverable: returns 200 with challenge when no username supplied", async () => {
    const res = await request(app)
      .post("/api/auth/webauthn/login/begin")
      .send({});

    expect(res.status).toBe(200);
    expect(typeof res.body.challenge).toBe("string");
    expect(Array.isArray(res.body.allowCredentials)).toBe(true);
  });

  it("discoverable: whitespace-only username is treated as discoverable flow", async () => {
    const res = await request(app)
      .post("/api/auth/webauthn/login/begin")
      .send({ username: "   " });

    expect(res.status).toBe(200);
    expect(typeof res.body.challenge).toBe("string");
  });
});

// ── login/complete: missing / bad request guards ──────────────────────────────

describe("POST /api/auth/webauthn/login/complete — missing challenge guard", () => {
  it("returns 400 when called without a prior login/begin (no challenge in session)", async () => {
    const res = await request(app)
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/challenge/i);
  });

  it("returns 400 when response body is missing", async () => {
    const agent = await beginWithUsername();
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({});

    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });
});

// ── login/complete: username-scoped flow ──────────────────────────────────────

describe("POST /api/auth/webauthn/login/complete — username-scoped flow", () => {
  it("returns 401 when credential id is not registered for the user", async () => {
    const agent = await beginWithUsername();
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: "__nonexistent-cred__" } });

    expect(res.status).toBe(401);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 401 when credential belongs to a different user", async () => {
    const [other] = await db
      .insert(usersTable)
      .values({
        username: `${TAG}-other`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        name: `Other User ${TAG}`,
        role: "worker",
        isActive: true,
      })
      .returning();
    createdUserIds.push(other.id);

    // Begin as the other user (no credentials registered for them)
    const agent = request.agent(app);
    const beginRes = await agent
      .post("/api/auth/webauthn/login/begin")
      .send({ username: `${TAG}-other` });
    expect(beginRes.status).toBe(200);

    // Try the first user's credential — must be rejected
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });

    expect(res.status).toBe(401);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 401 when verifyAuthenticationResponse returns verified: false", async () => {
    mockVerify.mockResolvedValueOnce({
      verified: false,
      authenticationInfo: undefined,
    } as unknown as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);

    const agent = await beginWithUsername();
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });

    expect(res.status).toBe(401);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 401 when verifyAuthenticationResponse throws (bad signature)", async () => {
    mockVerify.mockRejectedValueOnce(new Error("Invalid signature"));

    const agent = await beginWithUsername();
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });

    expect(res.status).toBe(401);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 200 and user payload when verification succeeds", async () => {
    mockVerifySuccess();

    const agent = await beginWithUsername();
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe(`${TAG}-user`);
    expect(typeof res.body.role).toBe("string");
  });

  it("session is established — authenticated endpoint responds 200 after login", async () => {
    mockVerifySuccess();

    const agent = await beginWithUsername();
    const loginRes = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });
    expect(loginRes.status).toBe(200);

    // /api/auth/me returns { authenticated, needsSetup, user: { username, ... } }
    const meRes = await agent.get("/api/auth/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.user?.username).toBe(`${TAG}-user`);
  });

  it("challenge is consumed — second login/complete without new begin returns 400", async () => {
    mockVerifySuccess();

    const agent = await beginWithUsername();
    const first = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });
    expect(first.status).toBe(200);

    // No new begin — challenge was deleted after the first complete
    // Do NOT queue a mock here: verifyAuthenticationResponse is never reached
    // when the challenge is missing (the 400 guard fires first).
    const second = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/challenge/i);
  });
});

// ── login/complete: discoverable (no-username) flow ──────────────────────────

describe("POST /api/auth/webauthn/login/complete — discoverable flow", () => {
  it("returns 401 when credential id is not found in the database", async () => {
    const agent = await beginDiscoverable();
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: "__nonexistent-cred__" } });

    expect(res.status).toBe(401);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 401 when verifyAuthenticationResponse returns verified: false", async () => {
    mockVerify.mockResolvedValueOnce({
      verified: false,
      authenticationInfo: undefined,
    } as unknown as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);

    const agent = await beginDiscoverable();
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });

    expect(res.status).toBe(401);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 401 when verifyAuthenticationResponse throws (bad signature)", async () => {
    mockVerify.mockRejectedValueOnce(new Error("Invalid signature"));

    const agent = await beginDiscoverable();
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });

    expect(res.status).toBe(401);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 200 and user payload when verification succeeds", async () => {
    mockVerifySuccess();

    const agent = await beginDiscoverable();
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe(`${TAG}-user`);
    expect(typeof res.body.role).toBe("string");
  });

  it("session is established after successful discoverable login", async () => {
    mockVerifySuccess();

    const agent = await beginDiscoverable();
    const loginRes = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });
    expect(loginRes.status).toBe(200);

    // /api/auth/me returns { authenticated, needsSetup, user: { username, ... } }
    const meRes = await agent.get("/api/auth/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.user?.username).toBe(`${TAG}-user`);
  });

  it("rawId is accepted as a fallback when id field is absent in the response", async () => {
    mockVerifySuccess();

    const agent = await beginDiscoverable();
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { rawId: CRED_ID } }); // id absent, rawId present

    expect(res.status).toBe(200);
    expect(res.body.username).toBe(`${TAG}-user`);
  });
});

// ── credential counter is updated on successful login ─────────────────────────

describe("credential counter update", () => {
  it("counter is updated to the value returned by verifyAuthenticationResponse", async () => {
    await db
      .update(webauthnCredentialsTable)
      .set({ counter: 5 })
      .where(eq(webauthnCredentialsTable.id, credDbId));

    mockVerify.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: {
        newCounter: 6,
        credentialID: CRED_ID,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        userVerified: true,
        origin: "http://localhost",
        rpID: "localhost",
      },
    } as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);

    const agent = await beginWithUsername();
    const res = await agent
      .post("/api/auth/webauthn/login/complete")
      .send({ response: { id: CRED_ID } });
    expect(res.status).toBe(200);

    const [updated] = await db
      .select({ counter: webauthnCredentialsTable.counter })
      .from(webauthnCredentialsTable)
      .where(eq(webauthnCredentialsTable.id, credDbId));
    expect(updated.counter).toBe(6);
  });
});
